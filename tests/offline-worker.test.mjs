import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { indexedDB } from "fake-indexeddb";

const handlers = {};
const stores = new Map();
const cacheStorage = {
  async keys() {
    return [...stores.keys()];
  },
  async delete(name) {
    return stores.delete(name);
  },
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(key) {
        return store.get(typeof key === "string" ? key : key.url)?.clone();
      },
      async put(key, response) {
        store.set(typeof key === "string" ? key : key.url, response.clone());
      },
      async addAll(keys) {
        for (const key of keys) store.set(key, new Response("js"));
      },
    };
  },
};
let disconnected = false;
const context = vm.createContext({
  self: {
    location: { origin: "https://reader.test" },
    addEventListener: (name, fn) => (handlers[name] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  },
  caches: cacheStorage,
  indexedDB,
  Response,
  Request,
  Headers,
  URL,
  AbortSignal,
  fetch: async () => {
    if (disconnected) throw new TypeError("Disconnected");
    return new Response(
      '<html><script src="/_next/static/app.js"></script>Offline shell</html>',
    );
  },
});
vm.runInContext(
  await readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  context,
);
async function dispatch(name, event = {}) {
  let pending;
  handlers[name]({
    ...event,
    waitUntil: (p) => (pending = p),
    respondWith: (p) => (pending = p),
  });
  return pending;
}
async function setOwner(owner) {
  await new Promise((resolve) => {
    const r = indexedDB.open("reader-offline-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(owner, "activeOwner");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  });
}
test("installs a generic shell and launches without any network", async () => {
  await dispatch("install");
  disconnected = true;
  const response = await dispatch("fetch", {
    request: {
      url: "https://reader.test/?article=one",
      method: "GET",
      mode: "navigate",
    },
  });
  assert.match(await response.text(), /Offline shell/);
  assert.equal(
    await dispatch("fetch", {
      request: {
        url: "https://reader.test/sign-in",
        method: "GET",
        mode: "navigate",
      },
    }),
    undefined,
    "auth pages must never fall back to cached private content",
  );
});
test("cached narration supports seeking and cannot cross accounts", async () => {
  const url = "https://reader.test/api/articles/one/audio";
  await setOwner("one@test");
  const cache = await cacheStorage.open("reader-media-one%40test");
  await cache.put(
    url,
    new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
      headers: { "content-type": "audio/mpeg" },
    }),
  );
  let response = await dispatch("fetch", {
    request: new Request(url, { headers: { range: "bytes=2-4" } }),
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-4/6");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [2, 3, 4],
  );
  response = await dispatch("fetch", {
    request: new Request(url, { headers: { range: "bytes=-2" } }),
  });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5]);
  response = await dispatch("fetch", {
    request: new Request(url, { headers: { range: "bytes=99-" } }),
  });
  assert.equal(response.status, 416);
  await setOwner("two@test");
  await assert.rejects(
    () => dispatch("fetch", { request: new Request(url) }),
    /Disconnected/,
  );
});
