import { getWorkflowMetadata, sleep } from "workflow";
import {
  claimNarrationPolicySegment,
  failNarrationPolicySegmentAfterStepFailure,
  finalizeNarrationPolicyArticle,
  finishNarrationPolicyArticle,
  generateNarrationPolicySegment,
  prepareAndClaimNarrationPolicyArticle,
  settleNarrationPolicyArticleCost,
  settleNarrationPolicySegment,
} from "@/workflows/narrationPolicy/articleSteps";
import {
  narrationPolicyFailureRetryDelay,
  narrationPolicyArticleFailureAction,
  narrationPolicyBusyWaitAction,
  narrationPolicyMaximumJobAttemptsPerWorkflow,
  narrationPolicyMaximumPaidRetriesPerArticle,
  type NarrationPolicyArticleFailureKind,
  type NarrationPolicyArticleInput,
  type NarrationPolicyArticleResult,
} from "@/workflows/narrationPolicy/contracts";

export async function reconcileClaimedNarrationPolicyArticle(
  input: NarrationPolicyArticleInput,
): Promise<NarrationPolicyArticleResult> {
  "use workflow";

  const workflowRunId = getWorkflowMetadata().workflowRunId;
  let remainingPaidRetries = narrationPolicyMaximumPaidRetriesPerArticle;
  let lastError = "Narration generation failed.";
  let waitedForCooldown = false;
  let busyProbeIndex = 0;
  let busyLeaseWaits = 0;

  for (
    let jobAttempt = 0;
    jobAttempt < narrationPolicyMaximumJobAttemptsPerWorkflow;
    jobAttempt += 1
  ) {
    let claim = await prepareAndClaimNarrationPolicyArticle({
      ...input,
      workflowRunId,
    });

    while (true) {
      if (claim.kind === "busy" && claim.retryAt) {
        const waitAction = narrationPolicyBusyWaitAction(
          busyProbeIndex,
          busyLeaseWaits,
        );

        if (waitAction?.kind === "probe") {
          busyProbeIndex += 1;
          await sleep(waitAction.delay);
        } else if (waitAction?.kind === "lease") {
          busyLeaseWaits += 1;
          await sleep(new Date(claim.retryAt));
        } else {
          break;
        }
      } else if (claim.kind === "cooldown" && !waitedForCooldown) {
        waitedForCooldown = true;
        await sleep(new Date(claim.retryAt));
      } else {
        break;
      }

      claim = await prepareAndClaimNarrationPolicyArticle({
        ...input,
        workflowRunId,
      });
    }

    if (claim.kind !== "claimed") {
      return {
        articleId: claim.articleId,
        status: claimStatus(claim.kind),
        ...(claim.error ? { error: claim.error } : {}),
      };
    }

    let retryJobAfterFailure = true;
    let failureKind: NarrationPolicyArticleFailureKind = "transient";

    try {
      for (const segment of claim.segments) {
        let completed = false;

        while (!completed) {
          const segmentClaim = await claimNarrationPolicySegment(
            claim,
            segment,
          );

          if (segmentClaim.kind === "completed") {
            completed = true;
            break;
          }
          if (segmentClaim.kind === "not-eligible") {
            return {
              articleId: claim.articleId,
              status: "skipped",
              error: segmentClaim.error,
            };
          }
          if (segmentClaim.kind !== "claimed") {
            retryJobAfterFailure = segmentClaim.kind === "busy";
            failureKind = retryJobAfterFailure ? "transient" : "terminal";
            throw new Error(
              segmentClaim.error ??
                `Narration segment ${segment.segmentIndex} could not be claimed (${segmentClaim.kind}).`,
            );
          }

          if (segmentClaim.generationAttempt > 1) {
            if (remainingPaidRetries === 0) {
              retryJobAfterFailure = false;
              failureKind = "transient";
              await failNarrationPolicySegmentAfterStepFailure(
                claim,
                segmentClaim,
                "The article's paid retry budget is exhausted.",
              );
              throw new Error(
                "The article's paid retry budget is exhausted.",
              );
            }

            remainingPaidRetries -= 1;
          }

          let generated;

          try {
            generated = await generateNarrationPolicySegment(
              claim,
              segmentClaim,
            );
          } catch (error) {
            await failNarrationPolicySegmentAfterStepFailure(
              claim,
              segmentClaim,
              workflowErrorMessage(error),
            );
            throw error;
          }
          const settled = await settleNarrationPolicySegment(
            claim,
            segmentClaim,
            generated,
          );

          if (settled.status === "completed") {
            completed = true;
            break;
          }

          if (settled.retryMode === "segment") {
            if (remainingPaidRetries > 0) {
              continue;
            }

            retryJobAfterFailure = false;
            failureKind = "terminal";
            throw new Error(
              settled.error ??
                `Narration segment ${segment.segmentIndex} failed.`,
            );
          }

          if (settled.retryable) {
            failureKind = "transient";
            retryJobAfterFailure = remainingPaidRetries > 0;
            throw new Error(
              settled.error ??
                `Narration segment ${segment.segmentIndex} needs a durable retry.`,
            );
          }

          retryJobAfterFailure = false;
          failureKind = "terminal";
          throw new Error(
            settled.error ??
              `Narration segment ${segment.segmentIndex} failed.`,
          );
        }

        if (!completed) {
          throw new Error(
            `Narration segment ${segment.segmentIndex} exhausted its paid attempts.`,
          );
        }
      }

      const finalized = await finalizeNarrationPolicyArticle(claim);

      if (finalized.kind === "not-eligible") {
        return {
          articleId: claim.articleId,
          status: "skipped",
          error: "The article left this folder's active newest ten.",
        };
      }
      if (finalized.kind === "terminal") {
        retryJobAfterFailure = false;
        failureKind = "terminal";
        throw new Error(finalized.error);
      }

      return {
        articleId: claim.articleId,
        status: "generated",
        segmentCount: finalized.segmentCount,
        costUsd: finalized.costUsd,
      };
    } catch (error) {
      lastError = workflowErrorMessage(error);
      const retryNow =
        failureKind === "transient" &&
        retryJobAfterFailure &&
        jobAttempt + 1 < narrationPolicyMaximumJobAttemptsPerWorkflow;
      const failureAction = narrationPolicyArticleFailureAction(
        failureKind,
        retryNow,
      );

      await finishNarrationPolicyArticle(
        claim,
        lastError,
        failureAction,
      );

      if (failureAction === "retry-now") {
        await sleep(narrationPolicyFailureRetryDelay);
        continue;
      }

      await settleNarrationPolicyArticleCost(claim);

      return {
        articleId: claim.articleId,
        status: "failed",
        error: lastError,
      };
    }
  }

  return {
    articleId: input.candidate.articleId,
    status: "failed",
    error: lastError,
  };
}

function claimStatus(
  kind:
    | "already-complete"
    | "busy"
    | "cooldown"
    | "not-eligible"
    | "missing"
    | "stale"
    | "unsupported",
): NarrationPolicyArticleResult["status"] {
  if (kind === "already-complete") {
    return "already-complete";
  }
  if (kind === "busy" || kind === "cooldown") {
    return "busy";
  }
  return "skipped";
}

function workflowErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Narration generation failed.";
}
