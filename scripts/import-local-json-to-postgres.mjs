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

for (const article of store.articles) {
  await sql.query(
    `
      INSERT INTO articles (
        id,
        owner_email,
        title,
        source_type,
        source_url,
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
        blocks
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        owner_email = EXCLUDED.owner_email,
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
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
        blocks = EXCLUDED.blocks
    `,
    [
      article.id,
      ownerEmail,
      article.title,
      article.sourceType,
      article.sourceUrl ?? null,
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
    ],
  );
}

console.log(`Imported ${store.articles.length} articles from ${storePath}.`);

function ownerEmailForImport() {
  return (
    process.env.AI_READER_IMPORT_OWNER_EMAIL?.trim().toLowerCase() ||
    process.env.AI_READER_ALLOWED_EMAILS?.split(",")[0]?.trim().toLowerCase() ||
    ""
  );
}
