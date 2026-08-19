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
  narrationPolicyFolderIdsForMembershipChange,
  scheduleNarrationPolicyForFolders,
  scheduleNarrationPolicyForFoldersBestEffort,
  scheduleNarrationPolicyForOwner,
  wakeNarrationPolicyForOwner,
  wakeNarrationPolicyForOwnerBestEffort,
} = await import(
  "../src/server/articles/narrationPolicyScheduler.ts"
);
const {
  generateNarrationPolicySegment,
  narrationJobHasUnsettledCost,
  narrationPolicyBusyRetryAt,
  narrationSegmentFailureIsRetryable,
  narrationSegmentFailureRetryMode,
  recoverableSpeechArtifact,
  replacesActiveFolderInvalidation,
} = await import(
  "../src/workflows/narrationPolicy/articleSteps.ts"
);
const {
  narrationPolicyArticleFailureAction,
  narrationPolicyBusyWaitAction,
  narrationPolicyBusyProbeDelays,
  narrationPolicyFailureRetryDelay,
  narrationPolicyMaximumJobAttemptsPerWorkflow,
  narrationPolicyMaximumBusyLeaseWaits,
  narrationPolicyMaximumPaidRetriesPerArticle,
  narrationPolicyRecoveryCooldownMs,
} = await import(
  "../src/workflows/narrationPolicy/contracts.ts"
);

test("resumes only persisted speech whose prior attempt never reached QA", () => {
  const persistedSpeech = {
    artifactKey: "articles/article-1/audio/segment.mp3",
    artifactVisibility: "public",
    contentType: "audio/mpeg",
    byteLength: 2_048,
  };

  assert.deepEqual(recoverableSpeechArtifact(persistedSpeech), persistedSpeech);
  assert.equal(
    recoverableSpeechArtifact({
      ...persistedSpeech,
      qa: { ok: false, failures: ["coverage"] },
    }),
    undefined,
  );
});

test("only ineligible jobs with incremental paid cost require cooldown parking", () => {
  assert.equal(narrationJobHasUnsettledCost(null), false);
  assert.equal(
    narrationJobHasUnsettledCost({
      actualCostUsd: 1.25,
      articleCostRecordedUsd: 1.25,
    }),
    false,
  );
  assert.equal(
    narrationJobHasUnsettledCost({
      actualCostUsd: 1.5,
      articleCostRecordedUsd: 1.25,
    }),
    true,
  );
});

test("only a newer folder invalidation waits for an active narration job", () => {
  assert.equal(replacesActiveFolderInvalidation("43", "42"), true);
  assert.equal(replacesActiveFolderInvalidation("42", "42"), false);
  assert.equal(replacesActiveFolderInvalidation("41", "42"), false);
  assert.deepEqual(narrationPolicyBusyProbeDelays, [
    "65s",
    "2m",
    "4m",
    "8m",
    "15m",
  ]);
  assert.equal(narrationPolicyMaximumBusyLeaseWaits, 3);
  assert.deepEqual(narrationPolicyBusyWaitAction(0, 0), {
    kind: "probe",
    delay: "65s",
  });
  assert.deepEqual(narrationPolicyBusyWaitAction(4, 0), {
    kind: "probe",
    delay: "15m",
  });
  assert.deepEqual(narrationPolicyBusyWaitAction(5, 0), {
    kind: "lease",
  });
  assert.deepEqual(narrationPolicyBusyWaitAction(5, 2), {
    kind: "lease",
  });
  assert.equal(narrationPolicyBusyWaitAction(5, 3), undefined);
  assert.equal(
    narrationPolicyBusyRetryAt({
      status: "running",
      leaseExpiresAt: "2026-08-20T00:00:00.000Z",
      nextAttemptAt: "2026-08-19T18:00:00.000Z",
    }),
    "2026-08-20T00:00:00.000Z",
  );
  assert.equal(
    narrationPolicyBusyRetryAt({
      status: "failed",
      nextAttemptAt: "2026-08-19T12:00:30.000Z",
    }),
    "2026-08-19T12:00:30.000Z",
  );
  assert.equal(
    narrationPolicyBusyRetryAt({
      status: "cancelled",
      nextAttemptAt: "2026-08-20T12:00:00.000Z",
    }),
    undefined,
  );
});

test("identifies only active folders affected by a membership change", () => {
  assert.deepEqual(
    narrationPolicyFolderIdsForMembershipChange(
      { folderId: "folder-a", archivedAt: null },
      { folderId: "folder-b", archivedAt: null },
    ),
    ["folder-a", "folder-b"],
  );
  assert.deepEqual(
    narrationPolicyFolderIdsForMembershipChange(
      { folderId: "folder-a" },
      { folderId: "folder-a", archivedAt: "2026-08-19T00:00:00.000Z" },
    ),
    ["folder-a"],
  );
  assert.deepEqual(
    narrationPolicyFolderIdsForMembershipChange(
      { folderId: "folder-a", archivedAt: "2026-08-19T00:00:00.000Z" },
      { folderId: "folder-b", archivedAt: "2026-08-19T00:00:00.000Z" },
    ),
    [],
  );
});

test("persists every unique folder request before starting one owner worker", async () => {
  const calls = [];
  const result = await scheduleNarrationPolicyForFolders(
    " Reader@Example.com ",
    [" folder-b ", "folder-a", "folder-b", ""],
    {
      async requestFolder(ownerEmail, folderId) {
        calls.push(["request", ownerEmail, folderId]);
      },
      async startOwner(ownerEmail) {
        calls.push(["start", ownerEmail]);
        return { runId: "wrun-folder-policy" };
      },
    },
  );

  assert.deepEqual(calls, [
    ["request", "reader@example.com", "folder-b"],
    ["request", "reader@example.com", "folder-a"],
    ["start", "reader@example.com"],
  ]);
  assert.deepEqual(result, {
    folderIds: ["folder-b", "folder-a"],
    runId: "wrun-folder-policy",
  });
});

test("does not start an owner worker when no active folder changed", async () => {
  let started = false;
  const result = await scheduleNarrationPolicyForFolders(
    "reader@example.com",
    [],
    {
      async requestFolder() {
        throw new Error("no request expected");
      },
      async startOwner() {
        started = true;
        return { runId: "unexpected" };
      },
    },
  );

  assert.equal(started, false);
  assert.deepEqual(result, { folderIds: [], runId: null });
});

test("owner reconciliation records all folders before enqueueing", async () => {
  const calls = [];
  const result = await scheduleNarrationPolicyForOwner(
    " Reader@Example.com ",
    {
      async requestOwner(ownerEmail) {
        calls.push(["request-all", ownerEmail]);
        return 5;
      },
      async startOwner(ownerEmail) {
        calls.push(["start", ownerEmail]);
        return { runId: "wrun-owner-policy" };
      },
    },
  );

  assert.deepEqual(calls, [
    ["request-all", "reader@example.com"],
    ["start", "reader@example.com"],
  ]);
  assert.deepEqual(result, { runId: "wrun-owner-policy" });
});

test("folder-list wake starts a worker only for due unclaimed work", async () => {
  let starts = 0;
  const idle = await wakeNarrationPolicyForOwner(
    " Reader@Example.com ",
    {
      async hasPendingOwner(ownerEmail) {
        assert.equal(ownerEmail, "reader@example.com");
        return false;
      },
      async startOwner() {
        starts += 1;
        return { runId: "unexpected" };
      },
    },
  );
  const pending = await wakeNarrationPolicyForOwner(
    "reader@example.com",
    {
      async hasPendingOwner() {
        return true;
      },
      async startOwner() {
        starts += 1;
        return { runId: "wrun-wake-policy" };
      },
    },
  );

  assert.deepEqual(idle, { pending: false, runId: null });
  assert.deepEqual(pending, {
    pending: true,
    runId: "wrun-wake-policy",
  });
  assert.equal(starts, 1);
});

test("folder-list wake is best effort when the policy store is unavailable", async () => {
  const reported = [];
  const result = await wakeNarrationPolicyForOwnerBestEffort(
    "reader@example.com",
    {
      async hasPendingOwner() {
        throw new Error("policy store unavailable");
      },
      reportError(error) {
        reported.push(error);
      },
    },
  );

  assert.deepEqual(result, { pending: false, runId: null });
  assert.equal(reported.length, 1);
});

test("best-effort scheduling preserves the article mutation on enqueue failure", async () => {
  const reported = [];
  const result = await scheduleNarrationPolicyForFoldersBestEffort(
    "reader@example.com",
    ["folder-a"],
    {
      async requestFolder() {
        throw new Error("workflow backend unavailable");
      },
      reportError(error) {
        reported.push(error);
      },
    },
  );

  assert.deepEqual(result, { folderIds: [], runId: null });
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /backend unavailable/u);
});

test("paid narration generation never retries automatically", () => {
  assert.equal(generateNarrationPolicySegment.maxRetries, 0);
  assert.equal(narrationPolicyMaximumPaidRetriesPerArticle, 1);
  assert.equal(narrationPolicyMaximumJobAttemptsPerWorkflow, 2);
  assert.equal(narrationPolicyFailureRetryDelay, "65s");
  assert.equal(narrationPolicyRecoveryCooldownMs, 24 * 60 * 60_000);
  assert.equal(
    narrationPolicyArticleFailureAction("transient", true),
    "retry-now",
  );
  assert.equal(
    narrationPolicyArticleFailureAction("transient", false),
    "cooldown",
  );
  assert.equal(
    narrationPolicyArticleFailureAction("terminal", true),
    "cancel",
  );
  assert.equal(
    narrationSegmentFailureIsRetryable("artifact-storage", true),
    false,
  );
  assert.equal(
    narrationSegmentFailureIsRetryable("qa-failed", false),
    true,
  );
  assert.equal(
    narrationSegmentFailureRetryMode("qa-failed", false),
    "segment",
  );
  assert.equal(
    narrationSegmentFailureRetryMode(
      "alignment-retries-exhausted",
      false,
    ),
    "job",
  );
});

function resolveSourceFile(basePath) {
  const candidates = path.extname(basePath)
    ? [basePath]
    : [`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.js`, basePath];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
