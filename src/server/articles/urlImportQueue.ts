import { createHash } from "node:crypto";
import type { ArticleImportSummary } from "../../lib/articleList.ts";
import {
  articleIdForImport,
  claimImport,
  findImportRecord,
  isImportRecordClaimable,
  listActionableImportRecords,
  markImportCompletedReconciled,
  markImportFailed,
  type ExternalImportRecord,
} from "../integrations/importRecords.ts";

export const shareImportSources = [
  "android-share",
  "ios-shortcut",
  "web-share",
] as const;

export type ShareImportSource = (typeof shareImportSources)[number];

export class UrlImportIdempotencyConflictError extends Error {
  constructor() {
    super("This idempotency key belongs to a different import request.");
    this.name = "UrlImportIdempotencyConflictError";
  }
}

type ClaimUrlImportInput = {
  ownerEmail: string;
  provider: string;
  externalId: string;
  url: string;
  title?: string;
  sourceHash?: string;
  metadata?: Record<string, unknown>;
  sourceHashMustMatch?: boolean;
};

export type ClaimedUrlImport = {
  record: ExternalImportRecord;
  run: (() => Promise<ExternalImportRecord>) | null;
};

export async function claimUrlImport(
  input: ClaimUrlImportInput,
): Promise<ClaimedUrlImport> {
  const title = cleanImportTitle(input.title);
  const sourceHash =
    input.sourceHash ?? urlImportSourceHash(input.url, title);
  const record = await claimImport(
    {
      ownerEmail: input.ownerEmail,
      provider: input.provider,
      externalId: input.externalId,
      sourceHash,
      sourceTitle: title,
      sourceUrl: input.url,
      metadata: input.metadata ?? {
        requestedBy: input.provider,
      },
    },
    {
      sourceHashMustMatch: input.sourceHashMustMatch,
    },
  );

  if (!record?.attemptId) {
    const existing = await findImportRecord(
      input.ownerEmail,
      input.provider,
      input.externalId,
    );

    if (!existing) {
      throw new Error("The import could not be claimed.");
    }

    if (
      input.sourceHashMustMatch &&
      existing.sourceHash !== sourceHash
    ) {
      throw new UrlImportIdempotencyConflictError();
    }

    return { record: existing, run: null };
  }

  const attemptId = record.attemptId;
  const articleId = articleIdForImport(
    input.ownerEmail,
    input.provider,
    input.externalId,
    sourceHash,
  );

  return {
    record,
    run: () =>
      runUrlImportJob({
        ownerEmail: input.ownerEmail,
        provider: input.provider,
        externalId: input.externalId,
        url: input.url,
        title,
        attemptId,
        articleId,
      }),
  };
}

export async function runUrlImportJob(input: {
  ownerEmail: string;
  provider: string;
  externalId: string;
  url: string;
  title?: string;
  attemptId: string;
  articleId: string;
}) {
  try {
    const { getSavedArticle, importUrlArticle } = await import(
      "@/server/articles/articleService"
    );
    const existing = await getSavedArticle(input.articleId, input.ownerEmail);
    const result = existing
      ? { article: existing }
      : await importUrlArticle(input.url, input.ownerEmail, {
          id: input.articleId,
          title: input.title,
        });
    const completed = await markImportCompletedReconciled(
      input.ownerEmail,
      input.provider,
      input.externalId,
      result.article.id,
      input.attemptId,
    );

    if (!completed) {
      throw new Error("The import lease expired before completion.");
    }

    return completed;
  } catch (error) {
    await markImportFailed(
      input.ownerEmail,
      input.provider,
      input.externalId,
      error,
      input.attemptId,
    ).catch(() => null);

    throw error;
  }
}

export async function listShareUrlImports(
  ownerEmail: string,
): Promise<ArticleImportSummary[]> {
  const records = await listActionableImportRecords(
    ownerEmail,
    shareImportSources,
  );

  return records.flatMap((record) => {
    if (
      !isShareImportSource(record.provider) ||
      !record.sourceUrl ||
      record.articleId
    ) {
      return [];
    }

    return [
      {
        id: `${record.provider}:${record.externalId}`,
        source: record.provider,
        status: record.status === "failed" ? "failed" : "pending",
        title: record.sourceTitle || titleFromUrl(record.sourceUrl),
        sourceUrl: record.sourceUrl,
        errorMessage: record.errorMessage,
        retryable: isImportRecordClaimable(record, record.sourceHash),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ];
  });
}

export function shareImportExternalId(url: string) {
  return `url-${createHash("sha256").update(url).digest("base64url")}`;
}

export function urlImportSourceHash(url: string, title?: string) {
  return createHash("sha256")
    .update(url)
    .update("\0")
    .update(title ?? "")
    .digest("hex");
}

export function cleanImportTitle(title?: string) {
  const normalized = title?.trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

export function isShareImportSource(
  source: string,
): source is ShareImportSource {
  return (shareImportSources as readonly string[]).includes(source);
}

function titleFromUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const lastPath = decodeURIComponent(
      url.pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    return lastPath || url.hostname;
  } catch {
    return rawUrl;
  }
}
