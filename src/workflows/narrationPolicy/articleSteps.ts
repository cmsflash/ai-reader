import { getStepMetadata } from "workflow";
import {
  ArticleNarrationSegmentError,
  assembleArticleNarration,
  generateArticleNarrationSegment,
  type GeneratedArticleNarrationSegment,
  type PersistedArticleNarrationSpeechArtifact,
} from "@/server/articles/articleNarrationGeneration";
import {
  prepareArticleNarration,
  type ArticleNarrationChunk,
  type ArticleNarrationChunkPart,
} from "@/server/articles/articleNarrationPlan";
import type {
  ArticleNarrationCost,
  ArticleNarrationProfile,
} from "@/server/articles/articleNarrationProfiles";
import type {
  NarrationSegmentFailureProgress,
  StoredNarrationJob,
  StoredNarrationSegment,
} from "@/server/ports/narrationPolicyRepository";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";
import { getNarrationPolicyRepository } from "@/server/runtime/narrationPolicyRepository";
import {
  narrationPolicyRecoveryCooldownMs,
  type NarrationPolicyArticleFailureAction,
  type NarrationPolicyArticleInput,
} from "@/workflows/narrationPolicy/contracts";

const narrationJobLeaseMs = 6 * 60 * 60_000;
const narrationSegmentLeaseMs = 30 * 60_000;

export type NarrationPolicySegmentReference = {
  segmentIndex: number;
  inputSha256: string;
};

export type ClaimedNarrationPolicyArticle = {
  kind: "claimed";
  ownerEmail: string;
  folderId: string;
  folderInvalidationVersion: string;
  articleId: string;
  jobId: string;
  jobAttemptId: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  generationFingerprint: string;
  profile: ArticleNarrationProfile;
  segments: NarrationPolicySegmentReference[];
};

export type NarrationPolicyArticleClaimResult =
  | ClaimedNarrationPolicyArticle
  | {
      kind: "cooldown";
      articleId: string;
      retryAt: string;
      error?: string;
    }
  | {
      kind: "busy";
      articleId: string;
      retryAt?: string;
      error?: string;
    }
  | {
      kind:
        | "already-complete"
        | "not-eligible"
        | "missing"
        | "stale"
        | "unsupported";
      articleId: string;
      error?: string;
    };

export type ClaimedNarrationPolicySegment = {
  kind: "claimed";
  segmentIndex: number;
  segmentAttemptId: string;
  generationAttempt: number;
  chunk: ArticleNarrationChunk;
  persistedSpeechArtifact?: PersistedArticleNarrationSpeechArtifact;
};

export type NarrationPolicySegmentClaimResult =
  | ClaimedNarrationPolicySegment
  | {
      kind:
        | "completed"
        | "busy"
        | "conflict"
        | "missing-job"
        | "not-eligible";
      segmentIndex: number;
      error?: string;
    };

export type NarrationPolicySegmentGenerationResult =
  | {
      kind: "generated";
      generated: GeneratedArticleNarrationSegment;
    }
  | {
      kind: "failed";
      error: string;
      errorCode: string;
      retryable: boolean;
      cost?: ArticleNarrationCost;
      progress?: NarrationSegmentFailureProgress;
    };

export type NarrationPolicySegmentSettlement = {
  segmentIndex: number;
  status: "completed" | "failed";
  retryable?: boolean;
  retryMode?: "segment" | "job";
  error?: string;
};

export type NarrationPolicyArticleFinalization =
  | {
      kind: "completed";
      articleId: string;
      segmentCount: number;
      costUsd: number;
    }
  | {
      kind: "not-eligible";
      articleId: string;
    }
  | {
      kind: "terminal";
      articleId: string;
      error: string;
    };

export async function prepareAndClaimNarrationPolicyArticle(
  input: NarrationPolicyArticleInput & { workflowRunId: string },
): Promise<NarrationPolicyArticleClaimResult> {
  "use step";

  const article = await getArticleRepository().findById(
    input.candidate.articleId,
    input.ownerEmail,
  );

  if (!article) {
    return { kind: "missing", articleId: input.candidate.articleId };
  }

  let prepared: ReturnType<typeof prepareArticleNarration>;

  try {
    prepared = prepareArticleNarration(article);
  } catch (error) {
    return {
      kind: "unsupported",
      articleId: input.candidate.articleId,
      error: errorMessage(error),
    };
  }

  if (
    prepared.sourceTextSha256 !== input.candidate.sourceTextSha256 ||
    prepared.sentenceMapFingerprint !==
      input.candidate.sentenceMapFingerprint
  ) {
    return {
      kind: "stale",
      articleId: input.candidate.articleId,
      error: "The article changed after folder selection.",
    };
  }

  const policyRepository = getNarrationPolicyRepository();
  const claim = await policyRepository.claimNarrationJob({
    ownerEmail: input.ownerEmail,
    articleId: article.id,
    folderId: input.folderId,
    folderInvalidationVersion: input.folderInvalidationVersion,
    sourceTextSha256: prepared.sourceTextSha256,
    sentenceMapFingerprint: prepared.sentenceMapFingerprint,
    generationFingerprint: prepared.generationFingerprint,
    language: prepared.profile.language,
    profileId: prepared.profile.id,
    profileVersion: String(prepared.profile.version),
    speechModel: prepared.profile.speechModel,
    voice: prepared.profile.voice,
    workflowRunId: input.workflowRunId,
    leaseMs: narrationJobLeaseMs,
  });

  if (claim.kind === "not-eligible") {
    return { kind: "not-eligible", articleId: article.id };
  }
  if (claim.kind === "cooldown") {
    await settleJobCost(policyRepository, input.ownerEmail, claim.job.id);
    return {
      kind: "cooldown",
      articleId: article.id,
      retryAt: claim.job.nextAttemptAt,
    };
  }
  if (claim.kind === "completed") {
    await settleJobCost(policyRepository, input.ownerEmail, claim.job.id);
    return { kind: "already-complete", articleId: article.id };
  }

  const recoveredAttemptId =
    claim.kind === "busy" &&
    claim.job.workflowRunId === input.workflowRunId
      ? claim.job.attemptId
      : undefined;

  if (
    claim.kind === "busy" &&
    !recoveredAttemptId &&
    !replacesActiveFolderInvalidation(
      input.folderInvalidationVersion,
      claim.job.selectionFolderInvalidationVersion,
    )
  ) {
    return { kind: "busy", articleId: article.id };
  }

  if (claim.kind === "busy" && !recoveredAttemptId) {
    const retryAt = narrationPolicyBusyRetryAt(claim.job);

    return {
      kind: "busy",
      articleId: article.id,
      ...(retryAt ? { retryAt } : {}),
    };
  }

  const job = claim.job;
  const jobAttemptId =
    claim.kind === "claimed" ? claim.attemptId : recoveredAttemptId;

  if (!jobAttemptId) {
    throw new Error("The narration article claim is missing its attempt.");
  }

  const savedSegments = await policyRepository.createNarrationSegmentPlan({
    ownerEmail: input.ownerEmail,
    jobId: job.id,
    jobAttemptId,
    segments: prepared.chunks.map((chunk) => ({
      segmentIndex: chunk.index,
      inputText: chunk.input,
      inputSha256: chunk.inputSha256,
      inputCodePoints: chunk.inputCodePoints,
      unitMap: {
        expectedComparableText: chunk.expectedComparableText,
        parts: chunk.parts,
      },
    })),
  });

  if (!savedSegments) {
    throw new Error("The narration segment plan could not be claimed.");
  }

  return {
    kind: "claimed",
    ownerEmail: input.ownerEmail,
    folderId: input.folderId,
    folderInvalidationVersion: input.folderInvalidationVersion,
    articleId: article.id,
    jobId: job.id,
    jobAttemptId,
    sourceTextSha256: prepared.sourceTextSha256,
    sentenceMapFingerprint: prepared.sentenceMapFingerprint,
    generationFingerprint: prepared.generationFingerprint,
    profile: prepared.profile,
    segments: prepared.chunks.map((chunk) => ({
      segmentIndex: chunk.index,
      inputSha256: chunk.inputSha256,
    })),
  };
}

export function replacesActiveFolderInvalidation(
  incomingVersion: string,
  activeVersion: string,
) {
  return BigInt(incomingVersion) > BigInt(activeVersion);
}

export function narrationPolicyBusyRetryAt(
  job: Pick<
    StoredNarrationJob,
    "status" | "leaseExpiresAt" | "nextAttemptAt"
  >,
) {
  if (job.status === "running") {
    return job.leaseExpiresAt;
  }
  if (job.status === "pending" || job.status === "failed") {
    return job.nextAttemptAt;
  }
  return undefined;
}

export async function claimNarrationPolicySegment(
  articleClaim: ClaimedNarrationPolicyArticle,
  segment: NarrationPolicySegmentReference,
): Promise<NarrationPolicySegmentClaimResult> {
  "use step";

  const policyRepository = getNarrationPolicyRepository();

  if (!(await articleRemainsEligible(articleClaim))) {
    await stopIneligibleNarrationJob(
      articleClaim,
      "The article is no longer in this folder's active newest ten.",
    );
    return {
      kind: "not-eligible",
      segmentIndex: segment.segmentIndex,
      error: "The article is no longer in this folder's active newest ten.",
    };
  }

  const renewed = await policyRepository.renewNarrationJobLease({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    attemptId: articleClaim.jobAttemptId,
    leaseMs: narrationJobLeaseMs,
  });

  if (!renewed) {
    return {
      kind: "busy",
      segmentIndex: segment.segmentIndex,
      error: "The narration article lease is no longer current.",
    };
  }

  const claim = await policyRepository.claimNarrationSegment({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    jobAttemptId: articleClaim.jobAttemptId,
    segmentIndex: segment.segmentIndex,
    inputSha256: segment.inputSha256,
    leaseMs: narrationSegmentLeaseMs,
  });

  if (
    claim.kind === "busy" &&
    claim.segment.jobAttemptId === articleClaim.jobAttemptId &&
    claim.segment.attemptId
  ) {
    const persistedSpeechArtifact = recoverableSpeechArtifact(claim.segment);

    return {
      kind: "claimed",
      segmentIndex: segment.segmentIndex,
      segmentAttemptId: claim.segment.attemptId,
      generationAttempt: claim.segment.attemptCount,
      chunk: chunkFromStoredSegment(claim.segment),
      ...(persistedSpeechArtifact ? { persistedSpeechArtifact } : {}),
    };
  }

  if (claim.kind !== "claimed") {
    return {
      kind: claim.kind,
      segmentIndex: segment.segmentIndex,
      ...(claim.kind === "busy"
        ? { error: "The narration segment is already being generated." }
        : {}),
    };
  }

  const persistedSpeechArtifact = recoverableSpeechArtifact(claim.segment);

  return {
    kind: "claimed",
    segmentIndex: segment.segmentIndex,
    segmentAttemptId: claim.attemptId,
    generationAttempt: claim.segment.attemptCount,
    chunk: chunkFromStoredSegment(claim.segment),
    ...(persistedSpeechArtifact ? { persistedSpeechArtifact } : {}),
  };
}

export async function generateNarrationPolicySegment(
  articleClaim: ClaimedNarrationPolicyArticle,
  segmentClaim: ClaimedNarrationPolicySegment,
): Promise<NarrationPolicySegmentGenerationResult> {
  "use step";

  const { stepId } = getStepMetadata();

  try {
    const generated = await generateArticleNarrationSegment(
      {
        articleId: articleClaim.articleId,
        generationFingerprint: articleClaim.generationFingerprint,
        profile: articleClaim.profile,
        chunk: segmentClaim.chunk,
        attempt: segmentClaim.generationAttempt,
        ...(segmentClaim.persistedSpeechArtifact
          ? {
              persistedSpeechArtifact: segmentClaim.persistedSpeechArtifact,
            }
          : {}),
      },
      {
        artifactStorage: getArtifactStorage(),
      },
    );

    return { kind: "generated", generated };
  } catch (error) {
    const narrationError =
      error instanceof ArticleNarrationSegmentError ? error : null;
    const cost = costFromError(narrationError);
    const progress = failureProgressFromError(
      narrationError,
      articleClaim.profile,
      cost,
    );

    console.error("Narration segment generation failed.", {
      stepId,
      jobId: articleClaim.jobId,
      segmentIndex: segmentClaim.segmentIndex,
      error: errorMessage(error),
    });

    return {
      kind: "failed",
      error: errorMessage(error),
      errorCode: narrationError?.code ?? "generation-failed",
      retryable: narrationError?.retryable ?? true,
      ...(cost ? { cost } : {}),
      ...(progress ? { progress } : {}),
    };
  }
}

generateNarrationPolicySegment.maxRetries = 0;

export async function settleNarrationPolicySegment(
  articleClaim: ClaimedNarrationPolicyArticle,
  segmentClaim: ClaimedNarrationPolicySegment,
  result: NarrationPolicySegmentGenerationResult,
): Promise<NarrationPolicySegmentSettlement> {
  "use step";

  const policyRepository = getNarrationPolicyRepository();

  if (result.kind === "generated") {
    const generated = result.generated;
    const completed = await policyRepository.completeNarrationSegment({
      ownerEmail: articleClaim.ownerEmail,
      jobId: articleClaim.jobId,
      jobAttemptId: articleClaim.jobAttemptId,
      segmentIndex: segmentClaim.segmentIndex,
      attemptId: segmentClaim.segmentAttemptId,
      inputSha256: segmentClaim.chunk.inputSha256,
      artifactKey: generated.artifactKey,
      artifactVisibility: generated.artifactVisibility,
      contentType: generated.contentType,
      byteLength: generated.byteLength,
      durationSeconds: generated.durationSeconds,
      alignmentModel: generated.alignmentModel,
      transcriptSha256: generated.transcriptSha256,
      qa: generated.qa,
      alignment: {
        model: generated.alignmentModel,
        transcriptSha256: generated.transcriptSha256,
        sentenceCues: generated.sentenceCues,
      },
      localSentenceCues: generated.sentenceCues,
      ttsCostUsd: generated.cost.speechUsd,
      alignmentCostUsd: generated.cost.alignmentUsd,
      diagnosticCostUsd: generated.cost.diagnosticTranscriptUsd,
    });

    if (completed) {
      return {
        segmentIndex: segmentClaim.segmentIndex,
        status: "completed",
      };
    }

    const existing = await completedSegment(
      articleClaim.ownerEmail,
      articleClaim.jobId,
      segmentClaim.segmentIndex,
      segmentClaim.chunk.inputSha256,
    );

    if (existing) {
      return {
        segmentIndex: segmentClaim.segmentIndex,
        status: "completed",
      };
    }

    await recordFailedAttemptCost(
      articleClaim,
      segmentClaim,
      generated.cost,
    );
    await failClaimedSegment(
      articleClaim,
      segmentClaim,
      "The generated segment lost its database claim before it was saved.",
    );

    return {
      segmentIndex: segmentClaim.segmentIndex,
      status: "failed",
      retryable: true,
      error: "The generated segment could not be saved.",
    };
  }

  if (result.cost) {
    await recordFailedAttemptCost(
      articleClaim,
      segmentClaim,
      result.cost,
    );
  }
  await failClaimedSegment(
    articleClaim,
    segmentClaim,
    result.error,
    result.progress,
  );

  const retryMode = narrationSegmentFailureRetryMode(
    result.errorCode,
    result.retryable,
  );

  return {
    segmentIndex: segmentClaim.segmentIndex,
    status: "failed",
    retryable: Boolean(retryMode),
    ...(retryMode ? { retryMode } : {}),
    error: result.error,
  };
}

export function narrationSegmentFailureIsRetryable(
  errorCode: string,
  upstreamRetryable: boolean,
) {
  return Boolean(
    narrationSegmentFailureRetryMode(errorCode, upstreamRetryable),
  );
}

export function narrationSegmentFailureRetryMode(
  errorCode: string,
  upstreamRetryable: boolean,
): "segment" | "job" | undefined {
  if (errorCode === "qa-failed") {
    return "segment";
  }
  if (errorCode === "alignment-retries-exhausted") {
    return "job";
  }
  if (upstreamRetryable && errorCode !== "artifact-storage") {
    return "job";
  }

  return undefined;
}

export async function failNarrationPolicySegmentAfterStepFailure(
  articleClaim: ClaimedNarrationPolicyArticle,
  segmentClaim: ClaimedNarrationPolicySegment,
  error: string,
) {
  "use step";

  return getNarrationPolicyRepository().failNarrationSegment({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    jobAttemptId: articleClaim.jobAttemptId,
    segmentIndex: segmentClaim.segmentIndex,
    attemptId: segmentClaim.segmentAttemptId,
    error,
    retryAt: new Date(),
  });
}

export async function finalizeNarrationPolicyArticle(
  articleClaim: ClaimedNarrationPolicyArticle,
): Promise<NarrationPolicyArticleFinalization> {
  "use step";

  const articleRepository = getArticleRepository();
  const policyRepository = getNarrationPolicyRepository();

  if (!(await articleRemainsEligible(articleClaim))) {
    await stopIneligibleNarrationJob(
      articleClaim,
      "The article left this folder's active newest ten before finalization.",
    );
    return {
      kind: "not-eligible",
      articleId: articleClaim.articleId,
    };
  }

  const article = await articleRepository.findById(
    articleClaim.articleId,
    articleClaim.ownerEmail,
  );

  if (!article) {
    await stopIneligibleNarrationJob(
      articleClaim,
      "The article disappeared before narration finalization.",
    );
    return {
      kind: "not-eligible",
      articleId: articleClaim.articleId,
    };
  }

  let prepared;

  try {
    prepared = prepareArticleNarration(article, {
      profile: articleClaim.profile,
    });
  } catch (error) {
    return {
      kind: "terminal",
      articleId: articleClaim.articleId,
      error: errorMessage(error),
    };
  }

  if (
    prepared.sourceTextSha256 !== articleClaim.sourceTextSha256 ||
    prepared.sentenceMapFingerprint !==
      articleClaim.sentenceMapFingerprint ||
    prepared.generationFingerprint !== articleClaim.generationFingerprint
  ) {
    return {
      kind: "terminal",
      articleId: articleClaim.articleId,
      error: "The article changed before narration finalization.",
    };
  }

  const storedSegments = await policyRepository.listNarrationSegments(
    articleClaim.ownerEmail,
    articleClaim.jobId,
  );
  let generatedSegments: GeneratedArticleNarrationSegment[];
  let assembled: ReturnType<typeof assembleArticleNarration>;

  try {
    generatedSegments = storedSegments.map((segment) =>
      generatedSegmentFromStored(
        segment,
        prepared.profile,
        prepared.generationFingerprint,
      ),
    );
    assembled = assembleArticleNarration(prepared, generatedSegments);
  } catch (error) {
    return {
      kind: "terminal",
      articleId: articleClaim.articleId,
      error: errorMessage(error),
    };
  }
  const job = await policyRepository.findNarrationJob(
    articleClaim.ownerEmail,
    articleClaim.articleId,
    articleClaim.generationFingerprint,
  );

  if (job?.status === "completed") {
    if (
      article.narration?.generationFingerprint !==
      articleClaim.generationFingerprint
    ) {
      return {
        kind: "terminal",
        articleId: articleClaim.articleId,
        error: "The completed narration job is missing its attached narration.",
      };
    }

    await settleJobCost(
      policyRepository,
      articleClaim.ownerEmail,
      articleClaim.jobId,
    );
    return {
      kind: "completed",
      articleId: articleClaim.articleId,
      segmentCount: generatedSegments.length,
      costUsd: job.actualCostUsd,
    };
  }

  requireCurrentJobClaim(job, articleClaim);

  if (
    article.narration?.generationFingerprint !==
    articleClaim.generationFingerprint
  ) {
    const updated = await articleRepository.updateNarration(
      articleClaim.articleId,
      articleClaim.ownerEmail,
      assembled.narration,
      0,
    );

    if (!updated) {
      throw new Error("The completed narration could not be attached.");
    }
  }

  const completed = await policyRepository.completeNarrationJob({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    attemptId: articleClaim.jobAttemptId,
    sourceTextSha256: articleClaim.sourceTextSha256,
    generationFingerprint: articleClaim.generationFingerprint,
  });

  if (!completed) {
    const existing = await policyRepository.findNarrationJob(
      articleClaim.ownerEmail,
      articleClaim.articleId,
      articleClaim.generationFingerprint,
    );

    if (existing?.status !== "completed") {
      throw new Error("The narration job lost its claim during finalization.");
    }
  }

  await settleJobCost(
    policyRepository,
    articleClaim.ownerEmail,
    articleClaim.jobId,
  );

  return {
    kind: "completed",
    articleId: articleClaim.articleId,
    segmentCount: generatedSegments.length,
    costUsd: job.actualCostUsd,
  };
}

async function articleRemainsEligible(
  articleClaim: ClaimedNarrationPolicyArticle,
) {
  return getNarrationPolicyRepository().isNarrationCandidateEligible({
    ownerEmail: articleClaim.ownerEmail,
    folderId: articleClaim.folderId,
    articleId: articleClaim.articleId,
    sourceTextSha256: articleClaim.sourceTextSha256,
    sentenceMapFingerprint: articleClaim.sentenceMapFingerprint,
  });
}

async function stopIneligibleNarrationJob(
  articleClaim: ClaimedNarrationPolicyArticle,
  reason: string,
) {
  const repository = getNarrationPolicyRepository();
  const job = await repository.findNarrationJob(
    articleClaim.ownerEmail,
    articleClaim.articleId,
    articleClaim.generationFingerprint,
  );
  const hasUnsettledCost = narrationJobHasUnsettledCost(job);

  if (hasUnsettledCost) {
    const exhausted = await repository.failNarrationJob({
      ownerEmail: articleClaim.ownerEmail,
      jobId: articleClaim.jobId,
      attemptId: articleClaim.jobAttemptId,
      error: reason,
      failureKind: "transient",
      cycleExhausted: true,
      retryAt: new Date(Date.now() + narrationPolicyRecoveryCooldownMs),
    });
    const parkedJob =
      exhausted ??
      (await repository.findNarrationJob(
        articleClaim.ownerEmail,
        articleClaim.articleId,
        articleClaim.generationFingerprint,
      ));

    if (
      parkedJob?.status !== "failed" ||
      parkedJob.failureKind !== "transient" ||
      !parkedJob.cycleExhaustedAt
    ) {
      throw new Error(
        "The ineligible narration job could not be parked safely.",
      );
    }

    await settleJobCost(
      repository,
      articleClaim.ownerEmail,
      articleClaim.jobId,
    );
    return;
  }

  const released = await repository.releaseNarrationJob({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    attemptId: articleClaim.jobAttemptId,
  });

  if (!released && job?.status === "running") {
    throw new Error("The ineligible narration job could not be released.");
  }
}

export function narrationJobHasUnsettledCost(
  job:
    | Pick<StoredNarrationJob, "actualCostUsd" | "articleCostRecordedUsd">
    | null,
) {
  return Boolean(job && job.actualCostUsd > job.articleCostRecordedUsd);
}

export async function finishNarrationPolicyArticle(
  articleClaim: ClaimedNarrationPolicyArticle,
  error: string,
  action: NarrationPolicyArticleFailureAction,
) {
  "use step";

  const repository = getNarrationPolicyRepository();
  let finished: StoredNarrationJob | null;

  if (action === "cancel") {
    finished = await repository.cancelNarrationJob({
      ownerEmail: articleClaim.ownerEmail,
      jobId: articleClaim.jobId,
      attemptId: articleClaim.jobAttemptId,
      reason: error,
    });
  } else {
    finished = await repository.failNarrationJob({
      ownerEmail: articleClaim.ownerEmail,
      jobId: articleClaim.jobId,
      attemptId: articleClaim.jobAttemptId,
      error,
      failureKind: "transient",
      cycleExhausted: action === "cooldown",
      retryAt:
        action === "cooldown"
          ? new Date(Date.now() + narrationPolicyRecoveryCooldownMs)
          : new Date(),
    });
  }

  if (finished) {
    return finished;
  }

  const existing = await repository.findNarrationJob(
    articleClaim.ownerEmail,
    articleClaim.articleId,
    articleClaim.generationFingerprint,
  );
  const replayMatches =
    (action === "cancel" && existing?.status === "cancelled") ||
    (action === "retry-now" &&
      existing?.status === "failed" &&
      existing.failureKind === "transient" &&
      !existing.cycleExhaustedAt) ||
    (action === "cooldown" &&
      existing?.status === "failed" &&
      existing.failureKind === "transient" &&
      Boolean(existing.cycleExhaustedAt));

  if (!replayMatches || !existing) {
    throw new Error("The narration job could not record its failure state.");
  }

  return existing;
}

export async function settleNarrationPolicyArticleCost(
  articleClaim: ClaimedNarrationPolicyArticle,
) {
  "use step";

  return settleJobCost(
    getNarrationPolicyRepository(),
    articleClaim.ownerEmail,
    articleClaim.jobId,
  );
}

export function recoverableSpeechArtifact(
  segment: StoredNarrationSegment,
): PersistedArticleNarrationSpeechArtifact | undefined {
  if (
    typeof segment.qa !== "undefined" ||
    !segment.artifactKey?.trim() ||
    segment.artifactVisibility !== "public" ||
    !segment.contentType?.toLowerCase().startsWith("audio/") ||
    !Number.isSafeInteger(segment.byteLength) ||
    (segment.byteLength ?? 0) <= 0
  ) {
    return undefined;
  }

  return {
    artifactKey: segment.artifactKey,
    artifactVisibility: "public",
    contentType: segment.contentType,
    byteLength: segment.byteLength as number,
  };
}

function chunkFromStoredSegment(
  segment: StoredNarrationSegment,
): ArticleNarrationChunk {
  const unitMap = segment.unitMap;

  if (!unitMap || typeof unitMap !== "object") {
    throw new Error("The narration segment unit map is missing.");
  }

  const value = unitMap as {
    expectedComparableText?: unknown;
    parts?: unknown;
  };

  if (
    typeof value.expectedComparableText !== "string" ||
    value.expectedComparableText.length === 0 ||
    !Array.isArray(value.parts)
  ) {
    throw new Error("The narration segment unit map is invalid.");
  }

  return {
    index: segment.segmentIndex,
    input: segment.inputText,
    inputCodePoints: segment.inputCodePoints,
    inputSha256: segment.inputSha256,
    expectedComparableText: value.expectedComparableText,
    parts: value.parts as ArticleNarrationChunkPart[],
  };
}

function generatedSegmentFromStored(
  segment: StoredNarrationSegment,
  profile: ArticleNarrationProfile,
  generationFingerprint: string,
): GeneratedArticleNarrationSegment {
  if (
    segment.status !== "completed" ||
    !segment.artifactKey ||
    segment.artifactVisibility !== "public" ||
    !segment.contentType ||
    segment.byteLength === undefined ||
    segment.durationSeconds === undefined ||
    !segment.alignmentModel ||
    !segment.transcriptSha256 ||
    !segment.completedAt ||
    !isNarrationQa(segment.qa) ||
    !Array.isArray(segment.localSentenceCues)
  ) {
    throw new Error(
      `Narration segment ${segment.segmentIndex} is not complete.`,
    );
  }

  return {
    index: segment.segmentIndex,
    inputSha256: segment.inputSha256,
    inputCodePoints: segment.inputCodePoints,
    generationFingerprint,
    profileId: profile.id,
    speechModel: profile.speechModel,
    voice: profile.voice,
    alignmentModel: segment.alignmentModel,
    artifactKey: segment.artifactKey,
    artifactVisibility: segment.artifactVisibility,
    contentType: segment.contentType,
    byteLength: segment.byteLength,
    durationSeconds: segment.durationSeconds,
    transcriptSha256: segment.transcriptSha256,
    sentenceCues: segment.localSentenceCues,
    qa: segment.qa,
    cost: {
      speechUsd: segment.ttsCostUsd,
      alignmentUsd: segment.alignmentCostUsd,
      diagnosticTranscriptUsd: segment.diagnosticCostUsd,
      totalUsd: roundCost(
        segment.ttsCostUsd +
          segment.alignmentCostUsd +
          segment.diagnosticCostUsd,
      ),
    },
    generatedAt: segment.completedAt,
  };
}

function isNarrationQa(
  value: unknown,
): value is GeneratedArticleNarrationSegment["qa"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const qa = value as Record<string, unknown>;
  return (
    qa.ok === true &&
    typeof qa.expectedCharacters === "number" &&
    typeof qa.transcriptCharacters === "number" &&
    typeof qa.sourceCoverage === "number" &&
    typeof qa.exactMatchRatio === "number" &&
    typeof qa.maxUnmatchedSourceRun === "number" &&
    typeof qa.maxUnmatchedTranscriptRun === "number" &&
    typeof qa.firstAnchorExactRatio === "number" &&
    typeof qa.lastAnchorExactRatio === "number" &&
    Array.isArray(qa.forbiddenQuoteMarkers) &&
    Array.isArray(qa.failures)
  );
}

async function completedSegment(
  ownerEmail: string,
  jobId: string,
  segmentIndex: number,
  inputSha256: string,
) {
  const segments = await getNarrationPolicyRepository()
    .listNarrationSegments(ownerEmail, jobId);
  return segments.find(
    (segment) =>
      segment.segmentIndex === segmentIndex &&
      segment.inputSha256 === inputSha256 &&
      segment.status === "completed",
  );
}

async function recordFailedAttemptCost(
  articleClaim: ClaimedNarrationPolicyArticle,
  segmentClaim: ClaimedNarrationPolicySegment,
  cost: ArticleNarrationCost,
) {
  await getNarrationPolicyRepository().recordNarrationJobCost({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    attemptId: articleClaim.jobAttemptId,
    eventId:
      `failed-segment:${segmentClaim.segmentIndex}:` +
      segmentClaim.segmentAttemptId,
    costUsd: cost.totalUsd,
  });
}

async function failClaimedSegment(
  articleClaim: ClaimedNarrationPolicyArticle,
  segmentClaim: ClaimedNarrationPolicySegment,
  error: string,
  progress?: NarrationSegmentFailureProgress,
) {
  await getNarrationPolicyRepository().failNarrationSegment({
    ownerEmail: articleClaim.ownerEmail,
    jobId: articleClaim.jobId,
    jobAttemptId: articleClaim.jobAttemptId,
    segmentIndex: segmentClaim.segmentIndex,
    attemptId: segmentClaim.segmentAttemptId,
    error,
    retryAt: new Date(),
    progress,
  });
}

function requireCurrentJobClaim(
  job: StoredNarrationJob | null,
  articleClaim: ClaimedNarrationPolicyArticle,
): asserts job is StoredNarrationJob {
  if (
    !job ||
    job.status !== "running" ||
    job.id !== articleClaim.jobId ||
    job.attemptId !== articleClaim.jobAttemptId
  ) {
    throw new Error("The narration job claim is no longer current.");
  }
}

async function settleJobCost(
  repository: ReturnType<typeof getNarrationPolicyRepository>,
  ownerEmail: string,
  jobId: string,
) {
  const settlement = await repository.settleNarrationJobCost(
    ownerEmail,
    jobId,
  );

  if (!settlement) {
    throw new Error("The narration job cost could not be settled.");
  }

  return settlement;
}

function costFromError(error: ArticleNarrationSegmentError | null) {
  const candidate = error?.details?.cost;

  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const cost = candidate as Partial<ArticleNarrationCost>;
  return typeof cost.speechUsd === "number" &&
    typeof cost.alignmentUsd === "number" &&
    typeof cost.diagnosticTranscriptUsd === "number" &&
    typeof cost.totalUsd === "number"
    ? (cost as ArticleNarrationCost)
    : undefined;
}

function failureProgressFromError(
  error: ArticleNarrationSegmentError | null,
  profile: ArticleNarrationProfile,
  cost?: ArticleNarrationCost,
): NarrationSegmentFailureProgress | undefined {
  const details = error?.details;

  if (!details) {
    return undefined;
  }

  const progress: NarrationSegmentFailureProgress = {};
  const artifactVisibility = details.artifactVisibility;
  const cues = Array.isArray(details.sentenceCues)
    ? details.sentenceCues.filter(isNarrationCue)
    : undefined;

  if (typeof details.artifactKey === "string") {
    progress.artifactKey = details.artifactKey;
  }
  if (
    artifactVisibility === "public" ||
    artifactVisibility === "private"
  ) {
    progress.artifactVisibility = artifactVisibility;
  }
  if (typeof details.contentType === "string") {
    progress.contentType = details.contentType;
  }
  if (
    typeof details.byteLength === "number" &&
    Number.isSafeInteger(details.byteLength) &&
    details.byteLength >= 0
  ) {
    progress.byteLength = details.byteLength;
  }
  if (
    typeof details.durationSeconds === "number" &&
    Number.isFinite(details.durationSeconds) &&
    details.durationSeconds > 0
  ) {
    progress.durationSeconds = details.durationSeconds;
  }
  if (typeof details.transcriptSha256 === "string") {
    progress.transcriptSha256 = details.transcriptSha256;
  }
  if (details.qa && typeof details.qa === "object") {
    progress.qa = details.qa;
    progress.alignmentModel = profile.transcriptionModel;
    progress.alignment = {
      model: profile.transcriptionModel,
      transcriptSha256: progress.transcriptSha256,
      qa: details.qa,
      sentenceCues: cues ?? [],
    };
  }
  if (cues) {
    progress.localSentenceCues = cues;
  }
  if (cost) {
    progress.ttsCostUsd = cost.speechUsd;
    progress.alignmentCostUsd = cost.alignmentUsd;
    progress.diagnosticCostUsd = cost.diagnosticTranscriptUsd;
  }

  return Object.keys(progress).length > 0 ? progress : undefined;
}

function isNarrationCue(
  value: unknown,
): value is GeneratedArticleNarrationSegment["sentenceCues"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cue = value as Record<string, unknown>;
  return (
    typeof cue.sentenceIndex === "number" &&
    typeof cue.sentenceText === "string" &&
    typeof cue.startSeconds === "number" &&
    typeof cue.endSeconds === "number"
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Narration generation failed.";
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
