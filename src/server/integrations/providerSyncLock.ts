import { randomUUID } from "node:crypto";
import {
  getDatabaseSql,
  hasProductionDatabase,
} from "../database.ts";

const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

type QueryClient = {
  query(statement: string, params?: unknown[]): Promise<unknown[]>;
};

type ProviderSyncLockRuntime = {
  hasProductionDatabase: () => boolean;
  getDatabaseSql: () => QueryClient;
  now: () => Date;
  randomUUID: () => string;
  leaseMs: number;
};

export class ProviderSyncAlreadyRunningError extends Error {
  constructor() {
    super("A provider sync is already running for this account.");
    this.name = "ProviderSyncAlreadyRunningError";
  }
}

export function createProviderSyncLock(
  runtimeOverrides: Partial<ProviderSyncLockRuntime> = {},
) {
  const runtime: ProviderSyncLockRuntime = {
    hasProductionDatabase,
    getDatabaseSql,
    now: () => new Date(),
    randomUUID,
    leaseMs: DEFAULT_LEASE_MS,
    ...runtimeOverrides,
  };
  const localOwnerTails = new Map<string, Promise<void>>();

  return async function withLock<T>(
    ownerEmail: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);

    return withLocalOwnerQueue(
      localOwnerTails,
      normalizedOwner,
      async () => {
        if (!runtime.hasProductionDatabase()) {
          return callback();
        }

        const leaseId = runtime.randomUUID();
        const acquiredAt = runtime.now();
        const expiresAt = new Date(
          acquiredAt.getTime() + normalizeLeaseMs(runtime.leaseMs),
        );
        const acquired = await acquireDatabaseLease(
          runtime.getDatabaseSql(),
          normalizedOwner,
          leaseId,
          acquiredAt,
          expiresAt,
        );

        if (!acquired) {
          throw new ProviderSyncAlreadyRunningError();
        }

        try {
          return await callback();
        } finally {
          await releaseDatabaseLease(
            runtime.getDatabaseSql(),
            normalizedOwner,
            leaseId,
          ).catch(() => undefined);
        }
      },
    );
  };
}

export const withProviderSyncLock = createProviderSyncLock();

async function acquireDatabaseLease(
  sql: QueryClient,
  ownerEmail: string,
  leaseId: string,
  acquiredAt: Date,
  expiresAt: Date,
) {
  const rows = await sql.query(
    `
      INSERT INTO provider_sync_leases (
        owner_email,
        lease_id,
        expires_at,
        updated_at
      )
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
      ON CONFLICT (owner_email)
      DO UPDATE SET
        lease_id = EXCLUDED.lease_id,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
      WHERE provider_sync_leases.expires_at <= $4::timestamptz
      RETURNING owner_email
    `,
    [
      ownerEmail,
      leaseId,
      expiresAt.toISOString(),
      acquiredAt.toISOString(),
    ],
  );

  return rows.length > 0;
}

async function releaseDatabaseLease(
  sql: QueryClient,
  ownerEmail: string,
  leaseId: string,
) {
  await sql.query(
    `
      DELETE FROM provider_sync_leases
      WHERE owner_email = $1 AND lease_id = $2
    `,
    [ownerEmail, leaseId],
  );
}

async function withLocalOwnerQueue<T>(
  ownerTails: Map<string, Promise<void>>,
  ownerEmail: string,
  callback: () => Promise<T>,
) {
  const predecessor = ownerTails.get(ownerEmail) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = predecessor.then(
    () => current,
    () => current,
  );
  ownerTails.set(ownerEmail, tail);

  await predecessor.catch(() => undefined);

  try {
    return await callback();
  } finally {
    releaseCurrent();

    if (ownerTails.get(ownerEmail) === tail) {
      ownerTails.delete(ownerEmail);
    }
  }
}

function normalizeOwnerEmail(ownerEmail: string) {
  return ownerEmail.trim().toLowerCase();
}

function normalizeLeaseMs(leaseMs: number) {
  return Number.isFinite(leaseMs) && leaseMs > 0
    ? Math.trunc(leaseMs)
    : DEFAULT_LEASE_MS;
}
