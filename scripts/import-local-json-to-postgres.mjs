import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/env.mjs";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required. Pull or set production env vars first.");
  process.exit(1);
}

const storePath = process.argv[2] || process.env.LOCAL_ARTICLE_STORE_PATH || "data/articles.json";
const store = JSON.parse(await readFile(storePath, "utf8"));
const ownerEmail = ownerEmailForImport();

if (store.version !== 1 || !Array.isArray(store.articles)) {
  console.error(`${storePath} is not an AI Reader article store.`);
  process.exit(1);
}

if (!ownerEmail) {
  console.error("AI_READER_IMPORT_OWNER_EMAIL or AI_READER_ALLOWED_EMAILS is required for import.");
  process.exit(1);
}

const sql = neon(databaseUrl);
const folderIdMap = new Map();
const defaultFolderId = await ensureDefaultFolder(sql, ownerEmail);

for (const folder of store.folders ?? []) {
  const name = String(folder.name ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();

  if (!folder.id || !name) {
    continue;
  }

  if (name.toLocaleLowerCase() === "default") {
    folderIdMap.set(folder.id, defaultFolderId);
    continue;
  }

  const existing = await sql.query(
    `
      SELECT id
      FROM reading_folders
      WHERE owner_email = $1 AND (id = $2 OR lower(name) = lower($3))
      ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
      LIMIT 1
    `,
    [ownerEmail, folder.id, name],
  );

  if (existing[0]) {
    folderIdMap.set(folder.id, existing[0].id);
    continue;
  }

  const [savedFolder] = await sql.query(
    `
      INSERT INTO reading_folders (
        id,
        owner_email,
        name,
        slug,
        is_archive,
        sort_order,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
      ON CONFLICT (owner_email, slug) DO UPDATE SET
        name = EXCLUDED.name,
        is_archive = EXCLUDED.is_archive,
        sort_order = EXCLUDED.sort_order,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `,
    [
      folder.id,
      ownerEmail,
      name,
      importedFolderSlug(name, folder.id),
      Boolean(folder.isArchive),
      Number.isFinite(folder.sortOrder) ? folder.sortOrder : 0,
      folder.createdAt ?? new Date().toISOString(),
      folder.updatedAt ?? folder.createdAt ?? new Date().toISOString(),
    ],
  );

  if (!savedFolder) {
    throw new Error(`Could not import folder ${name}.`);
  }

  folderIdMap.set(folder.id, savedFolder.id);
}

for (const folderId of new Set(
  store.articles.map((article) => article.folderId).filter(Boolean),
)) {
  if (folderIdMap.has(folderId)) {
    continue;
  }

  const [existing] = await sql.query(
    "SELECT id FROM reading_folders WHERE owner_email = $1 AND id = $2 LIMIT 1",
    [ownerEmail, folderId],
  );

  if (existing) {
    folderIdMap.set(folderId, existing.id);
  }
}

for (const article of store.articles) {
  await sql.query(
    `
      INSERT INTO articles (
        id,
        owner_email,
        title,
        source_type,
        source_url,
        folder_id,
        archived_at,
        created_at,
        updated_at,
        word_count,
        estimated_minutes,
        sentence_count,
        processing_cost_usd,
        progress_sentence_index,
        progress_percent,
        progress_updated_at,
        content_html,
        text_content,
        blocks,
        excerpt,
        thumbnail_url,
        preview_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18, $19::jsonb, $20, $21, 2)
      ON CONFLICT (id) DO UPDATE SET
        owner_email = EXCLUDED.owner_email,
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        folder_id = EXCLUDED.folder_id,
        archived_at = EXCLUDED.archived_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        word_count = EXCLUDED.word_count,
        estimated_minutes = EXCLUDED.estimated_minutes,
        sentence_count = EXCLUDED.sentence_count,
        processing_cost_usd = EXCLUDED.processing_cost_usd,
        progress_sentence_index = EXCLUDED.progress_sentence_index,
        progress_percent = EXCLUDED.progress_percent,
        progress_updated_at = EXCLUDED.progress_updated_at,
        content_html = EXCLUDED.content_html,
        text_content = EXCLUDED.text_content,
        blocks = EXCLUDED.blocks,
        excerpt = EXCLUDED.excerpt,
        thumbnail_url = EXCLUDED.thumbnail_url,
        preview_version = EXCLUDED.preview_version
    `,
    [
      article.id,
      ownerEmail,
      article.title,
      article.sourceType,
      article.sourceUrl ?? null,
      folderIdMap.get(article.folderId) ?? defaultFolderId,
      article.archivedAt ?? null,
      article.createdAt,
      article.updatedAt,
      article.wordCount,
      article.estimatedMinutes,
      article.sentenceCount,
      article.processingCostUsd ?? 0,
      article.progress?.sentenceIndex ?? 0,
      article.progress?.percent ?? 0,
      article.progress?.updatedAt ?? article.updatedAt,
      article.contentHtml,
      article.textContent,
      JSON.stringify(article.blocks ?? []),
      article.excerpt ?? articleExcerpt(article),
      article.thumbnailUrl ?? articleThumbnailUrl(article),
    ],
  );
}

console.log(`Imported ${store.articles.length} articles from ${storePath}.`);

async function ensureDefaultFolder(sqlClient, normalizedOwnerEmail) {
  const existing = await sqlClient.query(
    `
      SELECT id
      FROM reading_folders
      WHERE
        owner_email = $1
        AND (slug = 'default' OR lower(name) = 'default')
      ORDER BY CASE WHEN slug = 'default' THEN 0 ELSE 1 END, sort_order, created_at
      LIMIT 1
    `,
    [normalizedOwnerEmail],
  );

  if (existing[0]) {
    return existing[0].id;
  }

  const id = `folder-default-${createHash("md5")
    .update(normalizedOwnerEmail)
    .digest("hex")}`;
  const now = new Date().toISOString();
  const [saved] = await sqlClient.query(
    `
      INSERT INTO reading_folders (
        id,
        owner_email,
        name,
        slug,
        is_archive,
        sort_order,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'Default', 'default', false, -1, $3::timestamptz, $3::timestamptz)
      ON CONFLICT (owner_email, slug) DO UPDATE SET
        name = 'Default',
        is_archive = false,
        sort_order = LEAST(reading_folders.sort_order, -1)
      RETURNING id
    `,
    [id, normalizedOwnerEmail, now],
  );

  if (!saved) {
    throw new Error("Could not create the Default folder.");
  }

  return saved.id;
}

function ownerEmailForImport() {
  return (
    process.env.AI_READER_IMPORT_OWNER_EMAIL?.trim().toLowerCase() ||
    process.env.AI_READER_ALLOWED_EMAILS?.split(",")[0]?.trim().toLowerCase() ||
    ""
  );
}

function folderSlug(name) {
  return (
    name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "folder"
  );
}

function importedFolderSlug(name, id) {
  const fingerprint = createHash("sha256")
    .update(`${id}:${name.normalize("NFKC").toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 12);

  return `${folderSlug(name)}-${fingerprint}`;
}

function articleExcerpt(article) {
  const candidates = (article.blocks ?? [])
    .filter((block) => ["paragraph", "quote"].includes(block.type))
    .map((block) => String(block.text ?? "").replace(/\s+/gu, " ").trim())
    .filter((text) => text && !isLikelyPreviewBoilerplate(text));
  const excerpt =
    candidates.find((text) => text.length >= 80) ??
    candidates.find((text) => text.length >= 40) ??
    candidates[0] ??
    String(article.textContent ?? "");
  const compact = excerpt.replace(/\s+/gu, " ").trim();
  return compact.length > 360 ? `${compact.slice(0, 359).trimEnd()}…` : compact;
}

function articleThumbnailUrl(article) {
  const candidates = (article.blocks ?? [])
    .filter((block) => block.type === "image" && (block.src || block.originalSrc))
    .map((block) => ({
      url: block.src || block.originalSrc,
      descriptor: `${block.alt ?? ""} ${block.src ?? ""} ${block.originalSrc ?? ""}`,
    }));
  const lowValue = /(?:^|[\s/_-])(avatar|emoji|favicon|icon|logo|profile)(?:[\s/_.-]|$)/i;
  return candidates.find((candidate) => !lowValue.test(candidate.descriptor))?.url ??
    candidates[0]?.url ??
    null;
}

function isLikelyPreviewBoilerplate(text) {
  const normalized = text.toLocaleLowerCase();

  if (
    /^(?:updated|published|posted|last updated)\s+(?:on\s+)?/u.test(normalized) ||
    /^(?:share this(?: post)?|in this (?:blog|article))$/u.test(normalized)
  ) {
    return true;
  }

  const rolePattern =
    /\b(?:student researcher|researcher|fellow|vice president|vp|chief [a-z -]+ officer|editor|writer)\b/iu;
  const looksLikeByline =
    !/[.!?][”"']?$/u.test(text) &&
    text.split(",").length >= 2 &&
    rolePattern.test(text);
  const looksLikeAuthorBio =
    /^[^.!?]{1,80}\s+(?:is|was)\s+(?:the|a|an)\s+(?:chief|vice president|vp|president|director|professor|researcher|writer|editor|founder|co-founder)\b/iu.test(
      text,
    );
  const looksLikeCredentials =
    /^[^.!?]{1,80}\s+(?:received|earned|holds?)\s+(?:his|her|their|a)\s+(?:ph\.?d|doctorate|master)/iu.test(
      text,
    );

  return looksLikeByline || looksLikeAuthorBio || looksLikeCredentials;
}
