import {
  importFileArticle,
  importHtmlArticle,
} from "@/server/articles/articleService";
import {
  createDropboxReadClient,
  type DropboxFileMetadata,
} from "@/server/integrations/dropboxClient";
import {
  findImportRecord,
  markImportCompleted,
  markImportFailed,
  markImportPending,
} from "@/server/integrations/importRecords";
import {
  createInstapaperClient,
  type InstapaperBookmark,
  type InstapaperBookmarkListInput,
} from "@/server/integrations/instapaperClient";

const INSTAPAPER_PROVIDER = "instapaper";
const DROPBOX_PROVIDER = "dropbox-atvoice";
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 10;

export type ProviderSyncResult = {
  imported: number;
  failed: number;
  skipped: number;
  remaining: number;
  importedArticles: Array<{
    id: string;
    title: string;
  }>;
  failures: Array<{
    externalId: string;
    title: string;
    error: string;
  }>;
  message: string;
};

export async function syncInstapaperArticles(input: {
  ownerEmail: string;
  folder: InstapaperBookmarkListInput["folderId"];
  batchSize?: number;
}): Promise<ProviderSyncResult> {
  const batchSize = normalizeBatchSize(input.batchSize);
  const client = createInstapaperClient();
  const listing = await client.listBookmarks({
    folderId: input.folder,
    limit: 500,
  });
  const decisions = await Promise.all(
    listing.bookmarks.map(async (bookmark) => ({
      bookmark,
      shouldImport: await shouldImportInstapaperBookmark(
        input.ownerEmail,
        bookmark,
      ),
    })),
  );
  const candidates = decisions
    .filter((decision) => decision.shouldImport)
    .map((decision) => decision.bookmark);
  const selected = candidates.slice(0, batchSize);
  const importedArticles: ProviderSyncResult["importedArticles"] = [];
  const failures: ProviderSyncResult["failures"] = [];

  for (const bookmark of selected) {
    const externalId = String(bookmark.bookmark_id);
    const sourceHash = instapaperSourceHash(bookmark);

    await markImportPending({
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

    try {
      const html = await client.getText(bookmark.bookmark_id);
      const imported = await importHtmlArticle(html, input.ownerEmail, {
        title: bookmark.title || undefined,
        sourceUrl: bookmark.url,
        progress: bookmark.progress,
      });

      await markImportCompleted(
        input.ownerEmail,
        INSTAPAPER_PROVIDER,
        externalId,
        imported.article.id,
      );
      importedArticles.push({
        id: imported.article.id,
        title: imported.article.title,
      });
    } catch (error) {
      await markImportFailed(
        input.ownerEmail,
        INSTAPAPER_PROVIDER,
        externalId,
        error,
      );
      failures.push({
        externalId,
        title: bookmark.title || bookmark.url,
        error: messageFromError(error),
      });
    }
  }

  return syncResult({
    importedArticles,
    failures,
    skipped: decisions.length - candidates.length,
    remaining: Math.max(candidates.length - selected.length, 0),
    providerLabel: "Instapaper",
  });
}

export async function syncDropboxAtVoiceArticles(input: {
  ownerEmail: string;
  batchSize?: number;
}): Promise<ProviderSyncResult> {
  const batchSize = normalizeBatchSize(input.batchSize);
  const client = createDropboxReadClient();
  const allFiles = (await client.listAtVoiceFiles())
    .filter(isSupportedAtVoiceFile)
    .sort(compareDropboxFilesNewestFirst);
  const decisions = await Promise.all(
    allFiles.map(async (file) => ({
      file,
      shouldImport: await shouldImportDropboxFile(input.ownerEmail, file),
    })),
  );
  const candidates = decisions
    .filter((decision) => decision.shouldImport)
    .map((decision) => decision.file);
  const selected = candidates.slice(0, batchSize);
  const importedArticles: ProviderSyncResult["importedArticles"] = [];
  const failures: ProviderSyncResult["failures"] = [];

  for (const metadata of selected) {
    const externalId = metadata.id;
    const sourceHash = dropboxSourceHash(metadata);
    const sourcePath =
      metadata.path_display ?? metadata.path_lower ?? metadata.name;

    await markImportPending({
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

    try {
      const bytes = await client.downloadFile(metadata.id);
      const contents = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(contents).set(bytes);
      const file = new File([contents], metadata.name, {
        type: contentTypeForFile(metadata.name),
        lastModified: modifiedTimeForFile(metadata),
      });
      const imported = await importFileArticle(file, input.ownerEmail);

      await markImportCompleted(
        input.ownerEmail,
        DROPBOX_PROVIDER,
        externalId,
        imported.article.id,
      );
      importedArticles.push({
        id: imported.article.id,
        title: imported.article.title,
      });
    } catch (error) {
      await markImportFailed(
        input.ownerEmail,
        DROPBOX_PROVIDER,
        externalId,
        error,
      );
      failures.push({
        externalId,
        title: metadata.name,
        error: messageFromError(error),
      });
    }
  }

  return syncResult({
    importedArticles,
    failures,
    skipped: decisions.length - candidates.length,
    remaining: Math.max(candidates.length - selected.length, 0),
    providerLabel: "@Voice Dropbox",
  });
}

async function shouldImportInstapaperBookmark(
  ownerEmail: string,
  bookmark: InstapaperBookmark,
) {
  const record = await findImportRecord(
    ownerEmail,
    INSTAPAPER_PROVIDER,
    String(bookmark.bookmark_id),
  );

  if (!record) {
    return true;
  }

  if (record.status === "pending") {
    return isStalePending(record.updatedAt);
  }

  return record.status === "failed";
}

async function shouldImportDropboxFile(
  ownerEmail: string,
  metadata: DropboxFileMetadata,
) {
  const record = await findImportRecord(
    ownerEmail,
    DROPBOX_PROVIDER,
    metadata.id,
  );

  if (!record) {
    return true;
  }

  if (record.status === "pending") {
    return isStalePending(record.updatedAt);
  }

  return record.status === "failed";
}

function instapaperSourceHash(bookmark: InstapaperBookmark) {
  return (
    bookmark.hash ||
    [
      bookmark.time,
      bookmark.progress_timestamp,
      bookmark.progress,
      bookmark.url,
    ].join(":")
  );
}

function dropboxSourceHash(metadata: DropboxFileMetadata) {
  return (
    metadata.content_hash ||
    metadata.rev ||
    [
      metadata.server_modified,
      metadata.client_modified,
      metadata.size,
    ].join(":")
  );
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

function isStalePending(updatedAt: string) {
  const updatedTime = Date.parse(updatedAt);
  return (
    !Number.isFinite(updatedTime) ||
    Date.now() - updatedTime > 15 * 60 * 1_000
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
  failures: ProviderSyncResult["failures"];
  skipped: number;
  remaining: number;
  providerLabel: string;
}): ProviderSyncResult {
  const imported = input.importedArticles.length;
  const failed = input.failures.length;
  const message =
    imported === 0 && failed === 0
      ? `${input.providerLabel} is already up to date.`
      : `${input.providerLabel}: imported ${imported}, failed ${failed}, ${input.remaining} remaining.`;

  return {
    imported,
    failed,
    skipped: input.skipped,
    remaining: input.remaining,
    importedArticles: input.importedArticles,
    failures: input.failures,
    message,
  };
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown import error.";
}
