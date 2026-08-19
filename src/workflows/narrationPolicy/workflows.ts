import { sleep } from "workflow";
import {
  claimNextNarrationPolicyFolder,
  completeNarrationPolicyFolder,
  dispatchNarrationPolicyArticle,
  failNarrationPolicyFolder,
  listNarrationPolicyTopCandidates,
} from "@/workflows/narrationPolicy/steps";
import {
  narrationPolicyArticleLimit,
  narrationPolicyArticleDispatchSpacing,
  narrationPolicyDebounce,
  narrationPolicyFailureRetryDelay,
  narrationPolicyMaximumFolderClaims,
  type NarrationPolicyFolderClaim,
  type NarrationPolicyFolderResult,
  type NarrationPolicyOwnerInput,
  type NarrationPolicyOwnerResult,
} from "@/workflows/narrationPolicy/contracts";

async function reconcileClaimedNarrationPolicyFolder(
  claim: NarrationPolicyFolderClaim,
): Promise<NarrationPolicyFolderResult> {
  "use workflow";

  const candidates = await listNarrationPolicyTopCandidates(
    claim.ownerEmail,
    claim.folderId,
    narrationPolicyArticleLimit,
  );
  const results = [];

  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) {
      await sleep(narrationPolicyArticleDispatchSpacing);
    }

    results.push(
      await dispatchNarrationPolicyArticle(
        claim.ownerEmail,
        claim.folderId,
        claim.claimedVersion,
        candidate,
      ),
    );
  }

  return {
    folderId: claim.folderId,
    selected: candidates.length,
    results,
  };
}

export async function reconcileNarrationPolicyForOwner(
  input: NarrationPolicyOwnerInput,
): Promise<NarrationPolicyOwnerResult> {
  "use workflow";

  await sleep(narrationPolicyDebounce);
  const folders = [];

  for (
    let claimCount = 0;
    claimCount < narrationPolicyMaximumFolderClaims;
    claimCount += 1
  ) {
    const claim = await claimNextNarrationPolicyFolder(input.ownerEmail);

    if (!claim) {
      break;
    }

    try {
      const result = await reconcileClaimedNarrationPolicyFolder(claim);
      await completeNarrationPolicyFolder(claim);
      folders.push(result);
    } catch (error) {
      const message = workflowErrorMessage(error);
      await failNarrationPolicyFolder(claim, message);
      folders.push({
        folderId: claim.folderId,
        selected: 0,
        results: [],
        error: message,
      });
      await sleep(narrationPolicyFailureRetryDelay);
    }
  }

  return { folders };
}

function workflowErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Narration policy reconciliation failed.";
}
