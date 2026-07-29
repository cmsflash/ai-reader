import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let basePath;

    if (specifier.startsWith("@/")) {
      basePath = path.join(projectRoot, "src", specifier.slice(2));
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      basePath = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
    }

    const resolvedPath = basePath && resolveSourceFile(basePath);

    if (resolvedPath) {
      return {
        url: pathToFileURL(resolvedPath).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

const {
  cleanupReplacedArticle,
  recoveredImportOutcome,
  remainingCandidateCount,
  retryPendingCleanup,
} = await import("../src/server/integrations/providerSync.ts");

test("same-provider recovery is reconciled instead of deduplicated", () => {
  const recovered = recoveredImportOutcome({
    id: "stable-provider-id",
    title: "Recovered article",
    sourceUrl: "https://example.com/recovered",
  });

  assert.equal(recovered.created, false);
  assert.equal(recovered.deduplicated, false);
  assert.equal(recovered.deduplicationReason, undefined);
  assert.equal(recovered.deduplicationSimilarity, undefined);
});

test("only resolved candidates reduce the remaining count", () => {
  assert.equal(
    remainingCandidateCount(
      8,
      2,
      1,
      1,
    ),
    4,
  );
  assert.equal(remainingCandidateCount(1, 1, 1, 1), 0);
});

test("cleanup retry isolates query and clear errors to each record", async () => {
  const records = [
    importRecord("query-error", "old-query"),
    importRecord("clear-error", "old-clear"),
    importRecord("cleaned", "old-cleaned"),
  ];
  const queried = [];
  const deleted = [];
  const cleared = [];

  await retryPendingCleanup("reader@example.com", records, {
    async hasActiveImportReference(_ownerEmail, articleId) {
      queried.push(articleId);

      if (articleId === "old-query") {
        throw new Error("temporary ledger query failure");
      }

      return false;
    },
    async deleteArticle(articleId) {
      deleted.push(articleId);
      return true;
    },
    async clearImportCleanupArticle(
      _ownerEmail,
      _provider,
      externalId,
    ) {
      cleared.push(externalId);

      if (externalId === "clear-error") {
        throw new Error("temporary marker clear failure");
      }
    },
  });

  assert.deepEqual(queried, ["old-query", "old-clear", "old-cleaned"]);
  assert.deepEqual(deleted, ["old-clear", "old-cleaned"]);
  assert.deepEqual(cleared, ["clear-error", "cleaned"]);
  assert.equal(records[0].cleanupArticleId, "old-query");
  assert.equal(records[1].cleanupArticleId, "old-clear");
  assert.equal(records[2].cleanupArticleId, undefined);
});

test("post-completion cleanup query errors are best effort", async () => {
  const record = importRecord("completed", "old-article");
  let deleteCalls = 0;
  let clearCalls = 0;

  await assert.doesNotReject(() =>
    cleanupReplacedArticle("reader@example.com", record, {
      async hasActiveImportReference() {
        throw new Error("temporary ledger query failure");
      },
      async deleteArticle() {
        deleteCalls += 1;
        return true;
      },
      async clearImportCleanupArticle() {
        clearCalls += 1;
      },
    }),
  );

  assert.equal(deleteCalls, 0);
  assert.equal(clearCalls, 0);
  assert.equal(record.cleanupArticleId, "old-article");
});

test("cleanup keeps its marker when atomic deletion detects a new reference", async () => {
  const record = importRecord("completed", "old-article");
  let clearCalls = 0;

  await cleanupReplacedArticle("reader@example.com", record, {
    async hasActiveImportReference() {
      return false;
    },
    async deleteArticle() {
      return false;
    },
    async clearImportCleanupArticle() {
      clearCalls += 1;
    },
  });

  assert.equal(clearCalls, 0);
  assert.equal(record.cleanupArticleId, "old-article");
});

function importRecord(externalId, cleanupArticleId) {
  const timestamp = "2026-07-28T12:00:00.000Z";

  return {
    ownerEmail: "reader@example.com",
    provider: "test-provider",
    externalId,
    status: "completed",
    articleId: "canonical-article",
    cleanupArticleId,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
  ];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
