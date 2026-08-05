export type IntegrationSyncResponse = {
  imported: number;
  deduplicated: number;
  reconciled: number;
  failed: number;
  skipped: number;
  remaining: number;
  possiblyTruncated?: boolean;
  failures?: Array<{
    externalId: string;
    title: string;
    error: string;
  }>;
  message?: string;
};

// Vercel Hobby functions have a 60-second ceiling. Provider imports include
// remote extraction and artifact archiving, so each request deliberately owns
// only one item. The browser may continue with a few sequential requests while
// preserving a responsive, resumable sync boundary.
export const integrationSyncRequestBatchSize = 1;
export const integrationSyncMaxRequests = 5;

export function mergeIntegrationSyncResponses(
  current: IntegrationSyncResponse | null,
  next: IntegrationSyncResponse,
): IntegrationSyncResponse {
  if (!current) {
    return {
      ...next,
      failures: [...(next.failures ?? [])],
    };
  }

  return {
    imported: current.imported + next.imported,
    deduplicated: current.deduplicated + next.deduplicated,
    reconciled: current.reconciled + next.reconciled,
    failed: current.failed + next.failed,
    // Each response reports the full already-resolved set, so summing would
    // count the same skipped records repeatedly.
    skipped: Math.max(current.skipped, next.skipped),
    remaining: next.remaining,
    possiblyTruncated:
      Boolean(current.possiblyTruncated) || Boolean(next.possiblyTruncated),
    failures: [...(current.failures ?? []), ...(next.failures ?? [])],
  };
}

export function shouldContinueIntegrationSync(
  result: IntegrationSyncResponse,
  completedRequests: number,
) {
  const attempted =
    result.imported +
    result.deduplicated +
    result.reconciled +
    result.failed;

  return (
    completedRequests < integrationSyncMaxRequests &&
    result.remaining > 0 &&
    attempted > 0
  );
}
