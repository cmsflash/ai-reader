import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  backfillArticleContentFingerprints,
  fingerprintArticleContentForMigration,
  splitStatements,
} from "../scripts/migrate-postgres.mjs";

test("discussion migration is safe for the replay-only migration runner", async () => {
  const migration = await readFile(
    new URL("../migrations/011_article_discussions.sql", import.meta.url),
    "utf8",
  );
  const statements = splitStatements(migration);

  assert.equal(statements.length, 3);
  assert.ok(statements.every((statement) => statement.includes("IF NOT EXISTS")));
  assert.equal(/\b(?:DROP|TRUNCATE|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION)\b/i.test(migration), false);
  assert.match(statements[0], /articles \(owner_email, id\)/);
  assert.match(statements[1], /FOREIGN KEY \(owner_email, article_id\)/);
  assert.match(statements[2], /owner_email, article_id, sequence/);
});

test("fingerprint backfill leaves historical duplicates unindexed and is idempotent", async () => {
  const duplicateBody =
    "The same historical article body is long enough to receive a fingerprint.";
  const distinctBody =
    "A different historical article body is also long enough to be fingerprinted.";
  const alreadyVersionedBody =
    "This article already has a current versioned fingerprint and is not selected.";
  const rows = [
    row("a", duplicateBody, null),
    row("b", duplicateBody, null),
    row("c", distinctBody, "legacy-unversioned-hash"),
    row("d", "too short", "legacy-short-hash"),
    row(
      "e",
      alreadyVersionedBody,
      fingerprintArticleContentForMigration(alreadyVersionedBody),
    ),
  ];
  const sql = fakeFingerprintSql(rows);

  assert.deepEqual(
    await backfillArticleContentFingerprints(sql, { batchSize: 2 }),
    {
      scanned: 4,
      backfilled: 2,
      duplicate: 1,
      tooShort: 1,
      clearedLegacy: 1,
    },
  );
  assert.match(rows[0].content_fingerprint, /^v1:[a-f0-9]{64}$/);
  assert.equal(rows[1].content_fingerprint, null);
  assert.match(rows[2].content_fingerprint, /^v1:[a-f0-9]{64}$/);
  assert.equal(rows[3].content_fingerprint, null);

  const stateAfterFirstRun = structuredClone(rows);

  assert.deepEqual(
    await backfillArticleContentFingerprints(sql, { batchSize: 2 }),
    {
      scanned: 2,
      backfilled: 0,
      duplicate: 1,
      tooShort: 1,
      clearedLegacy: 0,
    },
  );
  assert.deepEqual(rows, stateAfterFirstRun);
});

function row(id, textContent, contentFingerprint) {
  return {
    id,
    owner_email: "reader@example.com",
    text_content: textContent,
    content_fingerprint: contentFingerprint,
  };
}

function fakeFingerprintSql(rows) {
  return {
    async query(statement, params) {
      const normalized = statement.replace(/\s+/g, " ").trim();

      if (normalized.startsWith("SELECT id, owner_email")) {
        const [afterId, batchSize, versionPattern] = params;
        const versionPrefix = versionPattern.slice(0, -1);

        return rows
          .filter(
            (candidate) =>
              candidate.id > afterId &&
              (!candidate.content_fingerprint ||
                !candidate.content_fingerprint.startsWith(versionPrefix)),
          )
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, batchSize)
          .map((candidate) => ({ ...candidate }));
      }

      if (normalized.startsWith("UPDATE articles AS target")) {
        const [id, ownerEmail, fingerprint, versionPattern] = params;
        const versionPrefix = versionPattern.slice(0, -1);
        const target = rows.find(
          (candidate) =>
            candidate.id === id && candidate.owner_email === ownerEmail,
        );

        if (
          !target ||
          target.content_fingerprint?.startsWith(versionPrefix) ||
          rows.some(
            (candidate) =>
              candidate.id !== id &&
              candidate.owner_email === ownerEmail &&
              candidate.content_fingerprint === fingerprint,
          )
        ) {
          return [];
        }

        target.content_fingerprint = fingerprint;
        return [{ id }];
      }

      if (normalized.startsWith("UPDATE articles SET content_fingerprint")) {
        const [id, ownerEmail, currentFingerprint] = params;
        const target = rows.find(
          (candidate) =>
            candidate.id === id &&
            candidate.owner_email === ownerEmail &&
            candidate.content_fingerprint === currentFingerprint,
        );

        if (!target) {
          return [];
        }

        target.content_fingerprint = null;
        return [{ id }];
      }

      throw new Error(`Unexpected test query: ${normalized}`);
    },
  };
}
