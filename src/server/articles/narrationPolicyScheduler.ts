import { start } from "workflow/api";
import { getNarrationPolicyRepository } from "@/server/runtime/narrationPolicyRepository";
import { reconcileNarrationPolicyForOwner } from "@/workflows/narrationPolicy/workflows";

export type NarrationPolicyMembership = {
  folderId?: string | null;
  archivedAt?: string | null;
};

type WorkflowRunReference = {
  runId: string;
};

type NarrationPolicySchedulerDependencies = {
  requestFolder?: (
    ownerEmail: string,
    folderId: string,
  ) => Promise<unknown>;
  requestOwner?: (ownerEmail: string) => Promise<unknown>;
  hasPendingOwner?: (ownerEmail: string) => Promise<boolean>;
  startOwner?: (ownerEmail: string) => Promise<WorkflowRunReference>;
  reportError?: (error: unknown) => void;
};

export function narrationPolicyFolderIdsForMembershipChange(
  before?: NarrationPolicyMembership | null,
  after?: NarrationPolicyMembership | null,
) {
  const folderIds = new Set<string>();

  addActiveFolderId(folderIds, before);
  addActiveFolderId(folderIds, after);

  return [...folderIds];
}

export async function scheduleNarrationPolicyForFolders(
  ownerEmail: string,
  folderIds: Iterable<string>,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  const normalizedFolderIds = [
    ...new Set(
      [...folderIds]
        .map((folderId) => folderId.trim())
        .filter(Boolean),
    ),
  ];
  const requestFolder = dependencies.requestFolder ?? requestFolderReconciliation;

  await Promise.all(
    normalizedFolderIds.map((folderId) =>
      requestFolder(normalizedOwner, folderId),
    ),
  );

  if (normalizedFolderIds.length === 0) {
    return { folderIds: normalizedFolderIds, runId: null };
  }

  const run = await (dependencies.startOwner ?? startOwnerWorkflow)(
    normalizedOwner,
  );

  return { folderIds: normalizedFolderIds, runId: run.runId };
}

export async function scheduleNarrationPolicyForFoldersBestEffort(
  ownerEmail: string,
  folderIds: Iterable<string>,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  try {
    return await scheduleNarrationPolicyForFolders(
      ownerEmail,
      folderIds,
      dependencies,
    );
  } catch (error) {
    (dependencies.reportError ?? reportSchedulingError)(error);
    return { folderIds: [], runId: null };
  }
}

export async function scheduleNarrationPolicyForOwner(
  ownerEmail: string,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  await (
    dependencies.requestOwner ?? requestOwnerReconciliations
  )(normalizedOwner);
  const run = await (dependencies.startOwner ?? startOwnerWorkflow)(
    normalizedOwner,
  );

  return { runId: run.runId };
}

export async function scheduleNarrationPolicyForOwnerBestEffort(
  ownerEmail: string,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  try {
    return await scheduleNarrationPolicyForOwner(ownerEmail, dependencies);
  } catch (error) {
    (dependencies.reportError ?? reportSchedulingError)(error);
    return null;
  }
}

export async function wakeNarrationPolicyForOwner(
  ownerEmail: string,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  const hasPending = await (
    dependencies.hasPendingOwner ?? hasPendingOwnerReconciliations
  )(normalizedOwner);

  if (!hasPending) {
    return { pending: false, runId: null };
  }

  const run = await (dependencies.startOwner ?? startOwnerWorkflow)(
    normalizedOwner,
  );
  return { pending: true, runId: run.runId };
}

export async function wakeNarrationPolicyForOwnerBestEffort(
  ownerEmail: string,
  dependencies: NarrationPolicySchedulerDependencies = {},
) {
  try {
    return await wakeNarrationPolicyForOwner(ownerEmail, dependencies);
  } catch (error) {
    (dependencies.reportError ?? reportSchedulingError)(error);
    return { pending: false, runId: null };
  }
}

function addActiveFolderId(
  folderIds: Set<string>,
  membership?: NarrationPolicyMembership | null,
) {
  const folderId = membership?.folderId?.trim();

  if (folderId && !membership?.archivedAt) {
    folderIds.add(folderId);
  }
}

function normalizeOwnerEmail(ownerEmail: string) {
  const normalized = ownerEmail.trim().toLowerCase();

  if (!normalized) {
    throw new Error("Narration policy owner is required.");
  }

  return normalized;
}

async function requestFolderReconciliation(
  ownerEmail: string,
  folderId: string,
) {
  return getNarrationPolicyRepository().requestFolderReconciliation(
    ownerEmail,
    folderId,
  );
}

async function requestOwnerReconciliations(ownerEmail: string) {
  return getNarrationPolicyRepository().requestAllFolderReconciliations(
    ownerEmail,
  );
}

async function hasPendingOwnerReconciliations(ownerEmail: string) {
  return getNarrationPolicyRepository().hasPendingFolderReconciliations(
    ownerEmail,
  );
}

async function startOwnerWorkflow(ownerEmail: string) {
  return start(reconcileNarrationPolicyForOwner, [{ ownerEmail }]);
}

function reportSchedulingError(error: unknown) {
  console.error("Could not schedule narration policy reconciliation.", error);
}
