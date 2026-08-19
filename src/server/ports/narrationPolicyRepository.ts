import type { ArticleNarration, ArticleNarrationCue } from "@/lib/types";

export type NarrationCandidateState =
  | "missing"
  | "stale-source"
  | "missing-alignment"
  | "stale-alignment"
  | "ready";

export type NarrationPolicyCandidate = {
  articleId: string;
  folderId: string;
  rank: number;
  createdAt: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  narrationState: NarrationCandidateState;
  narration?: ArticleNarration;
};

export type FolderReconciliation = {
  ownerEmail: string;
  folderId: string;
  requestedVersion: string;
  completedVersion: string;
  attemptCount: number;
  nextAttemptAt: string;
  lastError?: string;
  updatedAt: string;
};

export type FolderReconciliationClaim = FolderReconciliation & {
  claimToken: string;
  claimedVersion: string;
  leaseExpiresAt: string;
};

export type NarrationJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StoredNarrationJob = {
  id: string;
  ownerEmail: string;
  articleId: string;
  selectionFolderId: string;
  selectionRank: number;
  selectionFolderInvalidationVersion: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  generationFingerprint: string;
  language: string;
  profileId: string;
  profileVersion: string;
  speechModel: string;
  voice: string;
  status: NarrationJobStatus;
  attemptId?: string;
  workflowRunId?: string;
  leaseExpiresAt?: string;
  nextAttemptAt: string;
  attemptCount: number;
  cycleAttemptCount: number;
  retryCycle: number;
  failureKind?: "transient" | "terminal";
  cycleExhaustedAt?: string;
  failureFolderInvalidationVersion?: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  articleCostRecordedUsd: number;
  articleCostRecordedAt?: string;
  plannedSegmentCount?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ClaimNarrationJobInput = {
  ownerEmail: string;
  articleId: string;
  folderId: string;
  folderInvalidationVersion: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  generationFingerprint: string;
  language: string;
  profileId: string;
  profileVersion: string;
  speechModel: string;
  voice: string;
  estimatedCostUsd?: number;
  workflowRunId?: string;
  leaseMs?: number;
};

export type ClaimNarrationJobResult =
  | {
      kind: "claimed";
      job: StoredNarrationJob;
      attemptId: string;
    }
  | {
      kind: "completed" | "busy" | "cooldown";
      job: StoredNarrationJob;
    }
  | {
      kind: "not-eligible";
    };

export type NarrationSegmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type NarrationSegmentPlanItem = {
  segmentIndex: number;
  inputText: string;
  inputSha256: string;
  inputCodePoints: number;
  unitMap: unknown;
};

export type StoredNarrationSegment = NarrationSegmentPlanItem & {
  jobId: string;
  status: NarrationSegmentStatus;
  attemptId?: string;
  jobAttemptId?: string;
  leaseExpiresAt?: string;
  nextAttemptAt: string;
  attemptCount: number;
  cycleAttemptCount: number;
  retryCycle: number;
  artifactKey?: string;
  artifactVisibility?: "private" | "public";
  contentType?: string;
  byteLength?: number;
  durationSeconds?: number;
  alignmentModel?: string;
  transcriptSha256?: string;
  qa?: unknown;
  alignment?: unknown;
  localSentenceCues?: ArticleNarrationCue[];
  ttsCostUsd: number;
  alignmentCostUsd: number;
  diagnosticCostUsd: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ClaimNarrationSegmentResult =
  | {
      kind: "claimed";
      segment: StoredNarrationSegment;
      attemptId: string;
    }
  | {
      kind: "completed" | "busy";
      segment: StoredNarrationSegment;
    }
  | {
      kind: "conflict" | "missing-job";
    };

export type NarrationSegmentFailureProgress = {
  artifactKey?: string;
  artifactVisibility?: "private" | "public";
  contentType?: string;
  byteLength?: number;
  durationSeconds?: number;
  alignmentModel?: string;
  transcriptSha256?: string;
  qa?: unknown;
  alignment?: unknown;
  localSentenceCues?: ArticleNarrationCue[];
  ttsCostUsd?: number;
  alignmentCostUsd?: number;
  diagnosticCostUsd?: number;
};

export interface NarrationPolicyRepository {
  listActiveFolderIds(ownerEmail: string): Promise<string[]>;
  hasPendingFolderReconciliations(ownerEmail: string): Promise<boolean>;
  requestFolderReconciliation(
    ownerEmail: string,
    folderId: string,
  ): Promise<FolderReconciliation | null>;
  requestAllFolderReconciliations(ownerEmail: string): Promise<number>;
  claimNextFolderReconciliation(input: {
    ownerEmail?: string;
    leaseMs?: number;
  }): Promise<FolderReconciliationClaim | null>;
  completeFolderReconciliation(input: {
    ownerEmail: string;
    folderId: string;
    claimToken: string;
    claimedVersion: string;
  }): Promise<boolean>;
  failFolderReconciliation(input: {
    ownerEmail: string;
    folderId: string;
    claimToken: string;
    error: string;
    retryAt?: Date;
  }): Promise<boolean>;
  listNewestNarrationCandidates(
    ownerEmail: string,
    folderId: string,
  ): Promise<NarrationPolicyCandidate[]>;
  isNarrationCandidateEligible(input: {
    ownerEmail: string;
    folderId: string;
    articleId: string;
    sourceTextSha256: string;
    sentenceMapFingerprint: string;
  }): Promise<boolean>;
  claimNarrationJob(
    input: ClaimNarrationJobInput,
  ): Promise<ClaimNarrationJobResult>;
  findNarrationJob(
    ownerEmail: string,
    articleId: string,
    generationFingerprint: string,
  ): Promise<StoredNarrationJob | null>;
  completeNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    sourceTextSha256: string;
    generationFingerprint: string;
  }): Promise<StoredNarrationJob | null>;
  renewNarrationJobLease(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    leaseMs?: number;
  }): Promise<StoredNarrationJob | null>;
  failNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    error: string;
    failureKind: "transient";
    cycleExhausted: boolean;
    retryAt?: Date;
  }): Promise<StoredNarrationJob | null>;
  releaseNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
  }): Promise<StoredNarrationJob | null>;
  cancelNarrationJob(input: {
    ownerEmail: string;
    jobId: string;
    attemptId?: string;
    reason?: string;
  }): Promise<StoredNarrationJob | null>;
  recordNarrationJobCost(input: {
    ownerEmail: string;
    jobId: string;
    attemptId: string;
    eventId: string;
    costUsd: number;
  }): Promise<{
    recorded: boolean;
    actualCostUsd: number;
  } | null>;
  settleNarrationJobCost(
    ownerEmail: string,
    jobId: string,
  ): Promise<{
    recorded: boolean;
    job: StoredNarrationJob;
  } | null>;
  createNarrationSegmentPlan(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segments: NarrationSegmentPlanItem[];
  }): Promise<StoredNarrationSegment[] | null>;
  listNarrationSegments(
    ownerEmail: string,
    jobId: string,
  ): Promise<StoredNarrationSegment[]>;
  findNarrationSegment(
    ownerEmail: string,
    jobId: string,
    segmentIndex: number,
  ): Promise<StoredNarrationSegment | null>;
  claimNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    inputSha256: string;
    leaseMs?: number;
  }): Promise<ClaimNarrationSegmentResult>;
  completeNarrationSegment(input: {
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
    localSentenceCues: ArticleNarrationCue[];
    ttsCostUsd: number;
    alignmentCostUsd: number;
    diagnosticCostUsd: number;
  }): Promise<StoredNarrationSegment | null>;
  renewNarrationSegmentLease(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    leaseMs?: number;
  }): Promise<StoredNarrationSegment | null>;
  failNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
    error: string;
    retryAt?: Date;
    progress?: NarrationSegmentFailureProgress;
  }): Promise<StoredNarrationSegment | null>;
  releaseNarrationSegment(input: {
    ownerEmail: string;
    jobId: string;
    jobAttemptId: string;
    segmentIndex: number;
    attemptId: string;
  }): Promise<StoredNarrationSegment | null>;
}

export class NarrationPolicyPersistenceError extends Error {
  constructor(message = "Narration policy persistence is unavailable.") {
    super(message);
    this.name = "NarrationPolicyPersistenceError";
  }
}
