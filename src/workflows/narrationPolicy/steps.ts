import type { FolderReconciliationClaim } from "@/server/ports/narrationPolicyRepository";
import { getNarrationPolicyRepository } from "@/server/runtime/narrationPolicyRepository";
import { start } from "workflow/api";
import { reconcileClaimedNarrationPolicyArticle } from "@/workflows/narrationPolicy/article";
import type {
  NarrationPolicyCandidate,
  NarrationPolicyFolderClaim,
} from "@/workflows/narrationPolicy/contracts";

export async function claimNextNarrationPolicyFolder(
  ownerEmail: string,
): Promise<NarrationPolicyFolderClaim | null> {
  "use step";

  const claim = await getNarrationPolicyRepository()
    .claimNextFolderReconciliation({ ownerEmail });

  return claim ? publicFolderClaim(claim) : null;
}

export async function completeNarrationPolicyFolder(
  claim: NarrationPolicyFolderClaim,
) {
  "use step";

  return getNarrationPolicyRepository().completeFolderReconciliation({
    ownerEmail: claim.ownerEmail,
    folderId: claim.folderId,
    claimToken: claim.claimToken,
    claimedVersion: claim.claimedVersion,
  });
}

export async function failNarrationPolicyFolder(
  claim: NarrationPolicyFolderClaim,
  error: string,
) {
  "use step";

  return getNarrationPolicyRepository().failFolderReconciliation({
    ownerEmail: claim.ownerEmail,
    folderId: claim.folderId,
    claimToken: claim.claimToken,
    error,
  });
}

export async function listNarrationPolicyTopCandidates(
  ownerEmail: string,
  folderId: string,
  limit: number,
): Promise<NarrationPolicyCandidate[]> {
  "use step";

  const candidates = await getNarrationPolicyRepository()
    .listNewestNarrationCandidates(ownerEmail, folderId);

  return candidates
    .filter(({ narrationState }) => narrationState !== "ready")
    .slice(0, limit)
    .map(({
      articleId,
      sourceTextSha256,
      sentenceMapFingerprint,
    }) => ({
      articleId,
      sourceTextSha256,
      sentenceMapFingerprint,
    }));
}

export async function dispatchNarrationPolicyArticle(
  ownerEmail: string,
  folderId: string,
  folderInvalidationVersion: string,
  candidate: NarrationPolicyCandidate,
) {
  "use step";

  const run = await start(reconcileClaimedNarrationPolicyArticle, [
    { ownerEmail, folderId, folderInvalidationVersion, candidate },
  ]);

  return {
    articleId: candidate.articleId,
    status: "scheduled" as const,
    runId: run.runId,
  };
}

function publicFolderClaim(
  claim: FolderReconciliationClaim,
): NarrationPolicyFolderClaim {
  return {
    ownerEmail: claim.ownerEmail,
    folderId: claim.folderId,
    claimToken: claim.claimToken,
    claimedVersion: claim.claimedVersion,
  };
}
