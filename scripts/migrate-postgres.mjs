import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/env.mjs";

export const ARTICLE_CONTENT_FINGERPRINT_VERSION = "v1";
const MIN_EXACT_CONTENT_LENGTH = 40;
const DEFAULT_BACKFILL_BATCH_SIZE = 250;
const VERSIONED_FINGERPRINT_PATTERN =
  `${ARTICLE_CONTENT_FINGERPRINT_VERSION}:%`;

export function normalizeArticleContentForFingerprint(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function fingerprintArticleContentForMigration(text) {
  const normalizedContent = normalizeArticleContentForFingerprint(text);

  return normalizedContent.length >= MIN_EXACT_CONTENT_LENGTH
    ? `${ARTICLE_CONTENT_FINGERPRINT_VERSION}:${createHash("sha256")
        .update(normalizedContent)
        .digest("hex")}`
    : undefined;
}

export async function backfillArticleContentFingerprints(
  sql,
  { batchSize = DEFAULT_BACKFILL_BATCH_SIZE } = {},
) {
  let afterId = "";
  let scanned = 0;
  let backfilled = 0;
  let duplicate = 0;
  let tooShort = 0;
  let clearedLegacy = 0;

  while (true) {
    const rows = await sql.query(
      `
        SELECT id, owner_email, text_content, content_fingerprint
        FROM articles
        WHERE id > $1
          AND (
            content_fingerprint IS NULL
            OR content_fingerprint NOT LIKE $3
          )
        ORDER BY id
        LIMIT $2
      `,
      [afterId, batchSize, VERSIONED_FINGERPRINT_PATTERN],
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      afterId = row.id;
      scanned += 1;
      const fingerprint = fingerprintArticleContentForMigration(
        row.text_content,
      );

      if (!fingerprint) {
        tooShort += 1;

        if (row.content_fingerprint) {
          const cleared = await clearLegacyFingerprint(sql, row);
          clearedLegacy += cleared;
        }

        continue;
      }

      try {
        const updated = await sql.query(
          `
            UPDATE articles AS target
            SET content_fingerprint = $3
            WHERE target.id = $1
              AND target.owner_email = $2
              AND (
                target.content_fingerprint IS NULL
                OR target.content_fingerprint NOT LIKE $4
              )
              AND NOT EXISTS (
                SELECT 1
                FROM articles AS existing
                WHERE existing.owner_email = $2
                  AND existing.content_fingerprint = $3
                  AND existing.id <> $1
              )
            RETURNING target.id
          `,
          [
            row.id,
            row.owner_email,
            fingerprint,
            VERSIONED_FINGERPRINT_PATTERN,
          ],
        );

        if (updated.length > 0) {
          backfilled += 1;
          continue;
        }
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }

      duplicate += 1;

      if (row.content_fingerprint) {
        const cleared = await clearLegacyFingerprint(sql, row);
        clearedLegacy += cleared;
      }
    }
  }

  return {
    scanned,
    backfilled,
    duplicate,
    tooShort,
    clearedLegacy,
  };
}

export function splitStatements(sqlText) {
  return sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function clearLegacyFingerprint(sql, row) {
  const cleared = await sql.query(
    `
      UPDATE articles
      SET content_fingerprint = NULL
      WHERE id = $1
        AND owner_email = $2
        AND content_fingerprint = $3
      RETURNING id
    `,
    [row.id, row.owner_email, row.content_fingerprint],
  );

  return cleared.length;
}

function isUniqueViolation(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function main() {
  loadLocalEnv();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required. Pull or set production env vars first.",
    );
    process.exitCode = 1;
    return;
  }

  const migrationsDir = path.join(process.cwd(), "migrations");
  const sql = neon(databaseUrl);
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const migration = await readFile(path.join(migrationsDir, file), "utf8");
    process.stdout.write(`Applying ${file}... `);
    for (const statement of splitStatements(migration)) {
      await sql.query(statement);
    }
    process.stdout.write("done\n");
  }

  process.stdout.write("Backfilling article content fingerprints... ");
  const result = await backfillArticleContentFingerprints(sql);
  process.stdout.write(
    `done (${result.backfilled} updated, ${result.duplicate} historical duplicates left unindexed, ${result.tooShort} too short)\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedPath === import.meta.url) {
  await main();
}
