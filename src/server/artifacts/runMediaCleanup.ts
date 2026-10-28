import { del, list } from "@vercel/blob";
import { getDatabaseSql } from "../database.ts";
import { planMediaCleanup, releaseImageReferences, type MediaArticle, type MediaBlob, type MediaSegment } from "./mediaRetention.ts";

export async function readMediaInventory() {
  const sql = getDatabaseSql();
  const blobs: MediaBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ limit: 1000, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const articles = await sql.query("SELECT id,owner_email,blocks,narration,content_html,thumbnail_url,updated_at FROM articles") as MediaArticle[];
  const segments = await sql.query(`SELECT s.job_id,s.segment_index,s.artifact_key,s.updated_at,j.status AS job_status,j.updated_at AS job_updated_at
    FROM article_narration_job_segments s JOIN article_narration_jobs j ON j.id=s.job_id WHERE s.artifact_key IS NOT NULL`) as MediaSegment[];
  const other = await sql.query(`SELECT metadata AS reference FROM external_imports UNION ALL SELECT to_jsonb(content) FROM article_discussion_messages`);
  return { blobs, articles, segments, other };
}

export async function runMediaCleanup() {
  if (process.env.ARTIFACT_STORAGE_DRIVER !== "vercel-blob") return { deleted: 0, bytes: 0 };
  const inventory = await readMediaInventory();
  const plan = planMediaCleanup(inventory.blobs, inventory.articles, inventory.segments, inventory.other);
  // Bound each invocation. Oldest candidates are processed first; subsequent daily runs continue.
  const selected = plan.sort((a,b) => +new Date(a.uploadedAt) - +new Date(b.uploadedAt)).slice(0, 200);
  const sql = getDatabaseSql();
  let deleted = 0, bytes = 0;
  for (const blob of selected) {
    // Compare the saved blocks to avoid overwriting a concurrent article edit.
    const affected = inventory.articles.filter(a => a.blocks.some(b => b.artifactKey === blob.pathname || b.src === blob.url));
    const queries = affected.map(a => {
      const next = releaseImageReferences(a, new Set([blob.pathname]), new Map([[blob.pathname, blob.url]]));
      return sql.query(`UPDATE articles SET blocks=$3::jsonb,content_html=$4,thumbnail_url=$5,updated_at=now()
        WHERE id=$1 AND owner_email=$2 AND blocks=$6::jsonb RETURNING id`,
      [a.id,a.owner_email,JSON.stringify(next.blocks),next.content_html,next.thumbnail_url,JSON.stringify(a.blocks)]);
    });
    if (queries.length) {
      const results = await sql.transaction(queries);
      if (results.some(r => r.length !== 1)) continue;
      // Keep our in-memory snapshot current when several images belong to one article.
      for (const a of affected) Object.assign(a, releaseImageReferences(a, new Set([blob.pathname]), new Map([[blob.pathname, blob.url]])));
    }
    // Recheck all current content and non-terminal work before deleting. A failed deletion is retried next run.
    const refs = await sql.query(`SELECT 1 FROM articles WHERE strpos(blocks::text,$1)>0 OR strpos(COALESCE(narration::text,''),$1)>0
      OR strpos(content_html,$1)>0 OR strpos(COALESCE(thumbnail_url,''),$1)>0
      UNION ALL SELECT 1 FROM article_narration_job_segments s JOIN article_narration_jobs j ON j.id=s.job_id
      WHERE s.artifact_key=$1 AND j.status <> 'cancelled' LIMIT 1`, [blob.pathname]);
    if (refs.length) continue;
    await del(blob.url);
    await sql.transaction([
      sql.query(`UPDATE article_narration_jobs j SET error_message='Saved audio was removed by media cleanup. Press Play to regenerate.',updated_at=now()
        WHERE status='cancelled' AND EXISTS(SELECT 1 FROM article_narration_job_segments s WHERE s.job_id=j.id AND s.artifact_key=$1)`, [blob.pathname]),
      sql.query(`UPDATE article_narration_job_segments s SET artifact_key=NULL,byte_length=NULL,updated_at=now()
        FROM article_narration_jobs j WHERE s.job_id=j.id AND s.artifact_key=$1 AND j.status='cancelled'`, [blob.pathname]),
    ]);
    deleted++; bytes += blob.size;
  }
  return { deleted, bytes, remainingCandidates: plan.length - selected.length };
}
