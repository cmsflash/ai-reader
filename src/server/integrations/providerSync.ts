import {
  deleteSavedArticleIfUnreferenced,
  getSavedArticle,
  importFileArticle,
  importHtmlArticle,
  importUrlArticle,
} from "@/server/articles/articleService";
import {
  ArticleDeduplicationIndex,
  type ArticleDeduplicationReason,
} from "@/server/articles/articleDeduplication";
import type { Article } from "@/lib/types";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import {
  createDropboxReadClient,
  type DropboxFileMetadata,
} from "@/server/integrations/dropboxClient";
import {
  articleIdForImport,
  claimImport,
  clearImportCleanupArticle,
  hasActiveImportReference,
  isImportRecordClaimable,
  listImportRecords,
  markImportCompletedReconciled,
  markImportFailed,
  type ExternalImportRecord,
} from "@/server/integrations/importRecords";
import {
  createInstapaperClient,
  InstapaperApiError,
  type InstapaperBookmark,
  type InstapaperBookmarkListInput,
  type InstapaperClient,
} from "@/server/integrations/instapaperClient";
import { withProviderSyncLock } from "@/server/integrations/providerSyncLock";

const INSTAPAPER_PROVIDER = "instapaper";
const DROPBOX_PROVIDER = "dropbox-atvoice";
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 10;

export type ProviderSyncResult = {
  imported: number;
  deduplicated: number;
  reconciled: number;
  failed: number;
  skipped: number;
  remaining: number;
  possiblyTruncated?: boolean;
  importedArticles: Array<{
    id: string;
    title: string;
  }>;
  deduplicatedArticles: Array<{
    id: string;
    title: string;
    externalId: string;
    reason: ArticleDeduplicationReason;
    similarity: number;
  }>;
  reconciledArticles: Array<{
    id: string;
    title: string;
    externalId: string;
  }>;
  failures: Array<{
    externalId: string;
    title: string;
    error: string;
  }>;
  message: string;
};

type ProviderImportOutcome = {
  article: Article;
  created: boolean;
  deduplicated: boolean;
  deduplicationReason?: ArticleDeduplicationReason;
  deduplicationSimilarity?: number;
  importSourceUrl?: string;
};

type InstapaperSyncInput = {
  ownerEmail: string;
  folder: InstapaperBookmarkListInput["folderId"];
  batchSize?: number;
};

type DropboxSyncInput = {
  ownerEmail: string;
  batchSize?: number;
};

export function syncInstapaperArticles(
  input: InstapaperSyncInput,
): Promise<ProviderSyncResult> {
  return withProviderSyncLock(input.ownerEmail, () =>
    syncInstapaperArticlesUnlocked(input),
  );
}

async function syncInstapaperArticlesUnlocked(
  input: InstapaperSyncInput,
): Promise<ProviderSyncResult> {
  const batchSize = normalizeBatchSize(input.batchSize);
  const client = createInstapaperClient();
  const listing = await client.listBookmarks({
    folderId: input.folder,
    limit: 500,
  });
  const records = await listImportRecords(input.ownerEmail, INSTAPAPER_PROVIDER);
  await retryPendingCleanup(input.ownerEmail, records);
  const deduplication = new ArticleDeduplicationIndex(
    await getArticleRepository().listDeduplicationCandidates(input.ownerEmail),
  );
  const recordByExternalId = importRecordMap(records);
  const candidates = listing.bookmarks
    .map((bookmark, index) => ({
      bookmark,
      index,
      sourceHash: instapaperSourceHash(bookmark),
      record: recordByExternalId.get(String(bookmark.bookmark_id)),
    }))
    .filter((candidate) =>
      isImportRecordClaimable(candidate.record, candidate.sourceHash),
    )
    .sort(compareImportCandidates);
  const importedArticles: ProviderSyncResult["importedArticles"] = [];
  const deduplicatedArticles: ProviderSyncResult["deduplicatedArticles"] = [];
  const reconciledArticles: ProviderSyncResult["reconciledArticles"] = [];
  const failures: ProviderSyncResult["failures"] = [];
  let claimed = 0;
  let claimConflicts = 0;

  for (const candidate of candidates) {
    if (claimed >= batchSize) {
      break;
    }

    const { bookmark, sourceHash } = candidate;
    const externalId = String(bookmark.bookmark_id);
    const claim = await claimImport({
      ownerEmail: input.ownerEmail,
      provider: INSTAPAPER_PROVIDER,
      externalId,
      sourceHash,
      sourceTitle: bookmark.title || undefined,
      sourceUrl: bookmark.url,
      metadata: {
        folder: String(input.folder ?? "unread"),
        progress: bookmark.progress,
        starred: bookmark.starred,
        tags: bookmark.tags.map((tag) => tag.name),
        savedAt: bookmark.time,
      },
    });

    if (!claim?.attemptId) {
      claimConflicts += 1;
      continue;
    }

    claimed += 1;
    const articleId = articleIdForImport(
      input.ownerEmail,
      INSTAPAPER_PROVIDER,
      externalId,
      sourceHash,
    );

    let finalized:
      | {
          imported: ProviderImportOutcome;
          completed: ExternalImportRecord;
        }
      | undefined;

    try {
      const imported = await importInstapaperBookmark(
        client,
        bookmark,
        input.ownerEmail,
        articleId,
        deduplication,
        candidate.record?.articleId,
      );

      const completed = await markImportCompletedReconciled(
        input.ownerEmail,
        INSTAPAPER_PROVIDER,
        externalId,
        imported.article.id,
        claim.attemptId,
        completionDetails(imported),
      );

      if (!completed) {
        throw new Error("The Instapaper import lease expired before completion.");
      }

      finalized = { imported, completed };
    } catch (error) {
      await markImportFailed(
        input.ownerEmail,
        INSTAPAPER_PROVIDER,
        externalId,
        error,
        claim.attemptId,
      ).catch(() => null);
      failures.push({
        externalId,
        title: bookmark.title || bookmark.url,
        error: messageFromError(error),
      });
      continue;
    }

    await cleanupReplacedArticle(
      input.ownerEmail,
      finalized.completed,
    ).catch(() => undefined);
    collectImportOutcome({
      imported: finalized.imported,
      externalId,
      importedArticles,
      deduplicatedArticles,
      reconciledArticles,
    });
  }

  return syncResult({
    importedArticles,
    deduplicatedArticles,
    reconciledArticles,
    failures,
    skipped: listing.bookmarks.length - candidates.length + claimConflicts,
    remaining: remainingCandidateCount(
      candidates.length,
      importedArticles.length,
      deduplicatedArticles.length,
      reconciledArticles.length,
    ),
    providerLabel: "Instapaper",
    possiblyTruncated: listing.bookmarks.length >= 500,
  });
}

export function syncDropboxAtVoiceArticles(
  input: DropboxSyncInput,
): Promise<ProviderSyncResult> {
  return withProviderSyncLock(input.ownerEmail, () =>
    syncDropboxAtVoiceArticlesUnlocked(input),
  );
}

async function syncDropboxAtVoiceArticlesUnlocked(
  input: DropboxSyncInput,
): Promise<ProviderSyncResult> {
  const batchSize = normalizeBatchSize(input.batchSize);
  const client = createDropboxReadClient();
  const allFiles = (await client.listAtVoiceFiles())
    .filter(isSupportedAtVoiceFile)
    .sort(compareDropboxFilesNewestFirst);
  const records = await listImportRecords(input.ownerEmail, DROPBOX_PROVIDER);
  await retryPendingCleanup(input.ownerEmail, records);
  const deduplication = new ArticleDeduplicationIndex(
    await getArticleRepository().listDeduplicationCandidates(input.ownerEmail),
  );
  const recordByExternalId = importRecordMap(records);
  const candidates = allFiles
    .map((file, index) => ({
      file,
      index,
      sourceHash: dropboxSourceHash(file),
      record: recordByExternalId.get(file.id),
    }))
    .filter((candidate) =>
      isImportRecordClaimable(candidate.record, candidate.sourceHash),
    )
    .sort(compareImportCandidates);
  const importedArticles: ProviderSyncResult["importedArticles"] = [];
  const deduplicatedArticles: ProviderSyncResult["deduplicatedArticles"] = [];
  const reconciledArticles: ProviderSyncResult["reconciledArticles"] = [];
  const failures: ProviderSyncResult["failures"] = [];
  let claimed = 0;
  let claimConflicts = 0;

  for (const candidate of candidates) {
    if (claimed >= batchSize) {
      break;
    }

    const { file: metadata, sourceHash } = candidate;
    const externalId = metadata.id;
    const sourcePath =
      metadata.path_display ?? metadata.path_lower ?? metadata.name;

    const claim = await claimImport({
      ownerEmail: input.ownerEmail,
      provider: DROPBOX_PROVIDER,
      externalId,
      sourceHash,
      sourceTitle: metadata.name,
      metadata: {
        path: sourcePath,
        rev: metadata.rev,
        size: metadata.size,
        clientModified: metadata.client_modified,
        serverModified: metadata.server_modified,
      },
    });

    if (!claim?.attemptId) {
      claimConflicts += 1;
      continue;
    }

    claimed += 1;
    const articleId = articleIdForImport(
      input.ownerEmail,
      DROPBOX_PROVIDER,
      externalId,
      sourceHash,
    );

    let finalized:
      | {
          imported: ProviderImportOutcome;
          completed: ExternalImportRecord;
        }
      | undefined;

    try {
      const existing = await getSavedArticle(articleId, input.ownerEmail);
      const imported = existing
        ? recoveredImportOutcome(existing)
        : await importDropboxFile(
            client,
            metadata,
            input.ownerEmail,
            articleId,
            deduplication,
            candidate.record?.articleId,
          );

      const completed = await markImportCompletedReconciled(
        input.ownerEmail,
        DROPBOX_PROVIDER,
        externalId,
        imported.article.id,
        claim.attemptId,
        completionDetails(imported),
      );

      if (!completed) {
        throw new Error("The Dropbox import lease expired before completion.");
      }

      finalized = { imported, completed };
    } catch (error) {
      await markImportFailed(
        input.ownerEmail,
        DROPBOX_PROVIDER,
        externalId,
        error,
        claim.attemptId,
      ).catch(() => null);
      failures.push({
        externalId,
        title: metadata.name,
        error: messageFromError(error),
      });
      continue;
    }

    await cleanupReplacedArticle(
      input.ownerEmail,
      finalized.completed,
    ).catch(() => undefined);
    collectImportOutcome({
      imported: finalized.imported,
      externalId,
      importedArticles,
      deduplicatedArticles,
      reconciledArticles,
    });
  }

  return syncResult({
    importedArticles,
    deduplicatedArticles,
    reconciledArticles,
    failures,
    skipped: allFiles.length - candidates.length + claimConflicts,
    remaining: remainingCandidateCount(
      candidates.length,
      importedArticles.length,
      deduplicatedArticles.length,
      reconciledArticles.length,
    ),
    providerLabel: "@Voice Dropbox",
  });
}

function instapaperSourceHash(bookmark: InstapaperBookmark) {
  return (
    bookmark.hash ||
    [bookmark.time, bookmark.url].join(":")
  );
}

function dropboxSourceHash(metadata: DropboxFileMetadata) {
  return (
    metadata.content_hash ||
    metadata.rev ||
    [metadata.server_modified, metadata.size].join(":")
  );
}

function importRecordMap(records: ExternalImportRecord[]) {
  return new Map(records.map((record) => [record.externalId, record]));
}

function compareImportCandidates(
  left: { index: number; record?: ExternalImportRecord },
  right: { index: number; record?: ExternalImportRecord },
) {
  const priorityDifference =
    importCandidatePriority(left.record) - importCandidatePriority(right.record);
  return priorityDifference || left.index - right.index;
}

function importCandidatePriority(record?: ExternalImportRecord) {
  if (!record || record.status === "completed") {
    return 0;
  }

  return record.status === "pending" ? 1 : 2;
}

async function importInstapaperBookmark(
  client: InstapaperClient,
  bookmark: InstapaperBookmark,
  ownerEmail: string,
  articleId: string,
  deduplication: ArticleDeduplicationIndex,
  previousArticleId?: string,
): Promise<ProviderImportOutcome> {
  const existing = await getSavedArticle(articleId, ownerEmail);

  if (existing) {
    return recoveredImportOutcome(existing);
  }

  try {
    const html = await client.getText(bookmark.bookmark_id);
    return await importHtmlArticle(html, ownerEmail, {
      id: articleId,
      title: bookmark.title || undefined,
      sourceUrl: bookmark.url,
      progress: bookmark.progress,
      deduplication,
      excludeArticleId: previousArticleId,
    });
  } catch (error) {
    if (!shouldFallbackToBookmarkUrl(error, bookmark.url)) {
      throw error;
    }

    return importUrlArticle(bookmark.url, ownerEmail, {
      id: articleId,
      title: bookmark.title || undefined,
      progress: bookmark.progress,
      deduplication,
      excludeArticleId: previousArticleId,
    });
  }
}

async function importDropboxFile(
  client: ReturnType<typeof createDropboxReadClient>,
  metadata: DropboxFileMetadata,
  ownerEmail: string,
  articleId: string,
  deduplication: ArticleDeduplicationIndex,
  previousArticleId?: string,
): Promise<ProviderImportOutcome> {
  const bytes = await client.downloadFile(metadata.id);
  const contents = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(contents).set(bytes);
  const file = new File([contents], metadata.name, {
    type: contentTypeForFile(metadata.name),
    lastModified: modifiedTimeForFile(metadata),
  });

  return importFileArticle(file, ownerEmail, {
    id: articleId,
    deduplication,
    excludeArticleId: previousArticleId,
  });
}

function shouldFallbackToBookmarkUrl(error: unknown, rawUrl: string) {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }

  return (
    error instanceof InstapaperApiError &&
    !error.retryable &&
    error.kind !== "configuration"
  );
}

type CleanupOperations = {
  hasActiveImportReference: typeof hasActiveImportReference;
  deleteArticle: typeof deleteArticleBestEffort;
  clearImportCleanupArticle: typeof clearImportCleanupArticle;
};

const cleanupOperations: CleanupOperations = {
  hasActiveImportReference,
  deleteArticle: deleteArticleBestEffort,
  clearImportCleanupArticle,
};

export async function retryPendingCleanup(
  ownerEmail: string,
  records: ExternalImportRecord[],
  operations: CleanupOperations = cleanupOperations,
) {
  for (const record of records) {
    if (!record.cleanupArticleId) {
      continue;
    }

    try {
      const cleaned =
        (await operations.hasActiveImportReference(
          ownerEmail,
          record.cleanupArticleId,
        )) ||
        (await operations.deleteArticle(
          record.cleanupArticleId,
          ownerEmail,
        ));

      if (!cleaned) {
        continue;
      }

      await operations.clearImportCleanupArticle(
        ownerEmail,
        record.provider,
        record.externalId,
        record.cleanupArticleId,
      );
      record.cleanupArticleId = undefined;
    } catch {
      // Preserve this record's marker and continue retrying the remaining records.
    }
  }
}

export async function cleanupReplacedArticle(
  ownerEmail: string,
  record: ExternalImportRecord,
  operations: CleanupOperations = cleanupOperations,
) {
  if (!record.cleanupArticleId) {
    return;
  }

  try {
    const cleaned =
      (await operations.hasActiveImportReference(
        ownerEmail,
        record.cleanupArticleId,
      )) ||
      (await operations.deleteArticle(
        record.cleanupArticleId,
        ownerEmail,
      ));

    if (!cleaned) {
      return;
    }

    await operations.clearImportCleanupArticle(
      ownerEmail,
      record.provider,
      record.externalId,
      record.cleanupArticleId,
    );
  } catch {
    // Ledger completion is durable; leave the marker for a later cleanup retry.
  }
}

async function deleteArticleBestEffort(articleId: string, ownerEmail: string) {
  try {
    return await deleteSavedArticleIfUnreferenced(articleId, ownerEmail);
  } catch {
    // A completed replacement remains valid even if old-artifact cleanup must be retried later.
    return false;
  }
}

function normalizeBatchSize(value?: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(
    Math.max(Math.trunc(value ?? DEFAULT_BATCH_SIZE), 1),
    MAX_BATCH_SIZE,
  );
}

function isSupportedAtVoiceFile(metadata: DropboxFileMetadata) {
  const name = metadata.name.toLowerCase();

  return (
    name.endsWith(".mhtml.zip") ||
    [
      ".mhtml",
      ".mht",
      ".html",
      ".htm",
      ".url",
      ".pdf",
      ".docx",
      ".md",
      ".markdown",
      ".txt",
    ].some((extension) => name.endsWith(extension))
  );
}

function compareDropboxFilesNewestFirst(
  left: DropboxFileMetadata,
  right: DropboxFileMetadata,
) {
  return (right.server_modified ?? "").localeCompare(
    left.server_modified ?? "",
  );
}

function contentTypeForFile(name: string) {
  const lower = name.toLowerCase();

  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }

  if (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown")
  ) {
    return "text/markdown";
  }

  if (lower.endsWith(".txt") || lower.endsWith(".url")) {
    return "text/plain";
  }

  return "application/octet-stream";
}

function modifiedTimeForFile(metadata: DropboxFileMetadata) {
  const value = Date.parse(
    metadata.client_modified ?? metadata.server_modified ?? "",
  );
  return Number.isFinite(value) ? value : Date.now();
}

function syncResult(input: {
  importedArticles: ProviderSyncResult["importedArticles"];
  deduplicatedArticles: ProviderSyncResult["deduplicatedArticles"];
  reconciledArticles: ProviderSyncResult["reconciledArticles"];
  failures: ProviderSyncResult["failures"];
  skipped: number;
  remaining: number;
  providerLabel: string;
  possiblyTruncated?: boolean;
}): ProviderSyncResult {
  const imported = input.importedArticles.length;
  const deduplicated = input.deduplicatedArticles.length;
  const reconciled = input.reconciledArticles.length;
  const failed = input.failures.length;
  const summary =
    imported === 0 && deduplicated === 0 && reconciled === 0 && failed === 0
      ? `${input.providerLabel} is already up to date.`
      : `${input.providerLabel}: imported ${imported}, deduplicated ${deduplicated}, reconciled ${reconciled}, failed ${failed}, ${input.remaining} remaining.`;
  const message = input.possiblyTruncated
    ? `${summary} Instapaper returned its 500-item limit, so older bookmarks may not be visible yet.`
    : summary;

  return {
    imported,
    deduplicated,
    reconciled,
    failed,
    skipped: input.skipped,
    remaining: input.remaining,
    importedArticles: input.importedArticles,
    deduplicatedArticles: input.deduplicatedArticles,
    reconciledArticles: input.reconciledArticles,
    failures: input.failures,
    possiblyTruncated: input.possiblyTruncated,
    message,
  };
}

export function recoveredImportOutcome(article: Article): ProviderImportOutcome {
  return {
    article,
    created: false,
    deduplicated: false,
    importSourceUrl: article.sourceUrl,
  };
}

function completionDetails(imported: ProviderImportOutcome) {
  return {
    sourceUrl: imported.importSourceUrl,
    metadata: {
      deduplication: imported.deduplicated
        ? {
            articleId: imported.article.id,
            reason: imported.deduplicationReason,
            similarity: Number(
              (imported.deduplicationSimilarity ?? 1).toFixed(6),
            ),
          }
        : null,
    },
  };
}

function collectImportOutcome(input: {
  imported: ProviderImportOutcome;
  externalId: string;
  importedArticles: ProviderSyncResult["importedArticles"];
  deduplicatedArticles: ProviderSyncResult["deduplicatedArticles"];
  reconciledArticles: ProviderSyncResult["reconciledArticles"];
}) {
  if (input.imported.deduplicated) {
    input.deduplicatedArticles.push({
      id: input.imported.article.id,
      title: input.imported.article.title,
      externalId: input.externalId,
      reason: input.imported.deduplicationReason ?? "exact-content",
      similarity: input.imported.deduplicationSimilarity ?? 1,
    });
    return;
  }

  if (input.imported.created) {
    input.importedArticles.push({
      id: input.imported.article.id,
      title: input.imported.article.title,
    });
    return;
  }

  input.reconciledArticles.push({
    id: input.imported.article.id,
    title: input.imported.article.title,
    externalId: input.externalId,
  });
}

export function remainingCandidateCount(
  candidateCount: number,
  importedCount: number,
  deduplicatedCount: number,
  reconciledCount: number,
) {
  return Math.max(
    candidateCount - importedCount - deduplicatedCount - reconciledCount,
    0,
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown import error.";
}
