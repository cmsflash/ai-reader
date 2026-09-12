import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { indexedDB } from "fake-indexeddb";
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.includes("/src/") &&
      specifier.startsWith("./") &&
      !specifier.endsWith(".ts")
    )
      return next(specifier + ".ts", context);
    return next(specifier, context);
  },
});
globalThis.indexedDB = indexedDB;
globalThis.window = new EventTarget();
window.setInterval = setInterval;
globalThis.location = { origin: "https://reader.test" };
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: false },
  configurable: true,
});
globalThis.caches = {
  keys: async () => ["reader-media-user%40test", "reader-shell-v1"],
  delete: async (name) => deleted.push(name),
};
const deleted = [];
const at = "2026-01-01T00:00:00.000Z";
const article = {
  id: "one",
  title: "Saved",
  createdAt: at,
  updatedAt: at,
  folderId: "default",
  sentenceCount: 10,
  estimatedMinutes: 1,
  progress: { sentenceIndex: 0, percent: 0, updatedAt: at },
  blocks: [],
  textContent: "Saved offline",
};
async function db() {
  return new Promise((resolve) => {
    const r = indexedDB.open("reader-offline-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
  });
}
async function put(entries) {
  const d = await db();
  await new Promise((resolve) => {
    const t = d.transaction("kv", "readwrite");
    for (const [k, v] of entries) t.objectStore("kv").put(v, k);
    t.oncomplete = resolve;
  });
  d.close();
}
async function get(key) {
  const d = await db();
  const value = await new Promise((resolve) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result);
  });
  d.close();
  return value;
}
await put([
  ["activeOwner", "user@test"],
  ["auth", { email: "user@test", authorized: true }],
  ["user@test:article:one", article],
  ["user@test:summaries", [article]],
  ["user@test:folders", [{ id: "default", slug: "default" }]],
]);
globalThis.fetch = async () => {
  throw new TypeError("Network disconnected");
};
const { offlineRequest, clearOfflineLibrary, synchronize } =
  await import("../src/lib/offlineLibrary.ts");

test("cold offline library reads, reversible progress, folder creation, deletion and account cleanup", async () => {
  assert.equal(
    (await (await offlineRequest("/api/articles?location=all")).json()).total,
    1,
  );
  assert.equal(
    (await (await offlineRequest("/api/articles/one")).json()).article
      .textContent,
    "Saved offline",
  );
  for (const sentenceIndex of [8, 2])
    await offlineRequest("/api/articles/one", {
      method: "PATCH",
      body: JSON.stringify({
        progress: { sentenceIndex, percent: sentenceIndex / 10 },
      }),
    });
  let queue = await get("user@test:queue");
  assert.equal(queue.length, 1);
  assert.equal(
    queue[0].body.progress.sentenceIndex,
    2,
    "a backward seek must replace the previous local position",
  );
  assert.equal(
    (await (await offlineRequest("/api/articles/one")).json()).article.progress
      .percent,
    0.2,
  );
  const { folder } = await (
    await offlineRequest("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: "Research" }),
    })
  ).json();
  await offlineRequest("/api/articles/one", {
    method: "PATCH",
    body: JSON.stringify({
      organization: { folderId: folder.id, archived: true },
    }),
  });
  assert.equal(
    (await (await offlineRequest("/api/articles?location=all")).json()).total,
    0,
  );
  assert.equal(
    (await (await offlineRequest("/api/articles?location=archive")).json())
      .total,
    1,
  );
  queue = await get("user@test:queue");
  assert.equal(
    queue[1].target,
    "/api/folders",
    "folder must replay before the move into it",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  navigator.onLine = true;
  globalThis.fetch = async (url) =>
    url === "/api/auth/me"
      ? Response.json({ email: "user@test", authorized: true })
      : new Response("unavailable", { status: 503 });
  await assert.rejects(() => synchronize());
  assert.equal(
    (await get("user@test:queue")).length,
    3,
    "failed replay must preserve durable changes",
  );
  const replay = [];
  const current = {
    ...(await get("user@test:article:one")),
    updatedAt: new Date(Date.now() + 1000).toISOString(),
    textContent: "Updated through batch sync",
  };
  globalThis.caches.open = async () => ({
    keys: async () => [],
    match: async () => undefined,
    put: async () => {},
  });
  globalThis.fetch = async (url, init) => {
    if (url === "/api/auth/me")
      return Response.json({ email: "user@test", authorized: true });
    if (url === "/api/offline/mutations") {
      replay.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    if (url === "/api/offline/snapshot")
      return Response.json({
        owner: "user@test",
        articles: [current],
        folders: [folder],
        imports: [],
      });
    if (url.startsWith("/api/offline/articles?"))
      return Response.json({ articles: [current] });
    throw new Error("Unexpected network request: " + url);
  };
  await synchronize();
  assert.equal((await get("user@test:queue")).length, 0);
  assert.equal(
    (await get("user@test:article:one")).textContent,
    "Updated through batch sync",
  );
  assert.deepEqual(
    replay.map((o) => o.method),
    ["PATCH", "POST", "PATCH"],
  );
  navigator.onLine = false;
  globalThis.fetch = async () => {
    throw new TypeError("Network disconnected");
  };
  await offlineRequest("/api/articles/one", { method: "DELETE" });
  assert.equal(
    (await (await offlineRequest("/api/articles?location=archive")).json())
      .total,
    0,
  );
  assert.equal(await get("user@test:article:one"), undefined);
  await clearOfflineLibrary();
  assert.equal(await get("activeOwner"), undefined);
  assert.deepEqual(deleted, ["reader-media-user%40test"]);
  await assert.rejects(() => offlineRequest("/api/articles?location=all"));
});
