const SHELL = `reader-shell-v1${self.location.search || ""}`;
const DB = "reader-offline-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const page = await fetch("/offline", { cache: "reload" });
      if (!page.ok) throw new Error("Offline startup unavailable");
      const html = await page.clone().text();
      const assets = [
        ...new Set(
          [...html.matchAll(/(?:src|href)="([^"<>]+)"/g)]
            .map((match) => match[1].replaceAll("&amp;", "&"))
            .filter((url) => url.startsWith("/_next/static/")),
        ),
      ];
      await cache.addAll(assets);
      await cache.put("/offline", page);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("reader-shell-") && name !== SHELL)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
async function activeOwner() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("kv", "readonly");
      const read = tx.objectStore("kv").get("activeOwner");
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    };
  });
}
async function rangeResponse(request, cached) {
  const range = request.headers.get("range");
  if (!range) return cached;
  const bytes = await cached.arrayBuffer();
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return cached;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, bytes.byteLength - Number(match[2]));
  const end =
    match[1] && match[2]
      ? Math.min(Number(match[2]), bytes.byteLength - 1)
      : bytes.byteLength - 1;
  const headers = new Headers(cached.headers);
  headers.delete("content-encoding");
  headers.set("accept-ranges", "bytes");
  if (start > end || start >= bytes.byteLength) {
    headers.set("content-range", `bytes */${bytes.byteLength}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  if (request.mode === "navigate" && ["/", "/offline"].includes(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, {
            signal: AbortSignal.timeout(4000),
          });
          if (response.status < 500) return response;
          throw new Error("Server unavailable");
        } catch {
          return (await caches.open(SHELL))
            .match("/offline")
            .then((page) => page || Response.error());
        }
      })(),
    );
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  } else if (
    request.cache !== "reload" &&
    (url.pathname === "/api/image" ||
      url.pathname.startsWith("/api/artifacts/") ||
      /^\/api\/articles\/[^/]+\/audio$/.test(url.pathname))
  ) {
    event.respondWith(
      (async () => {
        const owner = await activeOwner();
        if (owner) {
          const cache = await caches.open(
            `reader-media-${encodeURIComponent(owner)}`,
          );
          const cached = await cache.match(url.href);
          if (cached) return rangeResponse(request, cached);
        }
        const response = await fetch(request);
        if (
          owner &&
          response.ok &&
          response.status !== 206 &&
          (await activeOwner()) === owner
        ) {
          const cache = await caches.open(
            `reader-media-${encodeURIComponent(owner)}`,
          );
          try {
            await cache.put(url.href, response.clone());
          } catch {
            /* The client sync reports storage limits and retries. */
          }
        }
        return response;
      })(),
    );
  }
});
