import assert from "node:assert/strict";
import test from "node:test";
import {
  articleIdForImport,
  claimImport,
  clearImportCleanupArticle,
  dismissLocalImportsForArticle,
  findImportRecord,
  hasActiveImportReference,
  isImportRecordClaimable,
  markImportCompleted,
  markImportFailed,
} from "../src/server/integrations/importRecords.ts";

test("atomically claims one import attempt and rejects stale finalizers", async () => {
  const ownerEmail = `claims-${crypto.randomUUID()}@example.com`;
  const provider = "test-provider";
  const externalId = "same-item";
  const input = {
    ownerEmail,
    provider,
    externalId,
    sourceHash: "hash-1",
  };
  const [left, right] = await Promise.all([
    claimImport(input, { attemptId: "attempt-left" }),
    claimImport(input, { attemptId: "attempt-right" }),
  ]);
  const winner = left ?? right;
  const loser = left ? right : left;

  assert.ok(winner?.attemptId);
  assert.equal(loser, null);
  assert.equal(
    await markImportCompleted(
      ownerEmail,
      provider,
      externalId,
      "wrong-article",
      "not-the-winning-attempt",
    ),
    null,
  );

  const completed = await markImportCompleted(
    ownerEmail,
    provider,
    externalId,
    "article-1",
    winner.attemptId,
  );
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.articleId, "article-1");
  assert.equal(completed?.attemptId, undefined);
  assert.equal(await claimImport(input), null);
});

test("changed sources replace through a new lease while failures preserve the old article", async () => {
  const ownerEmail = `replacement-${crypto.randomUUID()}@example.com`;
  const provider = "test-provider";
  const externalId = "changed-item";
  const original = await claimImport(
    {
      ownerEmail,
      provider,
      externalId,
      sourceHash: "hash-1",
    },
    { attemptId: "attempt-1" },
  );
  assert.equal(original?.attemptId, "attempt-1");
  await markImportCompleted(
    ownerEmail,
    provider,
    externalId,
    "article-1",
    "attempt-1",
  );

  const replacement = await claimImport(
    {
      ownerEmail,
      provider,
      externalId,
      sourceHash: "hash-2",
    },
    { attemptId: "attempt-2" },
  );
  assert.equal(replacement?.articleId, "article-1");
  assert.equal(replacement?.attemptId, "attempt-2");

  const failed = await markImportFailed(
    ownerEmail,
    provider,
    externalId,
    new Error("replacement failed"),
    "attempt-2",
  );
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.articleId, "article-1");
  assert.equal(
    await hasActiveImportReference(ownerEmail, "article-1"),
    true,
  );

  const retry = await claimImport(
    {
      ownerEmail,
      provider,
      externalId,
      sourceHash: "hash-2",
    },
    { attemptId: "attempt-3" },
  );
  assert.equal(retry?.attemptId, "attempt-3");
  assert.equal(retry?.articleId, "article-1");

  const completed = await markImportCompleted(
    ownerEmail,
    provider,
    externalId,
    "article-2",
    "attempt-3",
  );
  assert.equal(completed?.cleanupArticleId, "article-1");
  assert.equal(isImportRecordClaimable(completed, "hash-3"), false);
  await clearImportCleanupArticle(
    ownerEmail,
    provider,
    externalId,
    "article-1",
  );
  assert.equal(
    isImportRecordClaimable(
      await findImportRecord(ownerEmail, provider, externalId),
      "hash-3",
    ),
    true,
  );
});

test("pending imports are reclaimable only after their lease expires", async () => {
  const record = {
    ownerEmail: "reader@example.com",
    provider: "test-provider",
    externalId: "pending-item",
    sourceHash: "hash-1",
    attemptId: "attempt-1",
    status: "pending",
    metadata: {},
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
  };

  assert.equal(
    isImportRecordClaimable(
      record,
      "hash-1",
      Date.parse("2026-07-27T10:14:59.000Z"),
    ),
    false,
  );
  assert.equal(
    isImportRecordClaimable(
      record,
      "hash-1",
      Date.parse("2026-07-27T10:15:01.000Z"),
    ),
    true,
  );
});

test("failed finalization leaves a readable record", async () => {
  const ownerEmail = `failure-${crypto.randomUUID()}@example.com`;
  const record = await claimImport(
    {
      ownerEmail,
      provider: "test-provider",
      externalId: "failed-item",
    },
    { attemptId: "attempt-failed" },
  );
  assert.equal(record?.attemptId, "attempt-failed");

  await markImportFailed(
    ownerEmail,
    "test-provider",
    "failed-item",
    new Error("expected test failure"),
    "attempt-failed",
  );
  const stored = await findImportRecord(
    ownerEmail,
    "test-provider",
    "failed-item",
  );
  assert.equal(stored?.status, "failed");
  assert.match(stored?.errorMessage ?? "", /expected test failure/);
});

test("provider article IDs are stable for retries and distinct across source versions", () => {
  const first = articleIdForImport(
    "Reader@Example.com",
    "dropbox-atvoice",
    "id:item",
    "hash-1",
  );

  assert.equal(
    first,
    articleIdForImport(
      "reader@example.com",
      "dropbox-atvoice",
      "id:item",
      "hash-1",
    ),
  );
  assert.notEqual(
    first,
    articleIdForImport(
      "reader@example.com",
      "dropbox-atvoice",
      "id:item",
      "hash-2",
    ),
  );
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("completed records without their linked article are reclaimable", () => {
  assert.equal(
    isImportRecordClaimable(
      {
        ownerEmail: "reader@example.com",
        provider: "test-provider",
        externalId: "missing-article",
        sourceHash: "hash-1",
        status: "completed",
        metadata: {},
        createdAt: "2026-07-27T10:00:00.000Z",
        updatedAt: "2026-07-27T10:00:00.000Z",
      },
      "hash-1",
    ),
    true,
  );
});

test("intentionally deleted local imports remain dismissed", async () => {
  const ownerEmail = `dismissed-${crypto.randomUUID()}@example.com`;
  const claim = await claimImport(
    {
      ownerEmail,
      provider: "test-provider",
      externalId: "dismissed-item",
      sourceHash: "hash-1",
    },
    { attemptId: "dismiss-attempt" },
  );
  assert.equal(claim?.attemptId, "dismiss-attempt");
  await markImportCompleted(
    ownerEmail,
    "test-provider",
    "dismissed-item",
    "article-to-delete",
    "dismiss-attempt",
  );

  dismissLocalImportsForArticle(ownerEmail, "article-to-delete");
  const record = await findImportRecord(
    ownerEmail,
    "test-provider",
    "dismissed-item",
  );

  assert.equal(record?.status, "dismissed");
  assert.equal(record?.articleId, undefined);
  assert.equal(isImportRecordClaimable(record, "hash-1"), false);
  assert.equal(isImportRecordClaimable(record, "hash-2"), false);
});

test("strict claims bind an idempotency key to its first source hash", async () => {
  const ownerEmail = `strict-${crypto.randomUUID()}@example.com`;
  const input = {
    ownerEmail,
    provider: "api",
    externalId: "stable-key",
    sourceHash: "request-hash-1",
  };
  const first = await claimImport(input, {
    attemptId: "strict-attempt-1",
    sourceHashMustMatch: true,
  });
  assert.equal(first?.attemptId, "strict-attempt-1");
  await markImportFailed(
    ownerEmail,
    "api",
    "stable-key",
    new Error("retry"),
    "strict-attempt-1",
  );

  assert.equal(
    await claimImport(
      { ...input, sourceHash: "request-hash-2" },
      {
        attemptId: "strict-attempt-2",
        sourceHashMustMatch: true,
      },
    ),
    null,
  );
  assert.equal(
    (
      await claimImport(input, {
        attemptId: "strict-attempt-3",
        sourceHashMustMatch: true,
      })
    )?.attemptId,
    "strict-attempt-3",
  );
});

test("shared canonical articles retain every provider provenance record", async () => {
  const ownerEmail = `provenance-${crypto.randomUUID()}@example.com`;
  const articleId = "shared-canonical-article";
  const instapaper = await claimImport(
    {
      ownerEmail,
      provider: "instapaper",
      externalId: "bookmark-1",
      sourceHash: "instapaper-hash",
      sourceTitle: "Canonical story",
      sourceUrl: "https://example.com/story",
      metadata: { folder: "unread" },
    },
    { attemptId: "instapaper-attempt" },
  );
  const dropbox = await claimImport(
    {
      ownerEmail,
      provider: "dropbox-atvoice",
      externalId: "dropbox-file-1",
      sourceHash: "dropbox-hash",
      sourceTitle: "Canonical story.mhtml",
      metadata: { path: "/Apps/@Voice/Canonical story.mhtml" },
    },
    { attemptId: "dropbox-attempt" },
  );

  await markImportCompleted(
    ownerEmail,
    "instapaper",
    "bookmark-1",
    articleId,
    instapaper.attemptId,
  );
  await markImportCompleted(
    ownerEmail,
    "dropbox-atvoice",
    "dropbox-file-1",
    articleId,
    dropbox.attemptId,
    {
      sourceUrl: "https://example.com/story",
      metadata: {
        deduplication: {
          articleId,
          reason: "exact-content",
          similarity: 1,
        },
      },
    },
  );

  const storedDropbox = await findImportRecord(
    ownerEmail,
    "dropbox-atvoice",
    "dropbox-file-1",
  );
  assert.equal(storedDropbox?.articleId, articleId);
  assert.equal(storedDropbox?.sourceUrl, "https://example.com/story");
  assert.equal(storedDropbox?.metadata.path, "/Apps/@Voice/Canonical story.mhtml");
  assert.deepEqual(storedDropbox?.metadata.deduplication, {
    articleId,
    reason: "exact-content",
    similarity: 1,
  });
  assert.equal(
    await hasActiveImportReference(ownerEmail, articleId),
    true,
  );
});
