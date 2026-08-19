export const narrationPolicyArticleLimit = 10;
export const narrationPolicyDebounce = "5s";
export const narrationPolicyArticleDispatchSpacing = "20s";
export const narrationPolicyFailureRetryDelay = "65s";
export const narrationPolicyRecoveryCooldownMs = 24 * 60 * 60_000;
export const narrationPolicyBusyProbeDelays = [
  "65s",
  "2m",
  "4m",
  "8m",
  "15m",
] as const;
export const narrationPolicyMaximumFolderClaims = 100;
export const narrationPolicyMaximumBusyLeaseWaits = 3;
export const narrationPolicyMaximumJobAttemptsPerWorkflow = 2;
export const narrationPolicyMaximumPaidRetriesPerArticle = 1;

export function narrationPolicyBusyWaitAction(
  probeIndex: number,
  leaseWaits: number,
):
  | { kind: "probe"; delay: (typeof narrationPolicyBusyProbeDelays)[number] }
  | { kind: "lease" }
  | undefined {
  const probeDelay = narrationPolicyBusyProbeDelays[probeIndex];

  if (probeDelay) {
    return { kind: "probe", delay: probeDelay };
  }
  if (leaseWaits < narrationPolicyMaximumBusyLeaseWaits) {
    return { kind: "lease" };
  }
  return undefined;
}

export type NarrationPolicyFolderInput = {
  ownerEmail: string;
  folderId: string;
};

export type NarrationPolicyOwnerInput = {
  ownerEmail: string;
};

export type NarrationPolicyCandidate = {
  articleId: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
};

export type NarrationPolicyArticleInput = {
  ownerEmail: string;
  folderId: string;
  folderInvalidationVersion: string;
  candidate: NarrationPolicyCandidate;
};

export type NarrationPolicyArticleFailureKind = "transient" | "terminal";

export type NarrationPolicyArticleFailureAction =
  | "retry-now"
  | "cooldown"
  | "cancel";

export function narrationPolicyArticleFailureAction(
  failureKind: NarrationPolicyArticleFailureKind,
  retryNow: boolean,
): NarrationPolicyArticleFailureAction {
  if (failureKind === "terminal") {
    return "cancel";
  }

  return retryNow ? "retry-now" : "cooldown";
}

export type NarrationPolicyFolderClaim = {
  ownerEmail: string;
  folderId: string;
  claimToken: string;
  claimedVersion: string;
};

export type NarrationPolicyArticleResult = {
  articleId: string;
  status:
    | "scheduled"
    | "generated"
    | "already-complete"
    | "busy"
    | "skipped"
    | "failed";
  runId?: string;
  segmentCount?: number;
  estimatedCostUsd?: number;
  costUsd?: number;
  error?: string;
};

export type NarrationPolicyFolderResult = {
  folderId: string;
  selected: number;
  results: NarrationPolicyArticleResult[];
  error?: string;
};

export type NarrationPolicyOwnerResult = {
  folders: NarrationPolicyFolderResult[];
};
