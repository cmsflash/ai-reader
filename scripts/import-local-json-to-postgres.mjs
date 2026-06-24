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

if (store.version !== 1 || !Array.isArray(store.articles)) {
  console.error(`${storePath} is not an AI Reader article store.`);
  process.exit(1);
}

const sql = neon(databaseUrl);

for (const article of store.articles) {
  await sql.query(
    `
      INSERT INTO articles (
        id,
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
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15, $16::jsonb)
      ON CONFLICT (id) DO UPDATE SET
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
