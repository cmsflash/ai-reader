import assert from "node:assert/strict";
import test from "node:test";
import {
  claimUrlImport,
  listShareUrlImports,
  shareImportExternalId,
  urlImportSourceHash,
} from "../src/server/articles/urlImportQueue.ts";
import {
  claimImport,
  markImportFailed,
} from "../src/server/integrations/importRecords.ts";

test("share import identities are stable per URL with an optional title fingerprint", () => {
  const url = "https://example.com/articles/reader";

  assert.equal(shareImportExternalId(url), shareImportExternalId(url));
  assert.notEqual(
    shareImportExternalId(url),
    shareImportExternalId("https://example.com/articles/other"),
  );
  assert.equal(urlImportSourceHash(url), urlImportSourceHash(url));
  assert.notEqual(
    urlImportSourceHash(url),
    urlImportSourceHash(url, "A title changes the generic API fingerprint"),
  );
});

test("a repeated share reuses its claimed background job", async () => {
  const ownerEmail = `share-claim-${crypto.randomUUID()}@example.com`;
  const url = "https://example.com/repeated-share";
  const input = {
    ownerEmail,
    provider: "android-share",
    externalId: shareImportExternalId(url),
    url,
    title: "Repeated share",
    sourceHash: urlImportSourceHash(url),
    sourceHashMustMatch: true,
  };

  const first = await claimUrlImport(input);
  const repeated = await claimUrlImport(input);

  assert.equal(typeof first.run, "function");
  assert.equal(repeated.run, null);
  assert.equal(repeated.record.externalId, first.record.externalId);
  assert.equal(repeated.record.attemptId, first.record.attemptId);
});

test("share import summaries expose pending, failed, and stalled placeholders safely", async () => {
  const ownerEmail = `share-list-${crypto.randomUUID()}@example.com`;
  const pending = await claimImport(
    {
      ownerEmail,
      provider: "android-share",
      externalId: "pending",
      sourceHash: "pending-hash",
      sourceTitle: "Pending article",
      sourceUrl: "https://example.com/pending",
    },
    { attemptId: "pending-attempt" },
  );
  const failed = await claimImport(
    {
      ownerEmail,
      provider: "ios-shortcut",
      externalId: "failed",
      sourceHash: "failed-hash",
      sourceTitle: "Failed article",
      sourceUrl: "https://example.com/failed",
      metadata: { secretInternalDetail: "not-for-the-client" },
    },
    { attemptId: "failed-attempt" },
  );
  await claimImport(
    {
      ownerEmail,
      provider: "web-share",
      externalId: "stalled",
      sourceHash: "stalled-hash",
      sourceUrl: "https://example.com/stalled",
    },
    {
      attemptId: "stalled-attempt",
      now: new Date("2020-01-01T00:00:00.000Z"),
    },
  );
  await markImportFailed(
    ownerEmail,
    "ios-shortcut",
    "failed",
    new Error("The source rejected the request."),
    failed.attemptId,
  );

  const summaries = await listShareUrlImports(ownerEmail);
  const byId = new Map(
    summaries.map((summary) => [summary.id.split(":").at(-1), summary]),
  );

  assert.ok(pending?.attemptId);
  assert.equal(byId.get("pending")?.status, "pending");
  assert.equal(byId.get("pending")?.retryable, false);
  assert.equal(byId.get("failed")?.status, "failed");
  assert.equal(byId.get("failed")?.retryable, true);
  assert.match(
    byId.get("failed")?.errorMessage ?? "",
    /source rejected/u,
  );
  assert.equal(byId.get("stalled")?.status, "pending");
  assert.equal(byId.get("stalled")?.retryable, true);
  assert.equal("metadata" in (byId.get("failed") ?? {}), false);
  assert.equal("ownerEmail" in (byId.get("failed") ?? {}), false);
  assert.equal("attemptId" in (byId.get("failed") ?? {}), false);
});
