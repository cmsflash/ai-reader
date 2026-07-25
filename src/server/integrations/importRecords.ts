import { getDatabaseSql, hasProductionDatabase } from "@/server/database";

export type ImportStatus = "pending" | "completed" | "failed";

export type ExternalImportRecord = {
  ownerEmail: string;
  provider: string;
  externalId: string;
  sourceHash?: string;
  articleId?: string;
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

export async function markImportPending(input: ImportRecordInput) {
  const now = new Date().toISOString();
  const normalizedInput = normalizeInput(input);

  if (!hasProductionDatabase()) {
    const existing = await findImportRecord(
      normalizedInput.ownerEmail,
      normalizedInput.provider,
      normalizedInput.externalId,
    );
    const record: ExternalImportRecord = {
      ...normalizedInput,
      status: "pending",
      metadata: normalizedInput.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    localRecords.set(
      recordKey(record.ownerEmail, record.provider, record.externalId),
      record,
    );
    return record;
  }

  const rows = (await getDatabaseSql().query(
    `
      INSERT INTO external_imports (
        owner_email,
        provider,
        external_id,
        source_hash,
        status,
        source_title,
        source_url,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb, $8::timestamptz, $8::timestamptz)
      ON CONFLICT (owner_email, provider, external_id)
      DO UPDATE SET
        source_hash = EXCLUDED.source_hash,
        article_id = NULL,
        status = 'pending',
        source_title = EXCLUDED.source_title,
        source_url = EXCLUDED.source_url,
        error_message = NULL,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      RETURNING
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
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
      normalizedInput.sourceTitle ?? null,
      normalizedInput.sourceUrl ?? null,
      JSON.stringify(normalizedInput.metadata ?? {}),
      now,
    ],
  )) as ImportRecordRow[];

  return rowToRecord(rows[0]);
}

export async function markImportCompleted(
  ownerEmail: string,
  provider: string,
  externalId: string,
  articleId: string,
) {
  return updateImportStatus({
    ownerEmail,
    provider,
    externalId,
    status: "completed",
    articleId,
  });
}

export async function markImportFailed(
  ownerEmail: string,
  provider: string,
  externalId: string,
  error: unknown,
) {
  return updateImportStatus({
    ownerEmail,
    provider,
    externalId,
    status: "failed",
    errorMessage: messageFromError(error).slice(0, 2_000),
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

async function updateImportStatus(input: {
  ownerEmail: string;
  provider: string;
  externalId: string;
  status: ImportStatus;
  articleId?: string;
  errorMessage?: string;
}) {
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
  const now = new Date().toISOString();

  if (!hasProductionDatabase()) {
    const key = recordKey(ownerEmail, input.provider, input.externalId);
    const existing = localRecords.get(key);

    if (!existing) {
      return null;
    }

    const record: ExternalImportRecord = {
      ...existing,
      status: input.status,
      articleId: input.articleId,
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
        article_id = $5,
        error_message = $6,
        updated_at = $7::timestamptz
      WHERE owner_email = $1 AND provider = $2 AND external_id = $3
      RETURNING
        owner_email,
        provider,
        external_id,
        source_hash,
        article_id,
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
    status: row.status,
    sourceTitle: row.source_title ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    errorMessage: row.error_message ?? undefined,
    metadata,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
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
