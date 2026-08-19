import { randomUUID } from "node:crypto";
import type { ArticleBlock, ArticleNarration } from "@/lib/types";
import { narrationSentenceMapFingerprint } from "@/lib/narrationPlayback";
import { annotateBlocks } from "@/lib/sentences";
import { narrationSourceSha256 } from "@/server/articles/articleNarrationQa";
import { getDatabaseSql } from "@/server/database";
import {
  NarrationPolicyPersistenceError,
  type ClaimNarrationJobInput,
  type ClaimNarrationJobResult,
  type ClaimNarrationSegmentResult,
  type FolderReconciliation,
  type FolderReconciliationClaim,
  type NarrationCandidateState,
  type NarrationJobStatus,
  type NarrationPolicyCandidate,
  type NarrationPolicyRepository,
  type NarrationSegmentFailureProgress,
  type NarrationSegmentPlanItem,
  type NarrationSegmentStatus,
  type StoredNarrationJob,
  type StoredNarrationSegment,
} from "@/server/ports/narrationPolicyRepository";

type QueryClient = {
  query(statement: string, params?: unknown[]): Promise<unknown[]>;
};

type FolderReconciliationRow = {
  owner_email: string;
  folder_id: string;
  requested_version: number | string;
  completed_version: number | string;
  claim_token: string | null;
  claimed_version: number | string | null;
  lease_expires_at: string | Date | null;
  next_attempt_at: string | Date;
  attempt_count: number | string;
  last_error: string | null;
  updated_at: string | Date;
};

type NarrationCandidateRow = {
  id: string;
  folder_id: string;
  created_at: string | Date;
  rank: number | string;
  title: string;
  text_content: string;
  blocks: ArticleBlock[] | string;
  narration: ArticleNarration | string | null;
};

type NarrationJobRow = {
  id: string;
  owner_email: string;
  article_id: string;
  selection_folder_id: string;
  selection_rank: number | string;
  selection_folder_invalidation_version: number | string;
  source_text_sha256: string;
  sentence_map_fingerprint: string;
  generation_fingerprint: string;
  language: string;
  profile_id: string;
  profile_version: string;
  speech_model: string;
  voice: string;
  status: NarrationJobStatus;
  attempt_id: string | null;
  workflow_run_id: string | null;
  lease_expires_at: string | Date | null;
  next_attempt_at: string | Date;
  attempt_count: number | string;
  cycle_attempt_count: number | string;
  retry_cycle: number | string;
  failure_kind: "transient" | "terminal" | null;
  cycle_exhausted_at: string | Date | null;
  failure_folder_invalidation_version: number | string | null;
  estimated_cost_usd: number | string;
  actual_cost_usd: number | string;
  article_cost_recorded_usd: number | string;
  article_cost_recorded_at: string | Date | null;
  planned_segment_count: number | string | null;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

type NarrationSegmentRow = {
  job_id: string;
  segment_index: number | string;
  input_text: string;
  input_sha256: string;
  input_code_points: number | string;
  unit_map: unknown;
  status: NarrationSegmentStatus;
  attempt_id: string | null;
  job_attempt_id: string | null;
  lease_expires_at: string | Date | null;
  next_attempt_at: string | Date;
  attempt_count: number | string;
  cycle_attempt_count: number | string;
  retry_cycle: number | string;
  artifact_key: string | null;
  artifact_visibility: "private" | "public" | null;
  content_type: string | null;
  byte_length: number | string | null;
  duration_seconds: number | string | null;
  alignment_model: string | null;
  transcript_sha256: string | null;
  qa: unknown;
  alignment: unknown;
  local_sentence_cues: unknown;
  tts_cost_usd: number | string;
  alignment_cost_usd: number | string;
  diagnostic_cost_usd: number | string;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

const defaultFolderLeaseMs = 5 * 60_000;
const defaultJobLeaseMs = 6 * 60 * 60_000;
const defaultSegmentLeaseMs = 30 * 60_000;
const minimumLeaseMs = 30_000;
const maximumLeaseMs = 24 * 60 * 60_000;

export class PostgresNarrationPolicyRepository
implements NarrationPolicyRepository {
  private readonly queryClient?: QueryClient;

  constructor(queryClient?: QueryClient) {
    this.queryClient = queryClient;
  }

  async listActiveFolderIds(ownerEmail: string) {
    const rows = await this.queryRows<{ id: string }>(
      `
        SELECT id
        FROM reading_folders
        WHERE owner_email = $1 AND is_archive = false
        ORDER BY sort_order, lower(name) COLLATE "C", name, id
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows.map(({ id }) => id);
  }

  async hasPendingFolderReconciliations(ownerEmail: string) {
    const rows = await this.queryRows<{ pending: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM narration_folder_invalidations
          WHERE
            owner_email = $1
            AND requested_version > completed_version
            AND next_attempt_at <= statement_timestamp()
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= statement_timestamp()
            )
        ) AS pending
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows[0]?.pending === true;
  }

  async requestFolderReconciliation(ownerEmail: string, folderId: string) {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const normalizedFolder = requiredText(folderId, "Folder ID");
    await this.queryRows(
      "SELECT request_narration_folder_reconciliation($1, $2)",
      [normalizedOwner, normalizedFolder],
    );
    const rows = await this.queryRows<FolderReconciliationRow>(
      `
        SELECT ${qualifiedFolderReconciliationColumns}
        FROM narration_folder_invalidations AS invalidation
        JOIN reading_folders AS folder
          ON folder.owner_email = invalidation.owner_email
          AND folder.id = invalidation.folder_id
          AND folder.is_archive = false
        WHERE invalidation.owner_email = $1 AND invalidation.folder_id = $2
        LIMIT 1
      `,
      [normalizedOwner, normalizedFolder],
    );

    return rows[0] ? rowToFolderReconciliation(rows[0]) : null;
  }

  async requestAllFolderReconciliations(ownerEmail: string) {
    const rows = await this.queryRows<{ folder_id: string }>(
      `
        INSERT INTO narration_folder_invalidations (
          owner_email,
          folder_id,
          requested_version,
          completed_version,
          next_attempt_at,
          created_at,
          updated_at
        )
        SELECT
          folder.owner_email,
          folder.id,
          txid_current(),
          0,
          now(),
          now(),
          now()
        FROM reading_folders AS folder
        WHERE folder.owner_email = $1 AND folder.is_archive = false
        ON CONFLICT (owner_email, folder_id) DO UPDATE
        SET
          requested_version = GREATEST(
            narration_folder_invalidations.requested_version,
            EXCLUDED.requested_version
          ),
          next_attempt_at = LEAST(
            narration_folder_invalidations.next_attempt_at,
            EXCLUDED.next_attempt_at
          ),
          last_error = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING folder_id
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows.length;
  }

  async claimNextFolderReconciliation(input: {
    ownerEmail?: string;
    leaseMs?: number;
  }) {
    const now = new Date();
    const claimToken = `narration-folder-${randomUUID()}`;
    const leaseExpiresAt = leaseExpiry(now, input.leaseMs, defaultFolderLeaseMs);
    const rows = await this.queryRows<FolderReconciliationRow>(
      `
        WITH candidate AS (
          SELECT owner_email, folder_id, requested_version
          FROM narration_folder_invalidations
          WHERE
            requested_version > completed_version
            AND next_attempt_at <= $3::timestamptz
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= $3::timestamptz
            )
            AND ($1::text IS NULL OR owner_email = $1::text)
          ORDER BY next_attempt_at, updated_at, owner_email, folder_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE narration_folder_invalidations AS invalidation
        SET
          claim_token = $2,
          claimed_version = candidate.requested_version,
          lease_expires_at = $4::timestamptz,
          attempt_count = invalidation.attempt_count + 1,
          last_error = NULL,
          updated_at = $3::timestamptz
        FROM candidate
        WHERE
          invalidation.owner_email = candidate.owner_email
          AND invalidation.folder_id = candidate.folder_id
        RETURNING ${qualifiedFolderReconciliationColumns}
      `,
      [
        input.ownerEmail ? normalizeOwnerEmail(input.ownerEmail) : null,
        claimToken,
        now.toISOString(),
        leaseExpiresAt,
      ],
    );

    return rows[0] ? rowToFolderReconciliationClaim(rows[0]) : null;
  }

  async completeFolderReconciliation(input: {
    ownerEmail: string;
    folderId: string;
    claimToken: string;
    claimedVersion: string;
  }) {
    const rows = await this.queryRows<{ folder_id: string }>(
      `
        UPDATE narration_folder_invalidations
        SET
          completed_version = GREATEST(completed_version, $4::bigint),
          claim_token = NULL,
          claimed_version = NULL,
          lease_expires_at = NULL,
          next_attempt_at = CASE
            WHEN requested_version > $4::bigint THEN $5::timestamptz
            ELSE next_attempt_at
          END,
          last_error = NULL,
          updated_at = $5::timestamptz
        WHERE
          owner_email = $1
          AND folder_id = $2
          AND claim_token = $3
          AND claimed_version = $4::bigint
        RETURNING folder_id
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.folderId, "Folder ID"),
        requiredText(input.claimToken, "Claim token"),
        bigintText(input.claimedVersion, "Claimed version"),
        new Date().toISOString(),
      ],
    );

    return rows.length > 0;
  }

  async failFolderReconciliation(input: {
    ownerEmail: string;
    folderId: string;
    claimToken: string;
    error: string;
    retryAt?: Date;
  }) {
    const now = new Date();
    const rows = await this.queryRows<{ folder_id: string }>(
      `
        UPDATE narration_folder_invalidations
        SET
          claim_token = NULL,
          claimed_version = NULL,
          lease_expires_at = NULL,
          next_attempt_at = $4::timestamptz,
          last_error = $5,
          updated_at = $6::timestamptz
        WHERE
          owner_email = $1
          AND folder_id = $2
          AND claim_token = $3
        RETURNING folder_id
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.folderId, "Folder ID"),
        requiredText(input.claimToken, "Claim token"),
        retryIso(input.retryAt, now),
        boundedError(input.error),
        now.toISOString(),
      ],
    );

    return rows.length > 0;
  }

  async listNewestNarrationCandidates(ownerEmail: string, folderId: string) {
    const rows = await this.queryRows<NarrationCandidateRow>(
      `
        SELECT
          article.id,
          article.folder_id,
          article.created_at,
          ROW_NUMBER() OVER (
            ORDER BY
              article.created_at DESC,
              lower(article.title) COLLATE "C" ASC,
              article.id ASC
          ) AS rank,
          article.title,
          article.text_content,
          article.blocks,
          article.narration
        FROM articles AS article
        JOIN reading_folders AS folder
          ON folder.owner_email = article.owner_email
          AND folder.id = article.folder_id
          AND folder.is_archive = false
        WHERE
          article.owner_email = $1
          AND article.folder_id = $2
          AND article.archived_at IS NULL
        ORDER BY
          article.created_at DESC,
          lower(article.title) COLLATE "C" ASC,
          article.id ASC
        LIMIT 10
      `,
      [
        normalizeOwnerEmail(ownerEmail),
        requiredText(folderId, "Folder ID"),
      ],
    );

    return rows.map(rowToNarrationPolicyCandidate);
  }

  async isNarrationCandidateEligible(input: {
    ownerEmail: string;
    folderId: string;
    articleId: string;
    sourceTextSha256: string;
    sentenceMapFingerprint: string;
  }) {
    const rows = await this.queryRows<Pick<
      NarrationCandidateRow,
      "id" | "title" | "text_content" | "blocks"
    >>(
      `
        WITH newest AS (
          SELECT
            article.id,
            article.title,
            article.text_content,
            article.blocks
          FROM articles AS article
          JOIN reading_folders AS folder
            ON folder.owner_email = article.owner_email
            AND folder.id = article.folder_id
            AND folder.is_archive = false
          WHERE
            article.owner_email = $1
            AND article.folder_id = $2
            AND article.archived_at IS NULL
          ORDER BY
            article.created_at DESC,
            lower(article.title) COLLATE "C" ASC,
            article.id ASC
          LIMIT 10
        )
        SELECT id, title, text_content, blocks
        FROM newest
        WHERE id = $3
        LIMIT 1
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.folderId, "Folder ID"),
        requiredText(input.articleId, "Article ID"),
      ],
    );
    const article = rows[0];

    if (!article) {
      return false;
    }

    return (
      narrationSourceSha256(article.title, article.text_content) ===
        requiredText(input.sourceTextSha256, "Source hash") &&
      narrationSentenceMapFingerprint(
        annotateBlocks(parseBlocks(article.blocks)).sentences,
      ) === requiredText(
        input.sentenceMapFingerprint,
        "Sentence-map fingerprint",
      )
    );
  }

  async claimNarrationJob(
    input: ClaimNarrationJobInput,
  ): Promise<ClaimNarrationJobResult> {
    const normalized = normalizeClaimJobInput(input);
    const now = new Date();
    await this.expireExhaustedNarrationJob(normalized, now);
    const attemptId = `narration-attempt-${randomUUID()}`;
    const jobId = `narration-job-${randomUUID()}`;
    const rows = await this.queryRows<NarrationJobRow>(
      `
        WITH eligible_articles AS (
          SELECT eligible.id, eligible.rank
          FROM (
            SELECT
              article.id,
              ROW_NUMBER() OVER (
                ORDER BY
                  article.created_at DESC,
                  lower(article.title) COLLATE "C" ASC,
                  article.id ASC
              ) AS rank
            FROM articles AS article
            JOIN reading_folders AS folder
              ON folder.owner_email = article.owner_email
              AND folder.id = article.folder_id
              AND folder.is_archive = false
            WHERE
              article.owner_email = $2
              AND article.folder_id = $4
              AND article.archived_at IS NULL
            ORDER BY
              article.created_at DESC,
              lower(article.title) COLLATE "C" ASC,
              article.id ASC
            LIMIT 10
          ) AS eligible
          WHERE eligible.id = $3
        )
        INSERT INTO article_narration_jobs (
          id,
          owner_email,
          article_id,
          selection_folder_id,
          selection_rank,
          selection_folder_invalidation_version,
          source_text_sha256,
          sentence_map_fingerprint,
          generation_fingerprint,
          language,
          profile_id,
          profile_version,
          speech_model,
          voice,
          status,
          attempt_id,
          workflow_run_id,
          lease_expires_at,
          next_attempt_at,
          attempt_count,
          cycle_attempt_count,
          retry_cycle,
          estimated_cost_usd,
          actual_cost_usd,
          cost_events,
          created_at,
          updated_at
        )
        SELECT
          $1,
          $2,
          $3,
          $4,
          eligible_articles.rank,
          $18::bigint,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          'running',
          $13,
          $14::text,
          $16::timestamptz,
          $15::timestamptz,
          1,
          1,
          0,
          $17::numeric,
          0,
          '{}'::jsonb,
          $15::timestamptz,
          $15::timestamptz
        FROM eligible_articles
        ON CONFLICT (owner_email, article_id, generation_fingerprint)
        DO UPDATE SET
          selection_folder_id = EXCLUDED.selection_folder_id,
          selection_rank = EXCLUDED.selection_rank,
          selection_folder_invalidation_version =
            EXCLUDED.selection_folder_invalidation_version,
          status = 'running',
          attempt_id = EXCLUDED.attempt_id,
          workflow_run_id = EXCLUDED.workflow_run_id,
          lease_expires_at = EXCLUDED.lease_expires_at,
          attempt_count = article_narration_jobs.attempt_count + 1,
          cycle_attempt_count = CASE
            WHEN article_narration_jobs.cycle_exhausted_at IS NOT NULL THEN 1
            ELSE article_narration_jobs.cycle_attempt_count + 1
          END,
          retry_cycle = CASE
            WHEN article_narration_jobs.cycle_exhausted_at IS NOT NULL
              THEN article_narration_jobs.retry_cycle + 1
            ELSE article_narration_jobs.retry_cycle
          END,
          failure_kind = NULL,
          cycle_exhausted_at = NULL,
          failure_folder_invalidation_version = NULL,
          article_cost_recorded_at = CASE
            WHEN article_narration_jobs.cycle_exhausted_at IS NOT NULL THEN NULL
            ELSE article_narration_jobs.article_cost_recorded_at
          END,
          estimated_cost_usd = EXCLUDED.estimated_cost_usd,
          error_message = NULL,
          completed_at = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE
          article_narration_jobs.source_text_sha256 = EXCLUDED.source_text_sha256
          AND article_narration_jobs.sentence_map_fingerprint = EXCLUDED.sentence_map_fingerprint
          AND article_narration_jobs.profile_id = EXCLUDED.profile_id
          AND article_narration_jobs.profile_version = EXCLUDED.profile_version
          AND article_narration_jobs.speech_model = EXCLUDED.speech_model
          AND article_narration_jobs.voice = EXCLUDED.voice
          AND (
            (
              article_narration_jobs.status IN ('pending', 'failed')
              AND article_narration_jobs.cycle_exhausted_at IS NULL
              AND article_narration_jobs.cycle_attempt_count < 2
              AND article_narration_jobs.next_attempt_at <= $15::timestamptz
            )
            OR (
              article_narration_jobs.status = 'running'
              AND article_narration_jobs.cycle_attempt_count < 2
              AND article_narration_jobs.lease_expires_at <= $15::timestamptz
            )
            OR (
              article_narration_jobs.status = 'failed'
              AND article_narration_jobs.failure_kind = 'transient'
              AND article_narration_jobs.cycle_exhausted_at IS NOT NULL
              AND article_narration_jobs.next_attempt_at <= $15::timestamptz
              AND EXCLUDED.selection_folder_invalidation_version >
                article_narration_jobs.failure_folder_invalidation_version
            )
          )
        RETURNING ${narrationJobColumns}
      `,
      [
        jobId,
        normalized.ownerEmail,
        normalized.articleId,
        normalized.folderId,
        normalized.sourceTextSha256,
        normalized.sentenceMapFingerprint,
        normalized.generationFingerprint,
        normalized.language,
        normalized.profileId,
        normalized.profileVersion,
        normalized.speechModel,
        normalized.voice,
        attemptId,
        normalized.workflowRunId,
        now.toISOString(),
        leaseExpiry(now, input.leaseMs, defaultJobLeaseMs),
        normalized.estimatedCostUsd,
        normalized.folderInvalidationVersion,
      ],
    );

    if (rows[0]) {
      return {
        kind: "claimed",
        job: rowToStoredNarrationJob(rows[0]),
        attemptId,
      };
    }

    const existing = await this.findNarrationJob(
      normalized.ownerEmail,
      normalized.articleId,
      normalized.generationFingerprint,
    );

    if (!existing) {
      return { kind: "not-eligible" };
    }

    return {
      kind: existing.status === "completed"
        ? "completed"
        : isNarrationJobCooldown(existing, normalized.folderInvalidationVersion, now)
          ? "cooldown"
          : "busy",
      job: existing,
    };
  }

  async findNarrationJob(
    ownerEmail: string,
    articleId: string,
    generationFingerprint: string,
  ) {
    const rows = await this.queryRows<NarrationJobRow>(
      `
        SELECT ${narrationJobColumns}
        FROM article_narration_jobs
        WHERE
          owner_email = $1
          AND article_id = $2
          AND generation_fingerprint = $3
        LIMIT 1
      `,
      [
        normalizeOwnerEmail(ownerEmail),
        requiredText(articleId, "Article ID"),
        requiredText(generationFingerprint, "Generation fingerprint"),
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  async completeNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    sourceTextSha256: string;
    generationFingerprint: string;
  }) {
    const now = new Date().toISOString();
    const rows = await this.queryRows<NarrationJobRow>(
      `
        UPDATE article_narration_jobs AS job
        SET
          status = 'completed',
          attempt_id = NULL,
          lease_expires_at = NULL,
          error_message = NULL,
          completed_at = $6::timestamptz,
          updated_at = $6::timestamptz
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.status = 'running'
          AND job.attempt_id = $3
          AND job.source_text_sha256 = $4
          AND job.generation_fingerprint = $5
          AND job.planned_segment_count IS NOT NULL
          AND job.planned_segment_count = (
            SELECT COUNT(*)
            FROM article_narration_job_segments AS segment
            WHERE segment.job_id = job.id AND segment.status = 'completed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM article_narration_job_segments AS segment
            WHERE segment.job_id = job.id AND segment.status <> 'completed'
          )
        RETURNING ${qualifiedNarrationJobColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.attemptId, "Attempt ID"),
        requiredText(input.sourceTextSha256, "Source hash"),
        requiredText(input.generationFingerprint, "Generation fingerprint"),
        now,
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  async renewNarrationJobLease(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    leaseMs?: number;
  }) {
    const now = new Date();
    const rows = await this.queryRows<NarrationJobRow>(
      `
        UPDATE article_narration_jobs
        SET
          lease_expires_at = $4::timestamptz,
          updated_at = $5::timestamptz
        WHERE
          owner_email = $1
          AND id = $2
          AND status = 'running'
          AND attempt_id = $3
        RETURNING ${narrationJobColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.attemptId, "Attempt ID"),
        leaseExpiry(now, input.leaseMs, defaultJobLeaseMs),
        now.toISOString(),
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  async failNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    error: string;
    failureKind: "transient";
    cycleExhausted: boolean;
    retryAt?: Date;
  }) {
    if (input.failureKind !== "transient") {
      throw new Error("Terminal narration failures must be cancelled.");
    }
    const now = new Date();
    const rows = await this.queryRows<NarrationJobRow>(
      `
        UPDATE article_narration_jobs AS job
        SET
          status = 'failed',
          attempt_id = NULL,
          lease_expires_at = NULL,
          next_attempt_at = CASE
            WHEN $6::boolean OR job.cycle_attempt_count >= 2
              THEN GREATEST(
                $5::timestamptz,
                $7::timestamptz + interval '24 hours'
              )
            ELSE $5::timestamptz
          END,
          failure_kind = 'transient',
          cycle_exhausted_at = CASE
            WHEN $6::boolean OR job.cycle_attempt_count >= 2
              THEN $7::timestamptz
            ELSE NULL
          END,
          failure_folder_invalidation_version = CASE
            WHEN $6::boolean OR job.cycle_attempt_count >= 2
              THEN job.selection_folder_invalidation_version
            ELSE NULL
          END,
          error_message = $4,
          updated_at = $7::timestamptz
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.status = 'running'
          AND job.attempt_id = $3
        RETURNING ${qualifiedNarrationJobColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.attemptId, "Attempt ID"),
        boundedError(input.error),
        retryIso(input.retryAt, now),
        input.cycleExhausted,
        now.toISOString(),
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  async releaseNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
  }) {
    return this.finishRunningJob({
      ...input,
      status: "pending",
      retryAt: new Date().toISOString(),
      error: null,
      refundAttempt: true,
    });
  }

  async cancelNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId?: string;
    reason?: string;
  }) {
    const now = new Date().toISOString();
    const rows = await this.queryRows<NarrationJobRow>(
      `
        UPDATE article_narration_jobs
        SET
          status = 'cancelled',
          attempt_id = NULL,
          lease_expires_at = NULL,
          failure_kind = 'terminal',
          cycle_exhausted_at = NULL,
          failure_folder_invalidation_version = NULL,
          error_message = $4::text,
          completed_at = $5::timestamptz,
          updated_at = $5::timestamptz
        WHERE
          owner_email = $1
          AND id = $2
          AND status <> 'completed'
          AND (status <> 'running' OR attempt_id = $3::text)
        RETURNING ${narrationJobColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        input.attemptId ?? null,
        input.reason ? boundedError(input.reason) : null,
        now,
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  async recordNarrationJobCost(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    eventId: string;
    costUsd: number;
  }) {
    const rows = await this.queryRows<{
      recorded: boolean;
      actual_cost_usd: number | string;
    }>(
      `
        WITH updated AS (
          UPDATE article_narration_jobs
          SET
            actual_cost_usd = ROUND(actual_cost_usd + $5::numeric, 6),
            cost_events = cost_events || jsonb_build_object($4::text, $5::numeric),
            updated_at = $6::timestamptz
          WHERE
            owner_email = $1
            AND id = $2
            AND status = 'running'
            AND attempt_id = $3
            AND NOT cost_events ? $4::text
          RETURNING actual_cost_usd
        )
        SELECT true AS recorded, actual_cost_usd FROM updated
        UNION ALL
        SELECT false AS recorded, job.actual_cost_usd
        FROM article_narration_jobs AS job
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.attempt_id = $3
          AND NOT EXISTS (SELECT 1 FROM updated)
        LIMIT 1
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.attemptId, "Attempt ID"),
        requiredText(input.eventId, "Cost event ID"),
        costValue(input.costUsd),
        new Date().toISOString(),
      ],
    );

    return rows[0]
      ? {
          recorded: rows[0].recorded,
          actualCostUsd: numberValue(rows[0].actual_cost_usd),
        }
      : null;
  }

  async settleNarrationJobCost(ownerEmail: string, jobId: string) {
    const now = new Date().toISOString();
    const rows = await this.queryRows<NarrationJobRow & { recorded: boolean }>(
      `
        WITH settlement_candidate AS (
          SELECT
            job.id,
            job.article_id,
            job.actual_cost_usd,
            job.article_cost_recorded_usd,
            job.actual_cost_usd - job.article_cost_recorded_usd AS unsettled_cost_usd
          FROM article_narration_jobs AS job
          WHERE
            job.owner_email = $1
            AND job.id = $2
            AND (
              job.status IN ('completed', 'cancelled')
              OR (
                job.status = 'failed'
                AND job.failure_kind = 'transient'
                AND job.cycle_exhausted_at IS NOT NULL
              )
            )
            AND job.actual_cost_usd >= job.article_cost_recorded_usd
            AND (
              job.article_cost_recorded_at IS NULL
              OR job.actual_cost_usd > job.article_cost_recorded_usd
            )
          FOR UPDATE
        ),
        charged_article AS (
          UPDATE articles AS article
          SET
            processing_cost_usd = ROUND(
              article.processing_cost_usd + candidate.unsettled_cost_usd,
              6
            ),
            updated_at = $3::timestamptz
          FROM settlement_candidate AS candidate
          WHERE
            article.owner_email = $1
            AND article.id = candidate.article_id
          RETURNING article.id AS article_id
        ),
        settled_job AS (
          UPDATE article_narration_jobs AS job
          SET
            article_cost_recorded_at = $3::timestamptz,
            article_cost_recorded_usd = job.actual_cost_usd,
            updated_at = $3::timestamptz
          FROM charged_article
          WHERE
            job.owner_email = $1
            AND job.id = $2
            AND job.article_id = charged_article.article_id
            AND job.article_cost_recorded_usd <= job.actual_cost_usd
          RETURNING job.*
        )
        SELECT true AS recorded, ${qualifiedNarrationJobColumns}
        FROM settled_job AS job
        UNION ALL
        SELECT false AS recorded, ${qualifiedNarrationJobColumns}
        FROM article_narration_jobs AS job
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND (
            job.status IN ('completed', 'cancelled')
            OR (
              job.status = 'failed'
              AND job.failure_kind = 'transient'
              AND job.cycle_exhausted_at IS NOT NULL
            )
          )
          AND job.article_cost_recorded_at IS NOT NULL
          AND job.article_cost_recorded_usd = job.actual_cost_usd
          AND NOT EXISTS (SELECT 1 FROM settled_job)
        LIMIT 1
      `,
      [
        normalizeOwnerEmail(ownerEmail),
        requiredText(jobId, "Job ID"),
        now,
      ],
    );

    return rows[0]
      ? {
          recorded: rows[0].recorded,
          job: rowToStoredNarrationJob(rows[0]),
        }
      : null;
  }

  async createNarrationSegmentPlan(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segments: NarrationSegmentPlanItem[];
  }) {
    const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
    const jobId = requiredText(input.jobId, "Job ID");
    const jobAttemptId = requiredText(input.jobAttemptId, "Job attempt ID");
    const segments = normalizeSegmentPlan(input.segments);
    const serializedPlan = segments.map((segment) => ({
      segment_index: segment.segmentIndex,
      input_text: segment.inputText,
      input_sha256: segment.inputSha256,
      input_code_points: segment.inputCodePoints,
      unit_map: segment.unitMap,
    }));
    const now = new Date().toISOString();
    const accepted = await this.queryRows<{ id: string }>(
      `
        WITH plan AS (
          SELECT *
          FROM jsonb_to_recordset($4::jsonb) AS planned(
            segment_index integer,
            input_text text,
            input_sha256 text,
            input_code_points integer,
            unit_map jsonb
          )
        ),
        locked_job AS (
          UPDATE article_narration_jobs
          SET
            planned_segment_count = $5,
            updated_at = $6::timestamptz
          WHERE
            owner_email = $1
            AND id = $2
            AND status = 'running'
            AND attempt_id = $3
            AND (
              planned_segment_count IS NULL
              OR planned_segment_count = $5
            )
          RETURNING id, retry_cycle
        ),
        inserted AS (
          INSERT INTO article_narration_job_segments (
            job_id,
            segment_index,
            input_text,
            input_sha256,
            input_code_points,
            unit_map,
            status,
            retry_cycle,
            next_attempt_at,
            created_at,
            updated_at
          )
          SELECT
            locked_job.id,
            plan.segment_index,
            plan.input_text,
            plan.input_sha256,
            plan.input_code_points,
            plan.unit_map,
            'pending',
            locked_job.retry_cycle,
            $6::timestamptz,
            $6::timestamptz,
            $6::timestamptz
          FROM locked_job
          CROSS JOIN plan
          ON CONFLICT (job_id, segment_index) DO NOTHING
          RETURNING job_id
        )
        SELECT id FROM locked_job
      `,
      [
        ownerEmail,
        jobId,
        jobAttemptId,
        JSON.stringify(serializedPlan),
        segments.length,
        now,
      ],
    );

    if (!accepted[0]) {
      return null;
    }

    const stored = await this.listNarrationSegments(ownerEmail, jobId);

    if (!sameSegmentPlan(segments, stored)) {
      throw new NarrationPolicyPersistenceError(
        "The saved narration segment plan conflicts with this generation.",
      );
    }

    return stored;
  }

  async listNarrationSegments(ownerEmail: string, jobId: string) {
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        SELECT ${qualifiedNarrationSegmentColumns}
        FROM article_narration_job_segments AS segment
        JOIN article_narration_jobs AS job ON job.id = segment.job_id
        WHERE job.owner_email = $1 AND job.id = $2
        ORDER BY segment.segment_index
      `,
      [
        normalizeOwnerEmail(ownerEmail),
        requiredText(jobId, "Job ID"),
      ],
    );

    return rows.map(rowToStoredNarrationSegment);
  }

  async claimNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    inputSha256: string;
    leaseMs?: number;
  }): Promise<ClaimNarrationSegmentResult> {
    const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
    const jobId = requiredText(input.jobId, "Job ID");
    const jobAttemptId = requiredText(input.jobAttemptId, "Job attempt ID");
    const segmentIndex = nonNegativeInteger(input.segmentIndex, "Segment index");
    const inputSha256 = requiredText(input.inputSha256, "Segment input hash");
    const attemptId = `narration-segment-${randomUUID()}`;
    const now = new Date();
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        UPDATE article_narration_job_segments AS segment
        SET
          status = 'running',
          attempt_id = $6,
          job_attempt_id = $3,
          lease_expires_at = $8::timestamptz,
          attempt_count = segment.attempt_count + 1,
          cycle_attempt_count = CASE
            WHEN segment.retry_cycle < job.retry_cycle THEN 1
            ELSE segment.cycle_attempt_count + 1
          END,
          retry_cycle = job.retry_cycle,
          error_message = NULL,
          completed_at = NULL,
          updated_at = $7::timestamptz
        FROM article_narration_jobs AS job
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.status = 'running'
          AND job.attempt_id = $3
          AND job.lease_expires_at > $7::timestamptz
          AND segment.job_id = job.id
          AND segment.segment_index = $4
          AND segment.input_sha256 = $5
          AND (
            (
              segment.retry_cycle < job.retry_cycle
              AND segment.status IN ('pending', 'failed', 'running')
            )
            OR (
              segment.retry_cycle = job.retry_cycle
              AND segment.cycle_attempt_count < 2
              AND (
                (
                  segment.status IN ('pending', 'failed')
                  AND segment.next_attempt_at <= $7::timestamptz
                )
                OR (
                  segment.status = 'running'
                  AND segment.lease_expires_at <= $7::timestamptz
                )
              )
            )
          )
        RETURNING ${qualifiedNarrationSegmentColumns}
      `,
      [
        ownerEmail,
        jobId,
        jobAttemptId,
        segmentIndex,
        inputSha256,
        attemptId,
        now.toISOString(),
        leaseExpiry(now, input.leaseMs, defaultSegmentLeaseMs),
      ],
    );

    if (rows[0]) {
      return {
        kind: "claimed",
        segment: rowToStoredNarrationSegment(rows[0]),
        attemptId,
      };
    }

    const existing = await this.findNarrationSegment(
      ownerEmail,
      jobId,
      segmentIndex,
    );

    if (!existing) {
      return { kind: "missing-job" };
    }
    if (existing.inputSha256 !== inputSha256) {
      return { kind: "conflict" };
    }

    return {
      kind: existing.status === "completed" ? "completed" : "busy",
      segment: existing,
    };
  }

  async completeNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    inputSha256: string;
    artifactKey: string;
    artifactVisibility: "private" | "public";
    contentType: string;
    byteLength: number;
    durationSeconds: number;
    alignmentModel: string;
    transcriptSha256: string;
    qa: unknown;
    alignment: unknown;
    localSentenceCues: import("@/lib/types").ArticleNarrationCue[];
    ttsCostUsd: number;
    alignmentCostUsd: number;
    diagnosticCostUsd: number;
  }) {
    const now = new Date().toISOString();
    const costs = {
      tts: costValue(input.ttsCostUsd),
      alignment: costValue(input.alignmentCostUsd),
      diagnostic: costValue(input.diagnosticCostUsd),
    };
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        WITH completed_segment AS (
          UPDATE article_narration_job_segments AS segment
          SET
            status = 'completed',
            attempt_id = NULL,
            job_attempt_id = NULL,
            lease_expires_at = NULL,
            artifact_key = $7,
            artifact_visibility = $8,
            content_type = $9,
            byte_length = $10,
            duration_seconds = $11::numeric,
            alignment_model = $12,
            transcript_sha256 = $13,
            qa = $14::jsonb,
            alignment = $15::jsonb,
            local_sentence_cues = $16::jsonb,
            tts_cost_usd = $17::numeric,
            alignment_cost_usd = $18::numeric,
            diagnostic_cost_usd = $19::numeric,
            error_message = NULL,
            completed_at = $20::timestamptz,
            updated_at = $20::timestamptz
          FROM article_narration_jobs AS job
          WHERE
            job.owner_email = $1
            AND job.id = $2
            AND job.status = 'running'
            AND job.attempt_id = $3
            AND segment.job_id = job.id
            AND segment.segment_index = $4
            AND segment.status = 'running'
            AND segment.attempt_id = $5
            AND segment.job_attempt_id = $3
            AND segment.input_sha256 = $6
          RETURNING segment.*
        ),
        charged_job AS (
          UPDATE article_narration_jobs AS job
          SET
            actual_cost_usd = ROUND(
              job.actual_cost_usd + $17::numeric + $18::numeric + $19::numeric,
              6
            ),
            updated_at = $20::timestamptz
          FROM completed_segment
          WHERE job.id = completed_segment.job_id
          RETURNING job.id
        )
        SELECT ${narrationSegmentColumns}
        FROM completed_segment
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.jobAttemptId, "Job attempt ID"),
        nonNegativeInteger(input.segmentIndex, "Segment index"),
        requiredText(input.attemptId, "Segment attempt ID"),
        requiredText(input.inputSha256, "Segment input hash"),
        requiredText(input.artifactKey, "Artifact key"),
        input.artifactVisibility,
        requiredText(input.contentType, "Content type"),
        nonNegativeInteger(input.byteLength, "Byte length"),
        nonNegativeNumber(input.durationSeconds, "Duration"),
        requiredText(input.alignmentModel, "Alignment model"),
        requiredText(input.transcriptSha256, "Transcript hash"),
        JSON.stringify(input.qa ?? null),
        JSON.stringify(input.alignment ?? null),
        JSON.stringify(input.localSentenceCues),
        costs.tts,
        costs.alignment,
        costs.diagnostic,
        now,
      ],
    );

    return rows[0] ? rowToStoredNarrationSegment(rows[0]) : null;
  }

  async renewNarrationSegmentLease(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    leaseMs?: number;
  }) {
    const now = new Date();
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        UPDATE article_narration_job_segments AS segment
        SET
          lease_expires_at = $6::timestamptz,
          updated_at = $7::timestamptz
        FROM article_narration_jobs AS job
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.status = 'running'
          AND job.attempt_id = $3
          AND segment.job_id = job.id
          AND segment.segment_index = $4
          AND segment.status = 'running'
          AND segment.attempt_id = $5
          AND segment.job_attempt_id = $3
        RETURNING ${qualifiedNarrationSegmentColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.jobAttemptId, "Job attempt ID"),
        nonNegativeInteger(input.segmentIndex, "Segment index"),
        requiredText(input.attemptId, "Segment attempt ID"),
        leaseExpiry(now, input.leaseMs, defaultSegmentLeaseMs),
        now.toISOString(),
      ],
    );

    return rows[0] ? rowToStoredNarrationSegment(rows[0]) : null;
  }

  async failNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    error: string;
    retryAt?: Date;
    progress?: NarrationSegmentFailureProgress;
  }) {
    return this.finishRunningSegment({
      ...input,
      status: "failed",
      retryAt: retryIso(input.retryAt),
      error: boundedError(input.error),
      progress: normalizeFailureProgress(input.progress),
      refundAttempt: false,
    });
  }

  async releaseNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
  }) {
    return this.finishRunningSegment({
      ...input,
      status: "pending",
      retryAt: new Date().toISOString(),
      error: null,
      progress: {},
      refundAttempt: true,
    });
  }

  async findNarrationSegment(
    ownerEmail: string,
    jobId: string,
    segmentIndex: number,
  ) {
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        SELECT ${qualifiedNarrationSegmentColumns}
        FROM article_narration_job_segments AS segment
        JOIN article_narration_jobs AS job ON job.id = segment.job_id
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND segment.segment_index = $3
        LIMIT 1
      `,
      [ownerEmail, jobId, segmentIndex],
    );

    return rows[0] ? rowToStoredNarrationSegment(rows[0]) : null;
  }

  private async finishRunningSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    status: "pending" | "failed";
    retryAt: string;
    error: string | null;
    progress: NarrationSegmentFailureProgress;
    refundAttempt: boolean;
  }) {
    const now = new Date().toISOString();
    const rows = await this.queryRows<NarrationSegmentRow>(
      `
        UPDATE article_narration_job_segments AS segment
        SET
          status = $6,
          attempt_id = NULL,
          job_attempt_id = NULL,
          lease_expires_at = NULL,
          next_attempt_at = $7::timestamptz,
          error_message = $8::text,
          artifact_key = CASE
            WHEN $10::jsonb ? 'artifactKey' THEN $10::jsonb ->> 'artifactKey'
            ELSE artifact_key
          END,
          artifact_visibility = CASE
            WHEN $10::jsonb ? 'artifactVisibility'
              THEN $10::jsonb ->> 'artifactVisibility'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.artifact_visibility
          END,
          content_type = CASE
            WHEN $10::jsonb ? 'contentType' THEN $10::jsonb ->> 'contentType'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.content_type
          END,
          byte_length = CASE
            WHEN $10::jsonb ? 'byteLength'
              THEN ($10::jsonb ->> 'byteLength')::integer
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.byte_length
          END,
          duration_seconds = CASE
            WHEN $10::jsonb ? 'durationSeconds'
              THEN ($10::jsonb ->> 'durationSeconds')::numeric
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.duration_seconds
          END,
          alignment_model = CASE
            WHEN $10::jsonb ? 'alignmentModel'
              THEN $10::jsonb ->> 'alignmentModel'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.alignment_model
          END,
          transcript_sha256 = CASE
            WHEN $10::jsonb ? 'transcriptSha256'
              THEN $10::jsonb ->> 'transcriptSha256'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.transcript_sha256
          END,
          qa = CASE
            WHEN $10::jsonb ? 'qa' THEN $10::jsonb -> 'qa'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.qa
          END,
          alignment = CASE
            WHEN $10::jsonb ? 'alignment' THEN $10::jsonb -> 'alignment'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.alignment
          END,
          local_sentence_cues = CASE
            WHEN $10::jsonb ? 'localSentenceCues'
              THEN $10::jsonb -> 'localSentenceCues'
            WHEN
              $10::jsonb ? 'artifactKey'
              AND ($10::jsonb ->> 'artifactKey') IS DISTINCT FROM segment.artifact_key
              THEN NULL
            ELSE segment.local_sentence_cues
          END,
          tts_cost_usd = CASE
            WHEN $10::jsonb ? 'ttsCostUsd'
              THEN ($10::jsonb ->> 'ttsCostUsd')::numeric
            ELSE tts_cost_usd
          END,
          alignment_cost_usd = CASE
            WHEN $10::jsonb ? 'alignmentCostUsd'
              THEN ($10::jsonb ->> 'alignmentCostUsd')::numeric
            ELSE alignment_cost_usd
          END,
          diagnostic_cost_usd = CASE
            WHEN $10::jsonb ? 'diagnosticCostUsd'
              THEN ($10::jsonb ->> 'diagnosticCostUsd')::numeric
            ELSE diagnostic_cost_usd
          END,
          attempt_count = CASE
            WHEN $11::boolean THEN GREATEST(segment.attempt_count - 1, 0)
            ELSE segment.attempt_count
          END,
          cycle_attempt_count = CASE
            WHEN $11::boolean THEN GREATEST(segment.cycle_attempt_count - 1, 0)
            ELSE segment.cycle_attempt_count
          END,
          updated_at = $9::timestamptz
        FROM article_narration_jobs AS job
        WHERE
          job.owner_email = $1
          AND job.id = $2
          AND job.status = 'running'
          AND job.attempt_id = $3
          AND segment.job_id = job.id
          AND segment.segment_index = $4
          AND segment.status = 'running'
          AND segment.attempt_id = $5
          AND segment.job_attempt_id = $3
        RETURNING ${qualifiedNarrationSegmentColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.jobAttemptId, "Job attempt ID"),
        nonNegativeInteger(input.segmentIndex, "Segment index"),
        requiredText(input.attemptId, "Segment attempt ID"),
        input.status,
        input.retryAt,
        input.error,
        now,
        JSON.stringify(input.progress),
        input.refundAttempt,
      ],
    );

    return rows[0] ? rowToStoredNarrationSegment(rows[0]) : null;
  }

  private async finishRunningJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    status: "pending" | "failed";
    retryAt: string;
    error: string | null;
    refundAttempt: boolean;
  }) {
    const now = new Date().toISOString();
    const rows = await this.queryRows<NarrationJobRow>(
      `
        UPDATE article_narration_jobs
        SET
          status = $4,
          attempt_id = NULL,
          lease_expires_at = NULL,
          next_attempt_at = $5::timestamptz,
          error_message = $6::text,
          attempt_count = CASE
            WHEN $7::boolean THEN GREATEST(attempt_count - 1, 0)
            ELSE attempt_count
          END,
          cycle_attempt_count = CASE
            WHEN $7::boolean THEN GREATEST(cycle_attempt_count - 1, 0)
            ELSE cycle_attempt_count
          END,
          failure_kind = NULL,
          cycle_exhausted_at = NULL,
          failure_folder_invalidation_version = NULL,
          updated_at = $8::timestamptz
        WHERE
          owner_email = $1
          AND id = $2
          AND status = 'running'
          AND attempt_id = $3
          AND (
            NOT $7::boolean
            OR actual_cost_usd = article_cost_recorded_usd
          )
        RETURNING ${narrationJobColumns}
      `,
      [
        normalizeOwnerEmail(input.ownerEmail),
        requiredText(input.jobId, "Job ID"),
        requiredText(input.attemptId, "Attempt ID"),
        input.status,
        input.retryAt,
        input.error,
        input.refundAttempt,
        now,
      ],
    );

    return rows[0] ? rowToStoredNarrationJob(rows[0]) : null;
  }

  private async expireExhaustedNarrationJob(
    input: ReturnType<typeof normalizeClaimJobInput>,
    now: Date,
  ) {
    await this.queryRows(
      `
        UPDATE article_narration_jobs AS job
        SET
          status = 'failed',
          attempt_id = NULL,
          lease_expires_at = NULL,
          next_attempt_at = GREATEST(
            job.next_attempt_at,
            job.lease_expires_at + interval '24 hours'
          ),
          failure_kind = 'transient',
          cycle_exhausted_at = job.lease_expires_at,
          failure_folder_invalidation_version =
            job.selection_folder_invalidation_version,
          error_message = 'Narration job lease expired after its final cycle attempt.',
          updated_at = $4::timestamptz
        WHERE
          job.owner_email = $1
          AND job.article_id = $2
          AND job.generation_fingerprint = $3
          AND job.status = 'running'
          AND job.cycle_attempt_count >= 2
          AND job.lease_expires_at <= $4::timestamptz
      `,
      [
        input.ownerEmail,
        input.articleId,
        input.generationFingerprint,
        now.toISOString(),
      ],
    );
  }

  private queryRows<T = unknown>(query: string, params: unknown[] = []) {
    const client = this.queryClient ?? getDatabaseSql();
    return client.query(query, params) as Promise<T[]>;
  }
}

const folderReconciliationColumnNames = [
  "owner_email",
  "folder_id",
  "requested_version",
  "completed_version",
  "claim_token",
  "claimed_version",
  "lease_expires_at",
  "next_attempt_at",
  "attempt_count",
  "last_error",
  "updated_at",
] as const;

const qualifiedFolderReconciliationColumns = folderReconciliationColumnNames
  .map((column) => `invalidation.${column}`)
  .join(", ");

const narrationJobColumnNames = [
  "id",
  "owner_email",
  "article_id",
  "selection_folder_id",
  "selection_rank",
  "selection_folder_invalidation_version",
  "source_text_sha256",
  "sentence_map_fingerprint",
  "generation_fingerprint",
  "language",
  "profile_id",
  "profile_version",
  "speech_model",
  "voice",
  "status",
  "attempt_id",
  "workflow_run_id",
  "lease_expires_at",
  "next_attempt_at",
  "attempt_count",
  "cycle_attempt_count",
  "retry_cycle",
  "failure_kind",
  "cycle_exhausted_at",
  "failure_folder_invalidation_version",
  "estimated_cost_usd",
  "actual_cost_usd",
  "article_cost_recorded_usd",
  "article_cost_recorded_at",
  "planned_segment_count",
  "error_message",
  "created_at",
  "updated_at",
  "completed_at",
] as const;

const narrationJobColumns = narrationJobColumnNames.join(", ");
const qualifiedNarrationJobColumns = narrationJobColumnNames
  .map((column) => `job.${column}`)
  .join(", ");

const narrationSegmentColumnNames = [
  "job_id",
  "segment_index",
  "input_text",
  "input_sha256",
  "input_code_points",
  "unit_map",
  "status",
  "attempt_id",
  "job_attempt_id",
  "lease_expires_at",
  "next_attempt_at",
  "attempt_count",
  "cycle_attempt_count",
  "retry_cycle",
  "artifact_key",
  "artifact_visibility",
  "content_type",
  "byte_length",
  "duration_seconds",
  "alignment_model",
  "transcript_sha256",
  "qa",
  "alignment",
  "local_sentence_cues",
  "tts_cost_usd",
  "alignment_cost_usd",
  "diagnostic_cost_usd",
  "error_message",
  "created_at",
  "updated_at",
  "completed_at",
] as const;

const narrationSegmentColumns = narrationSegmentColumnNames.join(", ");
const qualifiedNarrationSegmentColumns = narrationSegmentColumnNames
  .map((column) => `segment.${column}`)
  .join(", ");

function rowToFolderReconciliation(
  row: FolderReconciliationRow,
): FolderReconciliation {
  return {
    ownerEmail: row.owner_email,
    folderId: row.folder_id,
    requestedVersion: String(row.requested_version),
    completedVersion: String(row.completed_version),
    attemptCount: numberValue(row.attempt_count),
    nextAttemptAt: isoString(row.next_attempt_at),
    lastError: row.last_error ?? undefined,
    updatedAt: isoString(row.updated_at),
  };
}

function rowToFolderReconciliationClaim(
  row: FolderReconciliationRow,
): FolderReconciliationClaim {
  const claimToken = row.claim_token;
  const claimedVersion = row.claimed_version;
  const leaseExpiresAt = row.lease_expires_at;

  if (!claimToken || claimedVersion === null || !leaseExpiresAt) {
    throw new NarrationPolicyPersistenceError(
      "A claimed folder reconciliation is missing its lease.",
    );
  }

  return {
    ...rowToFolderReconciliation(row),
    claimToken,
    claimedVersion: String(claimedVersion),
    leaseExpiresAt: isoString(leaseExpiresAt),
  };
}

function rowToNarrationPolicyCandidate(
  row: NarrationCandidateRow,
): NarrationPolicyCandidate {
  const blocks = parseBlocks(row.blocks);
  const narration = parseNarration(row.narration);
  const sourceTextSha256 = narrationSourceSha256(row.title, row.text_content);
  const sentenceMapFingerprint = narrationSentenceMapFingerprint(
    annotateBlocks(blocks).sentences,
  );

  return {
    articleId: row.id,
    folderId: row.folder_id,
    rank: numberValue(row.rank),
    createdAt: isoString(row.created_at),
    sourceTextSha256,
    sentenceMapFingerprint,
    narrationState: narrationCandidateState(
      narration,
      sourceTextSha256,
      sentenceMapFingerprint,
    ),
    narration,
  };
}

function narrationCandidateState(
  narration: ArticleNarration | undefined,
  sourceTextSha256: string,
  sentenceMapFingerprint: string,
): NarrationCandidateState {
  if (!narration) {
    return "missing";
  }
  if (narration.sourceTextSha256 !== sourceTextSha256) {
    return "stale-source";
  }
  if (!narration.alignment) {
    return "missing-alignment";
  }
  if (
    narration.alignment.version !== 1 ||
    narration.alignment.sentenceMapFingerprint !== sentenceMapFingerprint
  ) {
    return "stale-alignment";
  }
  return "ready";
}

function rowToStoredNarrationJob(row: NarrationJobRow): StoredNarrationJob {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    articleId: row.article_id,
    selectionFolderId: row.selection_folder_id,
    selectionRank: numberValue(row.selection_rank),
    selectionFolderInvalidationVersion: String(
      row.selection_folder_invalidation_version,
    ),
    sourceTextSha256: row.source_text_sha256,
    sentenceMapFingerprint: row.sentence_map_fingerprint,
    generationFingerprint: row.generation_fingerprint,
    language: row.language,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    speechModel: row.speech_model,
    voice: row.voice,
    status: row.status,
    attemptId: row.attempt_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at
      ? isoString(row.lease_expires_at)
      : undefined,
    nextAttemptAt: isoString(row.next_attempt_at),
    attemptCount: numberValue(row.attempt_count),
    cycleAttemptCount: numberValue(row.cycle_attempt_count),
    retryCycle: numberValue(row.retry_cycle),
    failureKind: row.failure_kind ?? undefined,
    cycleExhaustedAt: row.cycle_exhausted_at
      ? isoString(row.cycle_exhausted_at)
      : undefined,
    failureFolderInvalidationVersion:
      row.failure_folder_invalidation_version === null
        ? undefined
        : String(row.failure_folder_invalidation_version),
    estimatedCostUsd: numberValue(row.estimated_cost_usd),
    actualCostUsd: numberValue(row.actual_cost_usd),
    articleCostRecordedUsd: numberValue(row.article_cost_recorded_usd),
    articleCostRecordedAt: row.article_cost_recorded_at
      ? isoString(row.article_cost_recorded_at)
      : undefined,
    plannedSegmentCount:
      row.planned_segment_count === null
        ? undefined
        : numberValue(row.planned_segment_count),
    errorMessage: row.error_message ?? undefined,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    completedAt: row.completed_at ? isoString(row.completed_at) : undefined,
  };
}

function rowToStoredNarrationSegment(
  row: NarrationSegmentRow,
): StoredNarrationSegment {
  const localSentenceCues = parseJson(row.local_sentence_cues);

  return {
    jobId: row.job_id,
    segmentIndex: numberValue(row.segment_index),
    inputText: row.input_text,
    inputSha256: row.input_sha256,
    inputCodePoints: numberValue(row.input_code_points),
    unitMap: parseJson(row.unit_map),
    status: row.status,
    attemptId: row.attempt_id ?? undefined,
    jobAttemptId: row.job_attempt_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at
      ? isoString(row.lease_expires_at)
      : undefined,
    nextAttemptAt: isoString(row.next_attempt_at),
    attemptCount: numberValue(row.attempt_count),
    cycleAttemptCount: numberValue(row.cycle_attempt_count),
    retryCycle: numberValue(row.retry_cycle),
    artifactKey: row.artifact_key ?? undefined,
    artifactVisibility: row.artifact_visibility ?? undefined,
    contentType: row.content_type ?? undefined,
    byteLength:
      row.byte_length === null ? undefined : numberValue(row.byte_length),
    durationSeconds:
      row.duration_seconds === null
        ? undefined
        : numberValue(row.duration_seconds),
    alignmentModel: row.alignment_model ?? undefined,
    transcriptSha256: row.transcript_sha256 ?? undefined,
    qa: row.qa === null ? undefined : parseJson(row.qa),
    alignment:
      row.alignment === null ? undefined : parseJson(row.alignment),
    localSentenceCues: Array.isArray(localSentenceCues)
      ? localSentenceCues
      : undefined,
    ttsCostUsd: numberValue(row.tts_cost_usd),
    alignmentCostUsd: numberValue(row.alignment_cost_usd),
    diagnosticCostUsd: numberValue(row.diagnostic_cost_usd),
    errorMessage: row.error_message ?? undefined,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    completedAt: row.completed_at ? isoString(row.completed_at) : undefined,
  };
}

function normalizeClaimJobInput(input: ClaimNarrationJobInput) {
  return {
    ownerEmail: normalizeOwnerEmail(input.ownerEmail),
    articleId: requiredText(input.articleId, "Article ID"),
    folderId: requiredText(input.folderId, "Folder ID"),
    folderInvalidationVersion: bigintText(
      input.folderInvalidationVersion,
      "Folder invalidation version",
    ),
    sourceTextSha256: requiredText(input.sourceTextSha256, "Source hash"),
    sentenceMapFingerprint: requiredText(
      input.sentenceMapFingerprint,
      "Sentence-map fingerprint",
    ),
    generationFingerprint: requiredText(
      input.generationFingerprint,
      "Generation fingerprint",
    ),
    language: requiredText(input.language, "Language"),
    profileId: requiredText(input.profileId, "Profile ID"),
    profileVersion: requiredText(input.profileVersion, "Profile version"),
    speechModel: requiredText(input.speechModel, "Speech model"),
    voice: requiredText(input.voice, "Voice"),
    workflowRunId: input.workflowRunId
      ? requiredText(input.workflowRunId, "Workflow run ID")
      : null,
    estimatedCostUsd: costValue(input.estimatedCostUsd ?? 0),
  };
}

function isNarrationJobCooldown(
  job: StoredNarrationJob,
  folderInvalidationVersion: string,
  now: Date,
) {
  return (
    job.status === "failed" &&
    job.failureKind === "transient" &&
    Boolean(job.cycleExhaustedAt) &&
    Boolean(job.failureFolderInvalidationVersion) &&
    BigInt(folderInvalidationVersion) >
      BigInt(job.failureFolderInvalidationVersion ?? "0") &&
    Date.parse(job.nextAttemptAt) > now.getTime()
  );
}

function normalizeSegmentPlan(
  input: NarrationSegmentPlanItem[],
): NarrationSegmentPlanItem[] {
  if (!Array.isArray(input)) {
    throw new Error("Narration segment plan is required.");
  }

  const segments = input
    .map((segment) => {
      const segmentIndex = nonNegativeInteger(
        segment.segmentIndex,
        "Segment index",
      );
      const inputText = exactInputText(segment.inputText);
      const inputCodePoints = nonNegativeInteger(
        segment.inputCodePoints,
        "Segment input size",
      );

      if (Array.from(inputText).length !== inputCodePoints) {
        throw new Error("Segment input size does not match its text.");
      }
      if (typeof segment.unitMap === "undefined") {
        throw new Error("Segment unit map is required.");
      }
      stableJsonText(segment.unitMap, "Segment unit map");

      return {
        segmentIndex,
        inputText,
        inputSha256: requiredText(segment.inputSha256, "Segment input hash"),
        inputCodePoints,
        unitMap: segment.unitMap,
      };
    })
    .sort((left, right) => left.segmentIndex - right.segmentIndex);

  for (const [index, segment] of segments.entries()) {
    if (segment.segmentIndex !== index) {
      throw new Error("Narration segment indexes must be contiguous from zero.");
    }
  }

  return segments;
}

function normalizeFailureProgress(
  input?: NarrationSegmentFailureProgress,
): NarrationSegmentFailureProgress {
  if (!input) {
    return {};
  }

  const progress: NarrationSegmentFailureProgress = {};

  if (input.artifactKey !== undefined) {
    progress.artifactKey = requiredText(input.artifactKey, "Artifact key");
  }
  if (input.artifactVisibility !== undefined) {
    if (
      input.artifactVisibility !== "private" &&
      input.artifactVisibility !== "public"
    ) {
      throw new Error("Artifact visibility is invalid.");
    }
    progress.artifactVisibility = input.artifactVisibility;
  }
  if (input.contentType !== undefined) {
    progress.contentType = requiredText(input.contentType, "Content type");
  }
  if (input.byteLength !== undefined) {
    progress.byteLength = nonNegativeInteger(input.byteLength, "Byte length");
  }
  if (input.durationSeconds !== undefined) {
    progress.durationSeconds = nonNegativeNumber(
      input.durationSeconds,
      "Duration",
    );
  }
  if (input.alignmentModel !== undefined) {
    progress.alignmentModel = requiredText(
      input.alignmentModel,
      "Alignment model",
    );
  }
  if (input.transcriptSha256 !== undefined) {
    progress.transcriptSha256 = requiredText(
      input.transcriptSha256,
      "Transcript hash",
    );
  }
  if (input.qa !== undefined) {
    stableJsonText(input.qa, "Segment QA");
    progress.qa = input.qa;
  }
  if (input.alignment !== undefined) {
    stableJsonText(input.alignment, "Segment alignment");
    progress.alignment = input.alignment;
  }
  if (input.localSentenceCues !== undefined) {
    if (!Array.isArray(input.localSentenceCues)) {
      throw new Error("Local sentence cues must be an array.");
    }
    stableJsonText(input.localSentenceCues, "Local sentence cues");
    progress.localSentenceCues = input.localSentenceCues;
  }
  if (input.ttsCostUsd !== undefined) {
    progress.ttsCostUsd = costValue(input.ttsCostUsd);
  }
  if (input.alignmentCostUsd !== undefined) {
    progress.alignmentCostUsd = costValue(input.alignmentCostUsd);
  }
  if (input.diagnosticCostUsd !== undefined) {
    progress.diagnosticCostUsd = costValue(input.diagnosticCostUsd);
  }

  return progress;
}

function sameSegmentPlan(
  expected: NarrationSegmentPlanItem[],
  actual: StoredNarrationSegment[],
) {
  return expected.length === actual.length && expected.every((segment, index) => {
    const stored = actual[index];
    return (
      stored?.segmentIndex === segment.segmentIndex &&
      stored.inputText === segment.inputText &&
      stored.inputSha256 === segment.inputSha256 &&
      stored.inputCodePoints === segment.inputCodePoints &&
      stableJsonText(stored.unitMap, "Saved segment unit map") ===
        stableJsonText(segment.unitMap, "Segment unit map")
    );
  });
}

function stableJsonText(value: unknown, label: string) {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value, (_key, nested) => {
      if (
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return Object.fromEntries(
          Object.entries(nested as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right)),
        );
      }
      return nested;
    });
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }

  if (typeof serialized !== "string") {
    throw new Error(`${label} must be JSON-serializable.`);
  }

  return serialized;
}

function parseBlocks(value: ArticleBlock[] | string): ArticleBlock[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed as ArticleBlock[] : [];
}

function parseNarration(
  value: ArticleNarration | string | null,
): ArticleNarration | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object"
    ? parsed as ArticleNarration
    : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeOwnerEmail(ownerEmail: string) {
  const normalized = requiredText(ownerEmail, "Owner email").toLowerCase();
  return normalized;
}

function requiredText(value: string, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function exactInputText(value: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Segment input text is required.");
  }
  return value;
}

function bigintText(value: string, label: string) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function nonNegativeNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be non-negative.`);
  }
  return value;
}

function costValue(value: number) {
  return Math.round(nonNegativeNumber(value, "Cost") * 1_000_000) / 1_000_000;
}

function leaseExpiry(now: Date, requestedMs: number | undefined, defaultMs: number) {
  const milliseconds = Number.isFinite(requestedMs)
    ? Math.min(
        Math.max(Math.trunc(requestedMs ?? defaultMs), minimumLeaseMs),
        maximumLeaseMs,
      )
    : defaultMs;
  return new Date(now.getTime() + milliseconds).toISOString();
}

function retryIso(retryAt?: Date, now = new Date()) {
  const value = retryAt?.getTime();
  return new Date(
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(value, now.getTime())
      : now.getTime() + 60_000,
  ).toISOString();
}

function boundedError(error: string) {
  return requiredText(error, "Error message").slice(0, 2_000);
}

function isoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberValue(value: number | string) {
  return typeof value === "number" ? value : Number(value);
}
