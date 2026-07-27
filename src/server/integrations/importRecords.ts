import { createHash, randomUUID } from "node:crypto";
import { getDatabaseSql, hasProductionDatabase } from "../database.ts";

export type ImportStatus = "pending" | "completed" | "failed" | "dismissed";
export const IMPORT_PENDING_LEASE_MS = 15 * 60 * 1_000;

export type ExternalImportRecord = {
  ownerEmail: string;
  provider: string;
  externalId: string;
  sourceHash?: string;
  articleId?: string;
  cleanupArticleId?: string;
  attemptId?: string;
  status: ImportStatus;
  sourceTitle?: string;
  sourceUrl?: string;
  errorMessage?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ImportRecordInput = {
  ownerEmail: string;
  provider: string;
  externalId: string;
  sourceHash?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

type ImportRecordRow = {
  owner_email: string;
  provider: string;
  external_id: string;
  source_hash: string | null;
  article_id: string | null;
  cleanup_article_id: string | null;
  attempt_id: string | null;
  status: ImportStatus;
  source_title: string | null;
  source_url: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const localRecords = new Map<string, ExternalImportRecord>();

export async function findImportRecord(
  ownerEmail: string,
  provider: string,
  externalId: string,
) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);

  if (!hasProductionDatabase()) {
    return localRecords.get(recordKey(normalizedOwner, provider, externalId)) ?? null;
  }

  const rows = (await getDatabaseSql().query(
    `
      SELECT
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
        cleanup_article_id,
        attempt_id,
        status,
        source_title,
        source_url,
        error_message,
        metadata,
        created_at,
        updated_at
      FROM external_imports
      WHERE owner_email = $1 AND provider = $2 AND external_id = $3
      LIMIT 1
    `,
    [normalizedOwner, provider, externalId],
  )) as ImportRecordRow[];

  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function claimImport(
  input: ImportRecordInput,
  options: {
    now?: Date;
    attemptId?: string;
    pendingLeaseMs?: number;
    sourceHashMustMatch?: boolean;
  } = {},
) {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const pendingLeaseMs = normalizePendingLeaseMs(options.pendingLeaseMs);
  const staleBefore = new Date(nowDate.getTime() - pendingLeaseMs).toISOString();
  const attemptId = options.attemptId ?? randomUUID();
  const normalizedInput = normalizeInput(input);

  if (!hasProductionDatabase()) {
    const key = recordKey(
      normalizedInput.ownerEmail,
      normalizedInput.provider,
      normalizedInput.externalId,
    );
    const existing = localRecords.get(key);

    if (
      existing &&
      options.sourceHashMustMatch &&
      (existing.sourceHash ?? null) !==
        (normalizedInput.sourceHash ?? null)
    ) {
      return null;
    }

    if (
      existing &&
      !isImportRecordClaimable(
        existing,
        normalizedInput.sourceHash,
        nowDate.getTime(),
        pendingLeaseMs,
      )
    ) {
      return null;
    }

    const record: ExternalImportRecord = {
      ...normalizedInput,
      articleId: existing?.articleId,
      cleanupArticleId: existing?.cleanupArticleId,
      attemptId,
      status: "pending",
      metadata: normalizedInput.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    localRecords.set(key, record);
    return record;
  }

  const rows = (await getDatabaseSql().query(
    `
      INSERT INTO external_imports (
        owner_email,
        provider,
        external_id,
        source_hash,
        attempt_id,
        status,
        source_title,
        source_url,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9::timestamptz, $9::timestamptz)
      ON CONFLICT (owner_email, provider, external_id)
      DO UPDATE SET
        source_hash = EXCLUDED.source_hash,
        attempt_id = EXCLUDED.attempt_id,
        status = 'pending',
        source_title = EXCLUDED.source_title,
        source_url = EXCLUDED.source_url,
        error_message = NULL,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      WHERE
        external_imports.cleanup_article_id IS NULL
        AND (
          NOT $11::boolean
          OR external_imports.source_hash IS NOT DISTINCT FROM EXCLUDED.source_hash
        )
        AND (
          external_imports.status = 'failed'
          OR (
            external_imports.status = 'pending'
            AND external_imports.updated_at < $10::timestamptz
          )
          OR (
            external_imports.status = 'completed'
            AND external_imports.source_hash IS DISTINCT FROM EXCLUDED.source_hash
          )
        )
      RETURNING
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
        cleanup_article_id,
        attempt_id,
        status,
        source_title,
        source_url,
        error_message,
        metadata,
        created_at,
        updated_at
    `,
    [
      normalizedInput.ownerEmail,
      normalizedInput.provider,
      normalizedInput.externalId,
      normalizedInput.sourceHash ?? null,
      attemptId,
      normalizedInput.sourceTitle ?? null,
      normalizedInput.sourceUrl ?? null,
      JSON.stringify(normalizedInput.metadata ?? {}),
      now,
      staleBefore,
      options.sourceHashMustMatch ?? false,
    ],
  )) as ImportRecordRow[];

  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function markImportCompleted(
  ownerEmail: string,
  provider: string,
  externalId: string,
  articleId: string,
  attemptId: string,
) {
  return updateImportStatus({
    ownerEmail,
    provider,
    externalId,
    status: "completed",
    articleId,
    attemptId,
  });
}

export async function markImportCompletedReconciled(
  ownerEmail: string,
  provider: string,
  externalId: string,
  articleId: string,
  attemptId: string,
) {
  try {
    return await markImportCompleted(
      ownerEmail,
      provider,
      externalId,
      articleId,
      attemptId,
    );
  } catch (error) {
    try {
      const stored = await findImportRecord(ownerEmail, provider, externalId);

      if (stored?.status === "completed" && stored.articleId === articleId) {
        return stored;
      }
    } catch {
      // Preserve the original ambiguous completion error for the caller.
    }

    throw error;
  }
}

export async function markImportFailed(
  ownerEmail: string,
  provider: string,
  externalId: string,
  error: unknown,
  attemptId: string,
) {
  return updateImportStatus({
    ownerEmail,
    provider,
    externalId,
    status: "failed",
    errorMessage: messageFromError(error).slice(0, 2_000),
    attemptId,
  });
}

export async function listImportRecords(ownerEmail: string, provider: string) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);

  if (!hasProductionDatabase()) {
    return Array.from(localRecords.values())
      .filter(
        (record) =>
          record.ownerEmail === normalizedOwner && record.provider === provider,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  const rows = (await getDatabaseSql().query(
    `
      SELECT
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
        cleanup_article_id,
        attempt_id,
        status,
        source_title,
        source_url,
        error_message,
        metadata,
        created_at,
        updated_at
      FROM external_imports
      WHERE owner_email = $1 AND provider = $2
      ORDER BY updated_at DESC
    `,
    [normalizedOwner, provider],
  )) as ImportRecordRow[];

  return rows.map(rowToRecord);
}

export function dismissLocalImportsForArticle(
  ownerEmail: string,
  articleId: string,
) {
  if (hasProductionDatabase()) {
    return;
  }

  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  const now = new Date().toISOString();

  for (const [key, record] of localRecords) {
    if (
      record.ownerEmail === normalizedOwner &&
      record.articleId === articleId
    ) {
      localRecords.set(key, {
        ...record,
        articleId: undefined,
        attemptId: undefined,
        status: "dismissed",
        errorMessage: undefined,
        updatedAt: now,
      });
    }
  }
}

export async function clearImportCleanupArticle(
  ownerEmail: string,
  provider: string,
  externalId: string,
  articleId: string,
) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);

  if (!hasProductionDatabase()) {
    const key = recordKey(normalizedOwner, provider, externalId);
    const existing = localRecords.get(key);

    if (existing?.cleanupArticleId === articleId) {
      const record = {
        ...existing,
        cleanupArticleId: undefined,
        updatedAt: new Date().toISOString(),
      };
      localRecords.set(key, record);
      return record;
    }

    return null;
  }

  const rows = (await getDatabaseSql().query(
    `
      UPDATE external_imports
      SET cleanup_article_id = NULL, updated_at = now()
      WHERE
        owner_email = $1
        AND provider = $2
        AND external_id = $3
        AND cleanup_article_id = $4
      RETURNING
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
        cleanup_article_id,
        attempt_id,
        status,
        source_title,
        source_url,
        error_message,
        metadata,
        created_at,
        updated_at
    `,
    [normalizedOwner, provider, externalId, articleId],
  )) as ImportRecordRow[];

  return rows[0] ? rowToRecord(rows[0]) : null;
}

async function updateImportStatus(input: {
  ownerEmail: string;
  provider: string;
  externalId: string;
  status: ImportStatus;
  articleId?: string;
  errorMessage?: string;
  attemptId: string;
}) {
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
  const now = new Date().toISOString();

  if (!hasProductionDatabase()) {
    const key = recordKey(ownerEmail, input.provider, input.externalId);
    const existing = localRecords.get(key);

    if (
      !existing ||
      existing.status !== "pending" ||
      existing.attemptId !== input.attemptId
    ) {
      return null;
    }

    const record: ExternalImportRecord = {
      ...existing,
      status: input.status,
      cleanupArticleId:
        input.status === "completed" &&
        existing.articleId &&
        existing.articleId !== input.articleId
          ? existing.articleId
          : existing.cleanupArticleId,
      articleId: input.articleId ?? existing.articleId,
      attemptId: undefined,
      errorMessage: input.errorMessage,
      updatedAt: now,
    };
    localRecords.set(key, record);
    return record;
  }

  const rows = (await getDatabaseSql().query(
    `
      UPDATE external_imports
      SET
        status = $4,
        cleanup_article_id = CASE
          WHEN
            $4 = 'completed'
            AND article_id IS NOT NULL
            AND article_id IS DISTINCT FROM $5
          THEN article_id
          ELSE cleanup_article_id
        END,
        article_id = COALESCE($5, article_id),
        attempt_id = NULL,
        error_message = $6,
        updated_at = $7::timestamptz
      WHERE
        owner_email = $1
        AND provider = $2
        AND external_id = $3
        AND status = 'pending'
        AND attempt_id = $8
      RETURNING
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
        cleanup_article_id,
        attempt_id,
        status,
        source_title,
        source_url,
        error_message,
        metadata,
        created_at,
        updated_at
    `,
    [
      ownerEmail,
      input.provider,
      input.externalId,
      input.status,
      input.articleId ?? null,
      input.errorMessage ?? null,
      now,
      input.attemptId,
    ],
  )) as ImportRecordRow[];

  return rows[0] ? rowToRecord(rows[0]) : null;
}

function normalizeInput(input: ImportRecordInput): ImportRecordInput {
  return {
    ...input,
    ownerEmail: normalizeOwnerEmail(input.ownerEmail),
    provider: input.provider.trim(),
    externalId: input.externalId.trim(),
  };
}

function rowToRecord(row: ImportRecordRow): ExternalImportRecord {
  const metadata =
    typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {};

  return {
    ownerEmail: row.owner_email,
    provider: row.provider,
    externalId: row.external_id,
    sourceHash: row.source_hash ?? undefined,
    articleId: row.article_id ?? undefined,
    cleanupArticleId: row.cleanup_article_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    status: row.status,
    sourceTitle: row.source_title ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    errorMessage: row.error_message ?? undefined,
    metadata,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

export function isImportRecordClaimable(
  record: ExternalImportRecord | null | undefined,
  sourceHash?: string,
  now = Date.now(),
  pendingLeaseMs = IMPORT_PENDING_LEASE_MS,
) {
  if (record?.cleanupArticleId) {
    return false;
  }

  if (!record || record.status === "failed") {
    return true;
  }

  if (record.status === "dismissed") {
    return false;
  }

  if (record.status === "completed") {
    return (
      !record.articleId ||
      (record.sourceHash ?? null) !== (sourceHash ?? null)
    );
  }

  const updatedAt = Date.parse(record.updatedAt);
  return (
    !Number.isFinite(updatedAt) ||
    now - updatedAt > normalizePendingLeaseMs(pendingLeaseMs)
  );
}

export function articleIdForImport(
  ownerEmail: string,
  provider: string,
  externalId: string,
  sourceHash?: string,
) {
  const bytes = createHash("sha256")
    .update(normalizeOwnerEmail(ownerEmail))
    .update("\0")
    .update(provider.trim())
    .update("\0")
    .update(externalId.trim())
    .update("\0")
    .update(sourceHash ?? "")
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function normalizePendingLeaseMs(value?: number) {
  if (value === undefined) {
    return IMPORT_PENDING_LEASE_MS;
  }

  if (!Number.isFinite(value)) {
    return IMPORT_PENDING_LEASE_MS;
  }

  return Math.max(0, Math.trunc(value));
}

function recordKey(ownerEmail: string, provider: string, externalId: string) {
  return `${ownerEmail}\u0000${provider}\u0000${externalId}`;
}

function normalizeOwnerEmail(ownerEmail: string) {
  return ownerEmail.trim().toLowerCase();
}

function isoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown import error.";
}
