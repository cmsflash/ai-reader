import { createHash } from "node:crypto";
import { articleFromHtml, articleFromUrl } from "@/lib/extractors";
import { articleExcerpt, articleThumbnailUrl } from "@/lib/articlePreview";
import { getDatabaseSql } from "@/server/database";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { archiveArticleArtifacts } from "@/server/artifacts/archiveArticleArtifacts";
import { fetchPublicResource } from "@/server/security/publicArticleUrl";
import { withProviderSyncLock } from "@/server/integrations/providerSyncLock";
import {
  publicationEntries,
  publicationSources,
  type PublicationSource,
  type PublicationEntry,
} from "./sources";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function subscribePublication(
  owner: string,
  source: PublicationSource,
) {
  const sql = getDatabaseSql();
  return withProviderSyncLock(owner, async () => {
    const existing = await sql.query(
      "SELECT folder_id FROM publication_subscriptions WHERE owner_email=$1 AND source=$2",
      [owner, source],
    );
    if (existing[0]) return String(existing[0].folder_id);
    const folders = await sql.query(
      "SELECT id FROM reading_folders WHERE owner_email=$1 AND name=$2 ORDER BY created_at LIMIT 1",
      [owner, publicationSources[source].name],
    );
    const folder = folders[0] ?? await getArticleRepository().createFolder(
      publicationSources[source].name, owner,
    );
    await sql.query(
      "INSERT INTO publication_subscriptions(owner_email,source,folder_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [owner, source, folder.id],
    );
    return folder.id;
  });
}
export async function discoverPublication(source: PublicationSource) {
  const { response } = await fetchPublicResource(
    publicationSources[source].url,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok)
    throw new Error(`Publication index returned ${response.status}`);
  return publicationEntries(source, await response.text());
}
export async function syncPublicationEntry(
  owner: string,
  source: PublicationSource,
  entry: PublicationEntry,
) {
  const sql = getDatabaseSql();
  const subscription = await sql.query(
    "SELECT folder_id FROM publication_subscriptions WHERE owner_email=$1 AND source=$2",
    [owner, source],
  );
  if (!subscription[0]) throw new Error("Publication is not subscribed.");
  const repository = getArticleRepository();
  const tracked = await sql.query(
    "SELECT article_id,content_hash FROM publication_items WHERE owner_email=$1 AND source=$2 AND url=$3",
    [owner, source, entry.url],
  );
  // A tracked article removed by the reader stays removed.
  if (
    tracked[0] &&
    !(await repository.findById(String(tracked[0].article_id), owner))
  )
    return "deleted";
  const extracted = entry.html
    ? await articleFromHtml(entry.html, {
        title: entry.title,
        sourceUrl: entry.url,
      })
    : await articleFromUrl(entry.url);
  extracted.title = entry.title;
  extracted.sourceUrl = entry.url;
  const hash = digest(JSON.stringify([extracted.title, extracted.contentHtml]));
  if (tracked[0]?.content_hash === hash) return "unchanged";
  return withProviderSyncLock(owner, async () => {
    const current = await sql.query(
      "SELECT article_id,content_hash FROM publication_items WHERE owner_email=$1 AND source=$2 AND url=$3",
      [owner, source, entry.url],
    );
    if (current[0]?.content_hash === hash) return "unchanged";
    if (current[0]) {
      const articleId = String(current[0].article_id);
      const previous = await repository.findById(articleId, owner);
      if (!previous) return "deleted";
      // Keep organization and progress columns untouched. Existing audio no longer
      // matches revised text, so invalidate it only when the text actually changes.
      extracted.id = articleId;
      const article = await archiveArticleArtifacts(extracted);
      await sql.transaction([
        sql.query(
          `UPDATE articles SET title=$3,content_html=$4,text_content=$5,blocks=$6::jsonb,
          word_count=$7,estimated_minutes=$8,sentence_count=$9,excerpt=$10,thumbnail_url=$11,
          progress_sentence_index=LEAST(progress_sentence_index,GREATEST($9-1,0)),
          narration=CASE WHEN text_content=$5 THEN narration ELSE NULL END,
          content_fingerprint=NULL, updated_at=now() WHERE id=$1 AND owner_email=$2`,
          [
            articleId,
            owner,
            article.title,
            article.contentHtml,
            article.textContent,
            JSON.stringify(article.blocks),
            article.wordCount,
            article.estimatedMinutes,
            article.sentenceCount,
            articleExcerpt(article),
            articleThumbnailUrl(article) ?? null,
          ],
        ),
        sql.query(
          "UPDATE publication_items SET content_hash=$4,checked_at=now() WHERE owner_email=$1 AND source=$2 AND url=$3",
          [owner, source, entry.url, hash],
        ),
      ]);
      return "updated";
    }
    extracted.id = `publication-${digest(`${owner}:${source}:${entry.url}`).slice(0, 32)}`;
    extracted.folderId = String(subscription[0].folder_id);
    if (entry.publishedAt && Number.isFinite(Date.parse(entry.publishedAt)))
      extracted.createdAt = new Date(entry.publishedAt).toISOString();
    const article = await archiveArticleArtifacts(extracted);
    const saved = await repository.create(article, owner);
    // Exact-content deduplication can find an already-saved copy.
    if (saved.folderId !== extracted.folderId)
      await repository.updateOrganization(saved.id, owner, {
        folderId: extracted.folderId,
      });
    await sql.query(
      "INSERT INTO publication_items(owner_email,source,url,article_id,content_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [owner, source, entry.url, saved.id, hash],
    );
    return "imported";
  });
}
