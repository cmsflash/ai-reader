import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderSyncLock,
  ProviderSyncAlreadyRunningError,
} from "../src/server/integrations/providerSyncLock.ts";

test("serializes cross-provider callbacks for the same normalized local owner", async () => {
  const withLock = createProviderSyncLock({
    hasProductionDatabase: () => false,
  });
  const events = [];
  let releaseInstapaper;
  const instapaperGate = new Promise((resolve) => {
    releaseInstapaper = resolve;
  });
  const instapaper = withLock(" Reader@Example.com ", async () => {
    events.push("instapaper:start");
    await instapaperGate;
    events.push("instapaper:end");
  });
  const dropbox = withLock("reader@example.com", async () => {
    events.push("dropbox:start");
    events.push("dropbox:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["instapaper:start"]);

  releaseInstapaper();
  await Promise.all([instapaper, dropbox]);
  assert.deepEqual(events, [
    "instapaper:start",
    "instapaper:end",
    "dropbox:start",
    "dropbox:end",
  ]);
});

test("releases the owner queue when a provider callback fails", async () => {
  const withLock = createProviderSyncLock({
    hasProductionDatabase: () => false,
  });

  await assert.rejects(
    withLock("reader@example.com", async () => {
      throw new Error("expected provider failure");
    }),
    /expected provider failure/,
  );

  assert.equal(
    await withLock("reader@example.com", async () => "recovered"),
    "recovered",
  );
});

test("releases the matching database lease when a callback fails", async () => {
  const sql = fakeLeaseSql();
  const withLock = databaseLock(sql, {
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    randomUUID: () => "failing-lease",
  });

  await assert.rejects(
    withLock("reader@example.com", async () => {
      throw new Error("expected provider failure");
    }),
    /expected provider failure/,
  );
  assert.equal(sql.leases.size, 0);
});

test("atomically rejects an active database lease held by another process", async () => {
  const sql = fakeLeaseSql([
    {
      ownerEmail: "reader@example.com",
      leaseId: "active-lease",
      expiresAt: "2026-07-28T12:05:00.000Z",
    },
  ]);
  const withLock = databaseLock(sql, {
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    randomUUID: () => "contending-lease",
  });

  await assert.rejects(
    withLock("reader@example.com", async () => "must not run"),
    ProviderSyncAlreadyRunningError,
  );
  assert.deepEqual(sql.leases.get("reader@example.com"), {
    leaseId: "active-lease",
    expiresAt: "2026-07-28T12:05:00.000Z",
  });
});

test("reclaims an expired database lease and releases only the new holder", async () => {
  const sql = fakeLeaseSql([
    {
      ownerEmail: "reader@example.com",
      leaseId: "expired-lease",
      expiresAt: "2026-07-28T11:59:59.000Z",
    },
  ]);
  const withLock = databaseLock(sql, {
    now: () => new Date("2026-07-28T12:00:00.000Z"),
    randomUUID: () => "replacement-lease",
    leaseMs: 60_000,
  });

  assert.equal(
    await withLock(" Reader@Example.com ", async () => {
      assert.deepEqual(sql.leases.get("reader@example.com"), {
        leaseId: "replacement-lease",
        expiresAt: "2026-07-28T12:01:00.000Z",
      });
      return "reclaimed";
    }),
    "reclaimed",
  );
  assert.equal(sql.leases.size, 0);
});

function databaseLock(sql, overrides = {}) {
  return createProviderSyncLock({
    hasProductionDatabase: () => true,
    getDatabaseSql: () => sql,
    randomUUID: () => crypto.randomUUID(),
    ...overrides,
  });
}

function fakeLeaseSql(initialLeases = []) {
  const leases = new Map(
    initialLeases.map((lease) => [
      lease.ownerEmail,
      {
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
      },
    ]),
  );

  return {
    leases,
    async query(statement, params) {
      const normalized = statement.replace(/\s+/g, " ").trim();

      if (normalized.startsWith("INSERT INTO provider_sync_leases")) {
        const [ownerEmail, leaseId, expiresAt, acquiredAt] = params;
        const existing = leases.get(ownerEmail);

        if (
          existing &&
          Date.parse(existing.expiresAt) > Date.parse(acquiredAt)
        ) {
          return [];
        }

        leases.set(ownerEmail, { leaseId, expiresAt });
        return [{ owner_email: ownerEmail }];
      }

      if (normalized.startsWith("DELETE FROM provider_sync_leases")) {
        const [ownerEmail, leaseId] = params;

        if (leases.get(ownerEmail)?.leaseId === leaseId) {
          leases.delete(ownerEmail);
        }

        return [];
      }

      throw new Error(`Unexpected test query: ${normalized}`);
    },
  };
}
