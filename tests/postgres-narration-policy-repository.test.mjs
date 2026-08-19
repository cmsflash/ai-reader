import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitStatements } from "../scripts/migrate-postgres.mjs";

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

const { PostgresNarrationPolicyRepository } = await import(
  "../src/server/adapters/postgresNarrationPolicyRepository.ts"
);

test("narration policy migration preserves trigger bodies and resumable state", async () => {
  const migration = await readFile(
    new URL("../migrations/014_narration_policy.sql", import.meta.url),
    "utf8",
  );
  const statements = splitStatements(migration);

  assert.equal(statements.length, 17);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS narration_folder_invalidations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS article_narration_jobs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS article_narration_job_segments/);
  assert.match(migration, /input_text text NOT NULL/);
  assert.match(migration, /unit_map jsonb NOT NULL/);
  assert.match(migration, /alignment jsonb/);
  assert.match(migration, /attempt_count integer NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/);
  assert.match(migration, /cycle_attempt_count integer NOT NULL DEFAULT 0\s+CHECK \(cycle_attempt_count BETWEEN 0 AND 2\)/);
  assert.match(migration, /retry_cycle integer NOT NULL DEFAULT 0 CHECK \(retry_cycle >= 0\)/);
  assert.match(migration, /failure_kind text CHECK \(failure_kind IN \('transient', 'terminal'\)\)/);
  assert.match(migration, /article_cost_recorded_usd numeric\(12, 6\) NOT NULL DEFAULT 0/);
  assert.match(migration, /article_cost_recorded_at timestamptz/);
  assert.match(
    migration,
    /FOREIGN KEY \(owner_email, article_id\)\s+REFERENCES articles \(owner_email, id\)/,
  );
  assert.match(migration, /AFTER INSERT OR DELETE OR UPDATE OF/);
  assert.ok(
    statements.some(
      (statement) =>
        statement.startsWith("CREATE OR REPLACE FUNCTION invalidate_narration_policy_for_article_change") &&
        statement.includes("PERFORM request_narration_folder_reconciliation") &&
        statement.includes("RETURN NEW;"),
    ),
  );
});

test("detects only due unleased folder reconciliation work", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [{ pending: true }];
    },
  });

  assert.equal(
    await repository.hasPendingFolderReconciliations(
      " Reader@Example.com ",
    ),
    true,
  );
  assert.deepEqual(captured.params, ["reader@example.com"]);
  assert.match(captured.statement, /requested_version > completed_version/);
  assert.match(captured.statement, /next_attempt_at <= statement_timestamp\(\)/);
  assert.match(captured.statement, /lease_expires_at IS NULL/);
  assert.match(captured.statement, /lease_expires_at <= statement_timestamp\(\)/);
});

test("claims a dirty folder with one atomic skip-locked lease", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        folderRow({
          owner_email: "reader@example.com",
          folder_id: "folder-1",
          requested_version: "42",
          claim_token: params[1],
          claimed_version: "42",
          lease_expires_at: params[3],
          attempt_count: 3,
          updated_at: params[2],
        }),
      ];
    },
  });

  const claimed = await repository.claimNextFolderReconciliation({
    ownerEmail: " Reader@Example.com ",
  });

  assert.equal(claimed?.ownerEmail, "reader@example.com");
  assert.equal(claimed?.folderId, "folder-1");
  assert.equal(claimed?.claimedVersion, "42");
  assert.match(claimed?.claimToken ?? "", /^narration-folder-/);
  assert.equal(captured.params[0], "reader@example.com");
  assert.match(captured.statement, /FOR UPDATE SKIP LOCKED/);
  assert.match(captured.statement, /requested_version > completed_version/);
});

test("selects exactly the deterministic active newest ten and classifies missing narration", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        {
          id: "article-1",
          folder_id: "folder-1",
          created_at: "2026-08-19T12:00:00.000Z",
          rank: "1",
          title: "A title",
          text_content: "A body sentence.",
          blocks: [
            { id: "p-1", type: "paragraph", text: "A body sentence." },
          ],
          narration: null,
        },
      ];
    },
  });

  const candidates = await repository.listNewestNarrationCandidates(
    " Reader@Example.com ",
    "folder-1",
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rank, 1);
  assert.equal(candidates[0].narrationState, "missing");
  assert.match(candidates[0].sourceTextSha256, /^[a-f0-9]{64}$/);
  assert.match(candidates[0].sentenceMapFingerprint, /^fnv1a32:[a-f0-9]{8}$/);
  assert.deepEqual(captured.params, ["reader@example.com", "folder-1"]);
  assert.match(captured.statement, /folder\.is_archive = false/);
  assert.match(captured.statement, /article\.archived_at IS NULL/);
  assert.match(
    captured.statement,
    /article\.created_at DESC, lower\(article\.title\) COLLATE "C" ASC, article\.id ASC LIMIT 10$/,
  );
});

test("checks one top-ten candidate without loading every narration", async () => {
  let captured;
  const article = {
    id: "article-1",
    title: "A title",
    text_content: "A body sentence.",
    blocks: [
      { id: "p-1", type: "paragraph", text: "A body sentence." },
    ],
  };
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [article];
    },
  });
  const [candidate] = await new PostgresNarrationPolicyRepository({
    async query() {
      return [{
        ...article,
        folder_id: "folder-1",
        created_at: "2026-08-19T12:00:00.000Z",
        rank: 1,
        narration: null,
      }];
    },
  }).listNewestNarrationCandidates("reader@example.com", "folder-1");

  const eligible = await repository.isNarrationCandidateEligible({
    ownerEmail: " Reader@Example.com ",
    folderId: "folder-1",
    articleId: "article-1",
    sourceTextSha256: candidate.sourceTextSha256,
    sentenceMapFingerprint: candidate.sentenceMapFingerprint,
  });

  assert.equal(eligible, true);
  assert.deepEqual(captured.params, [
    "reader@example.com",
    "folder-1",
    "article-1",
  ]);
  assert.match(captured.statement, /WITH newest AS/);
  assert.match(captured.statement, /LIMIT 10/);
  assert.match(captured.statement, /WHERE id = \$3/);
  assert.doesNotMatch(captured.statement, /narration/);
});

test("claims an eligible article job with top-ten recheck, lease, and per-cycle attempt cap", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        jobRow({
          id: params[0],
          owner_email: params[1],
          article_id: params[2],
          selection_folder_id: params[3],
          selection_folder_invalidation_version: params[17],
          source_text_sha256: params[4],
          sentence_map_fingerprint: params[5],
          generation_fingerprint: params[6],
          language: params[7],
          profile_id: params[8],
          profile_version: params[9],
          speech_model: params[10],
          voice: params[11],
          attempt_id: params[12],
          workflow_run_id: params[13],
          next_attempt_at: params[14],
          lease_expires_at: params[15],
          estimated_cost_usd: params[16],
          created_at: params[14],
          updated_at: params[14],
        }),
      ];
    },
  });

  const result = await repository.claimNarrationJob({
    ownerEmail: " Reader@Example.com ",
    articleId: "article-1",
    folderId: "folder-1",
    folderInvalidationVersion: "42",
    sourceTextSha256: "a".repeat(64),
    sentenceMapFingerprint: "b".repeat(64),
    generationFingerprint: "c".repeat(64),
    language: "en-US",
    profileId: "english-standard",
    profileVersion: "1",
    speechModel: "tts-1",
    voice: "alloy",
    estimatedCostUsd: 0.1234567,
    workflowRunId: "workflow-1",
  });

  assert.equal(result.kind, "claimed");
  assert.equal(result.job.selectionRank, 1);
  assert.equal(result.job.estimatedCostUsd, 0.123457);
  assert.equal(captured.params[1], "reader@example.com");
  assert.match(captured.statement, /WITH eligible_articles AS/);
  assert.match(captured.statement, /LIMIT 10/);
  assert.equal(result.job.selectionFolderInvalidationVersion, "42");
  assert.equal(captured.params[17], "42");
  assert.match(captured.statement, /article_narration_jobs\.cycle_attempt_count < 2/);
  assert.doesNotMatch(captured.statement, /article_narration_jobs\.attempt_count < 2/);
  assert.match(captured.statement, /article_narration_jobs\.retry_cycle \+ 1/);
  assert.match(captured.statement, /EXCLUDED\.selection_folder_invalidation_version > article_narration_jobs\.failure_folder_invalidation_version/);
  assert.match(captured.statement, /ON CONFLICT \(owner_email, article_id, generation_fingerprint\)/);
  assert.ok(
    Date.parse(captured.params[15]) - Date.parse(captured.params[14]) >=
      6 * 60 * 60_000,
  );
});

test("offers cooldown only to a newer folder invalidation after transient exhaustion", async () => {
  const queries = [];
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.startsWith("UPDATE article_narration_jobs AS job SET status = 'failed'")) {
        return [];
      }
      if (normalized.startsWith("WITH eligible_articles AS")) {
        return [];
      }
      if (normalized.startsWith("SELECT id, owner_email, article_id")) {
        return [jobRow({
          status: "failed",
          attempt_id: null,
          lease_expires_at: null,
          next_attempt_at: "2099-08-20T12:00:00.000Z",
          cycle_attempt_count: 2,
          failure_kind: "transient",
          cycle_exhausted_at: "2026-08-19T12:00:00.000Z",
          failure_folder_invalidation_version: "42",
        })];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const newer = await repository.claimNarrationJob(
    claimJobInput({ folderInvalidationVersion: "43" }),
  );
  const same = await repository.claimNarrationJob(
    claimJobInput({ folderInvalidationVersion: "42" }),
  );

  assert.equal(newer.kind, "cooldown");
  assert.equal(same.kind, "busy");
  assert.ok(queries.some(({ statement }) => (
    statement.includes("EXCLUDED.selection_folder_invalidation_version > article_narration_jobs.failure_folder_invalidation_version")
  )));
});

test("exhaustion consumes only the claimed folder version so an in-flight mutation can rearm", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [jobRow({
        status: "failed",
        attempt_id: null,
        lease_expires_at: null,
        next_attempt_at: "2026-08-20T12:00:00.000Z",
        failure_kind: "transient",
        cycle_exhausted_at: params[6],
        failure_folder_invalidation_version: "42",
        updated_at: params[6],
      })];
    },
  });

  const failed = await repository.failNarrationJob({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    attemptId: "attempt-1",
    error: "alignment provider unavailable",
    failureKind: "transient",
    cycleExhausted: true,
  });

  assert.equal(failed?.failureKind, "transient");
  assert.equal(failed?.failureFolderInvalidationVersion, "42");
  assert.equal(captured.params[5], true);
  assert.match(captured.statement, /interval '24 hours'/);
  assert.match(
    captured.statement,
    /THEN job\.selection_folder_invalidation_version/,
  );
  assert.doesNotMatch(captured.statement, /invalidation\.requested_version/);
});

test("releasing an ineligible job refunds its claim attempt", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        jobRow({
          status: "pending",
          attempt_id: null,
          lease_expires_at: null,
          attempt_count: 0,
          cycle_attempt_count: 0,
          next_attempt_at: params[4],
          updated_at: params[7],
        }),
      ];
    },
  });

  const released = await repository.releaseNarrationJob({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    attemptId: "attempt-1",
  });

  assert.equal(released?.status, "pending");
  assert.equal(released?.attemptCount, 0);
  assert.equal(released?.cycleAttemptCount, 0);
  assert.equal(captured.params[6], true);
  assert.match(
    captured.statement,
    /WHEN \$7::boolean THEN GREATEST\(attempt_count - 1, 0\)/,
  );
  assert.match(
    captured.statement,
    /OR actual_cost_usd = article_cost_recorded_usd/,
  );
});

test("atomically settles a terminal job cost into its article once", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [{
        recorded: true,
        ...jobRow({
          status: "completed",
          attempt_id: null,
          lease_expires_at: null,
          actual_cost_usd: 0.027,
          article_cost_recorded_usd: 0.027,
          article_cost_recorded_at: params[2],
          completed_at: params[2],
          updated_at: params[2],
        }),
      }];
    },
  });

  const settlement = await repository.settleNarrationJobCost(
    " Reader@Example.com ",
    "job-1",
  );

  assert.equal(settlement?.recorded, true);
  assert.equal(settlement?.job.actualCostUsd, 0.027);
  assert.equal(settlement?.job.articleCostRecordedUsd, 0.027);
  assert.equal(
    settlement?.job.articleCostRecordedAt,
    captured.params[2],
  );
  assert.deepEqual(captured.params.slice(0, 2), [
    "reader@example.com",
    "job-1",
  ]);
  assert.match(captured.statement, /WITH settlement_candidate AS/);
  assert.match(captured.statement, /FOR UPDATE/);
  assert.match(captured.statement, /UPDATE articles AS article/);
  assert.match(captured.statement, /processing_cost_usd = ROUND/);
  assert.match(captured.statement, /article_cost_recorded_at = \$3::timestamptz/);
  assert.match(captured.statement, /job\.status IN \('completed', 'cancelled'\)/);
  assert.match(captured.statement, /job\.actual_cost_usd - job\.article_cost_recorded_usd AS unsettled_cost_usd/);
  assert.match(captured.statement, /job\.article_cost_recorded_at IS NULL/);
  assert.match(captured.statement, /OR job\.actual_cost_usd > job\.article_cost_recorded_usd/);
});

test("creates an idempotent resumable segment plan with input and unit mapping", async () => {
  const queries = [];
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.startsWith("WITH plan AS")) {
        return [{ id: "job-1" }];
      }

      if (normalized.startsWith("SELECT segment.job_id")) {
        return [
          segmentRow({
            unit_map: {
              parts: [
                { sentenceIndex: 0, comparableStart: 0, comparableEnd: 2 },
              ],
              expectedComparableText: "你好",
            },
          }),
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });
  const unitMap = {
    expectedComparableText: "你好",
    parts: [{ sentenceIndex: 0, comparableStart: 0, comparableEnd: 2 }],
  };

  const segments = await repository.createNarrationSegmentPlan({
    ownerEmail: " Reader@Example.com ",
    jobId: "job-1",
    jobAttemptId: "attempt-1",
    segments: [
      {
        segmentIndex: 0,
        inputText: "你好。",
        inputSha256: "d".repeat(64),
        inputCodePoints: 3,
        unitMap,
      },
    ],
  });

  assert.equal(segments?.length, 1);
  assert.deepEqual(segments?.[0].unitMap, unitMap);
  assert.match(queries[0].statement, /jsonb_to_recordset\(\$4::jsonb\)/);
  assert.match(queries[0].statement, /input_text text/);
  assert.match(queries[0].statement, /unit_map jsonb/);
  const savedPlan = JSON.parse(queries[0].params[3]);
  assert.equal(savedPlan[0].input_text, "你好。");
  assert.deepEqual(savedPlan[0].unit_map, unitMap);
});

test("resets a failed segment's two-attempt allowance in a rearmed job cycle", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [segmentRow({
        status: "running",
        attempt_id: params[5],
        job_attempt_id: params[2],
        lease_expires_at: params[7],
        attempt_count: 3,
        cycle_attempt_count: 1,
        retry_cycle: 2,
        updated_at: params[6],
      })];
    },
  });

  const claimed = await repository.claimNarrationSegment({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    jobAttemptId: "job-attempt-3",
    segmentIndex: 0,
    inputSha256: "d".repeat(64),
  });

  assert.equal(claimed.kind, "claimed");
  assert.equal(claimed.segment.attemptCount, 3);
  assert.equal(claimed.segment.cycleAttemptCount, 1);
  assert.equal(claimed.segment.retryCycle, 2);
  assert.match(captured.statement, /WHEN segment\.retry_cycle < job\.retry_cycle THEN 1/);
  assert.match(captured.statement, /segment\.cycle_attempt_count < 2/);
  assert.doesNotMatch(captured.statement, /segment\.attempt_count < 2/);
});

test("segment completion persists alignment and charges its job exactly once", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        segmentRow({
          status: "completed",
          attempt_id: null,
          job_attempt_id: null,
          lease_expires_at: null,
          artifact_key: params[6],
          artifact_visibility: params[7],
          content_type: params[8],
          byte_length: params[9],
          duration_seconds: params[10],
          alignment_model: params[11],
          transcript_sha256: params[12],
          qa: JSON.parse(params[13]),
          alignment: JSON.parse(params[14]),
          local_sentence_cues: JSON.parse(params[15]),
          tts_cost_usd: params[16],
          alignment_cost_usd: params[17],
          diagnostic_cost_usd: params[18],
          completed_at: params[19],
          updated_at: params[19],
        }),
      ];
    },
  });

  const completed = await repository.completeNarrationSegment({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    jobAttemptId: "job-attempt-1",
    segmentIndex: 0,
    attemptId: "segment-attempt-1",
    inputSha256: "d".repeat(64),
    artifactKey: "articles/article-1/audio/segment-0.mp3",
    artifactVisibility: "public",
    contentType: "audio/mpeg",
    byteLength: 42_000,
    durationSeconds: 12.345,
    alignmentModel: "whisper-1",
    transcriptSha256: "e".repeat(64),
    qa: { ok: true },
    alignment: { sourceCoverage: 1 },
    localSentenceCues: [
      {
        sentenceIndex: 0,
        sentenceText: "你好。",
        startSeconds: 0,
        endSeconds: 12.345,
      },
    ],
    ttsCostUsd: 0.02,
    alignmentCostUsd: 0.006,
    diagnosticCostUsd: 0,
  });

  assert.equal(completed?.status, "completed");
  assert.equal(completed?.ttsCostUsd, 0.02);
  assert.deepEqual(completed?.alignment, { sourceCoverage: 1 });
  assert.match(captured.statement, /WITH completed_segment AS/);
  assert.match(captured.statement, /charged_job AS/);
  assert.match(captured.statement, /actual_cost_usd = ROUND/);
  assert.match(captured.statement, /segment\.status = 'running'/);
});

test("failed paid segments retain resumable artifact diagnostics", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      const progress = JSON.parse(params[9]);
      return [
        segmentRow({
          status: "failed",
          attempt_id: null,
          job_attempt_id: null,
          lease_expires_at: null,
          next_attempt_at: params[6],
          error_message: params[7],
          artifact_key: progress.artifactKey,
          artifact_visibility: progress.artifactVisibility,
          content_type: progress.contentType,
          byte_length: progress.byteLength,
          duration_seconds: progress.durationSeconds,
          alignment_model: progress.alignmentModel,
          transcript_sha256: progress.transcriptSha256,
          qa: progress.qa,
          alignment: progress.alignment,
          local_sentence_cues: progress.localSentenceCues,
          tts_cost_usd: progress.ttsCostUsd,
          alignment_cost_usd: progress.alignmentCostUsd,
          diagnostic_cost_usd: progress.diagnosticCostUsd,
          updated_at: params[8],
        }),
      ];
    },
  });

  const failed = await repository.failNarrationSegment({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    jobAttemptId: "job-attempt-1",
    segmentIndex: 0,
    attemptId: "segment-attempt-1",
    error: "coverage QA failed",
    progress: {
      artifactKey: "articles/article-1/audio/rejected.mp3",
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 42_000,
      durationSeconds: 12.345,
      alignmentModel: "whisper-1",
      transcriptSha256: "e".repeat(64),
      qa: { ok: false, failures: ["skipped passage"] },
      alignment: { sourceCoverage: 0.8 },
      localSentenceCues: [],
      ttsCostUsd: 0.02,
      alignmentCostUsd: 0.006,
      diagnosticCostUsd: 0.001,
    },
  });

  assert.equal(failed?.status, "failed");
  assert.equal(failed?.artifactKey, "articles/article-1/audio/rejected.mp3");
  assert.deepEqual(failed?.qa, {
    ok: false,
    failures: ["skipped passage"],
  });
  assert.equal(failed?.diagnosticCostUsd, 0.001);
  assert.match(captured.statement, /artifact_key = CASE/);
  assert.match(captured.statement, /diagnostic_cost_usd = CASE/);
});

test("a replacement speech artifact cannot inherit stale alignment or QA", async () => {
  let captured;
  const repository = new PostgresNarrationPolicyRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      const progress = JSON.parse(params[9]);
      return [segmentRow({
        status: "failed",
        attempt_id: null,
        job_attempt_id: null,
        lease_expires_at: null,
        artifact_key: progress.artifactKey,
        artifact_visibility: progress.artifactVisibility,
        content_type: progress.contentType,
        byte_length: progress.byteLength,
        duration_seconds: null,
        alignment_model: null,
        transcript_sha256: null,
        qa: null,
        alignment: null,
        local_sentence_cues: null,
        tts_cost_usd: progress.ttsCostUsd,
        next_attempt_at: params[6],
        error_message: params[7],
        updated_at: params[8],
      })];
    },
  });

  const failed = await repository.failNarrationSegment({
    ownerEmail: "reader@example.com",
    jobId: "job-1",
    jobAttemptId: "job-attempt-1",
    segmentIndex: 0,
    attemptId: "segment-attempt-2",
    error: "transcription failed before QA",
    progress: {
      artifactKey: "articles/article-1/audio/replacement.mp3",
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 43_000,
      ttsCostUsd: 0.02,
    },
  });

  assert.equal(failed?.artifactKey, "articles/article-1/audio/replacement.mp3");
  assert.equal(failed?.qa, undefined);
  assert.equal(failed?.alignment, undefined);
  assert.equal(failed?.transcriptSha256, undefined);
  const clearCount = captured.statement.match(
    /IS DISTINCT FROM segment\.artifact_key THEN NULL/g,
  )?.length ?? 0;
  assert.ok(clearCount >= 8);
});

function folderRow(overrides = {}) {
  return {
    owner_email: "reader@example.com",
    folder_id: "folder-1",
    requested_version: "1",
    completed_version: "0",
    claim_token: null,
    claimed_version: null,
    lease_expires_at: null,
    next_attempt_at: "2026-08-19T12:00:00.000Z",
    attempt_count: 0,
    last_error: null,
    updated_at: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

function jobRow(overrides = {}) {
  return {
    id: "job-1",
    owner_email: "reader@example.com",
    article_id: "article-1",
    selection_folder_id: "folder-1",
    selection_rank: 1,
    selection_folder_invalidation_version: "42",
    source_text_sha256: "a".repeat(64),
    sentence_map_fingerprint: "b".repeat(64),
    generation_fingerprint: "c".repeat(64),
    language: "en-US",
    profile_id: "english-standard",
    profile_version: "1",
    speech_model: "tts-1",
    voice: "alloy",
    status: "running",
    attempt_id: "attempt-1",
    workflow_run_id: null,
    lease_expires_at: "2026-08-19T18:00:00.000Z",
    next_attempt_at: "2026-08-19T12:00:00.000Z",
    attempt_count: 1,
    cycle_attempt_count: 1,
    retry_cycle: 0,
    failure_kind: null,
    cycle_exhausted_at: null,
    failure_folder_invalidation_version: null,
    estimated_cost_usd: 0.1,
    actual_cost_usd: 0,
    article_cost_recorded_usd: 0,
    article_cost_recorded_at: null,
    planned_segment_count: null,
    error_message: null,
    created_at: "2026-08-19T12:00:00.000Z",
    updated_at: "2026-08-19T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function segmentRow(overrides = {}) {
  return {
    job_id: "job-1",
    segment_index: 0,
    input_text: "你好。",
    input_sha256: "d".repeat(64),
    input_code_points: 3,
    unit_map: {
      expectedComparableText: "你好",
      parts: [{ sentenceIndex: 0, comparableStart: 0, comparableEnd: 2 }],
    },
    status: "pending",
    attempt_id: null,
    job_attempt_id: null,
    lease_expires_at: null,
    next_attempt_at: "2026-08-19T12:00:00.000Z",
    attempt_count: 0,
    cycle_attempt_count: 0,
    retry_cycle: 0,
    artifact_key: null,
    artifact_visibility: null,
    content_type: null,
    byte_length: null,
    duration_seconds: null,
    alignment_model: null,
    transcript_sha256: null,
    qa: null,
    alignment: null,
    local_sentence_cues: null,
    tts_cost_usd: 0,
    alignment_cost_usd: 0,
    diagnostic_cost_usd: 0,
    error_message: null,
    created_at: "2026-08-19T12:00:00.000Z",
    updated_at: "2026-08-19T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function claimJobInput(overrides = {}) {
  return {
    ownerEmail: "reader@example.com",
    articleId: "article-1",
    folderId: "folder-1",
    folderInvalidationVersion: "42",
    sourceTextSha256: "a".repeat(64),
    sentenceMapFingerprint: "b".repeat(64),
    generationFingerprint: "c".repeat(64),
    language: "en-US",
    profileId: "english-standard",
    profileVersion: "1",
    speechModel: "tts-1",
    voice: "alloy",
    ...overrides,
  };
}

function normalizeQuery(statement) {
  return statement.replace(/\s+/g, " ").trim();
}

function resolveSourceFile(basePath) {
  return [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ].find((candidate) => fs.existsSync(candidate));
}
