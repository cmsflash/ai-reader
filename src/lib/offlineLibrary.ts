import {
  filterAndSortArticles,
  type ArticleImportSummary,
  type ArticleListLocation,
  type ArticleListSortMode,
} from "./articleList";
import { articleImageSourceCandidates, proxiedImageSrc } from "./articleImage";
import type { Article, ArticleFolder, ArticleSummary } from "./types";

type Auth = {
  email?: string;
  authenticated?: boolean;
  authorized?: boolean;
  enabled?: boolean;
};
type Operation = {
  id: string;
  target: string;
  method: string;
  body?: Record<string, unknown>;
  at: string;
};
const databaseName = "reader-offline-v1";
let owner: string | null = null;
let initialization: Promise<void> | undefined;
let syncing = false;
let syncAgain = false;
let generation = 0;
let signedOut = false;
let channel: BroadcastChannel | undefined;
let notice = "Preparing offline library…";
export function offlineNotice() {
  return notice;
}
function report(message: string) {
  notice = message;
  window.dispatchEvent(new Event("reader-offline-status"));
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function read<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const request = tx.objectStore("kv").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
async function write(entries: [string, unknown][], removals: string[] = []) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    entries.forEach(([key, value]) => store.put(value, key));
    removals.forEach((key) => store.delete(key));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
function key(name: string) {
  return `${owner}:${name}`;
}
async function locked<T>(action: () => Promise<T>) {
  return navigator.locks
    ? navigator.locks.request("reader-offline", action)
    : action();
}
export async function clearOfflineLibrary() {
  signedOut = true;
  generation++;
  owner = null;
  try {
    sessionStorage.removeItem("ai-reader:history-metadata");
  } catch {
    /* Storage may be unavailable. */
  }
  channel?.postMessage("cleared");
  window.dispatchEvent(new Event("reader-offline-cleared"));
  await locked(async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    for (const name of await caches.keys())
      if (name.startsWith("reader-media-")) await caches.delete(name);
    initialization = undefined;
  });
}
async function authenticate() {
  if (signedOut) throw new Error("Sign in to sync your library.");
  const epoch = generation;
  const previous = await read<string>("activeOwner");
  try {
    const response = await fetch("/api/auth/me", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (epoch !== generation || signedOut) throw new Error("Session changed.");
    if (response.status === 401 || response.status === 403)
      await clearOfflineLibrary();
    if (!response.ok) throw new Error("Authentication unavailable");
    const auth = (await response.json()) as Auth;
    if (epoch !== generation || signedOut) throw new Error("Session changed.");
    if (!auth.authorized || !auth.email) {
      await clearOfflineLibrary();
      throw new Error("Sign in to sync your library.");
    }
    const next = auth.email.toLowerCase();
    if (previous && previous !== next) {
      await clearOfflineLibrary();
      signedOut = false;
    }
    const authEpoch = generation;
    await locked(async () => {
      if (generation !== authEpoch || signedOut)
        throw new Error("Session changed.");
      owner = next;
      await write([
        ["activeOwner", owner],
        ["auth", auth],
      ]);
    });
    if (previous && previous !== next) location.reload();
  } catch (error) {
    if (signedOut) throw error;
    const retained = await read<string>("activeOwner");
    if (!retained) throw error;
    owner = retained;
  }
}
function initialize() {
  return (initialization ??= authenticate().catch((error) => {
    initialization = undefined;
    throw error;
  }));
}
export async function offlineAuth() {
  await initialize();
  return read<Auth>("auth");
}
export function startOfflineSync() {
  if (typeof BroadcastChannel !== "undefined") {
    channel ??= new BroadcastChannel("reader-offline-session");
    channel.onmessage = () => {
      signedOut = true;
      generation++;
      owner = null;
      location.assign("/sign-in");
    };
  }
  const run = () => {
    void synchronize().catch((error) =>
      report(
        error instanceof DOMException && error.name === "QuotaExceededError"
          ? "Device storage is full. Offline sync will retry automatically."
          : "Offline sync interrupted. Will retry when connected.",
      ),
    );
  };
  void navigator.storage?.persist?.().catch(() => undefined);
  run();
  const timer = window.setInterval(run, 60000);
  window.addEventListener("online", run);
  navigator.serviceWorker?.addEventListener("controllerchange", run);
  const offline = () => report("Offline · changes saved on this device");
  window.addEventListener("offline", offline);
  return () => {
    navigator.serviceWorker?.removeEventListener("controllerchange", run);
    clearInterval(timer);
    window.removeEventListener("online", run);
    window.removeEventListener("offline", offline);
  };
}
export async function synchronize() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    await initialize();
    if (!navigator.onLine) {
      report("Offline · changes saved on this device");
      return;
    }
    await authenticate();
    const account = owner;
    const epoch = generation;
    const valid = () => owner === account && generation === epoch;
    // Hold the cross-tab lock through replay so a newly queued change cannot be lost.
    await locked(async () => {
      const queue = (await read<Operation[]>(key("queue"))) ?? [];
      while (queue.length && valid()) {
        const response = await fetch("/api/offline/mutations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(queue[0]),
          signal: AbortSignal.timeout(20000),
        });
        if (response.status === 401 || response.status === 403)
          throw new Error("Sign in to sync changes.");
        if (!response.ok) throw new Error("A saved change could not sync.");
        queue.shift();
        await write([[key("queue"), queue]]);
      }
    });
    if (!valid()) return;
    const response = await fetch("/api/offline/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("Library sync unavailable");
    const snapshot = (await response.json()) as {
      owner: string;
      articles: ArticleSummary[];
      folders: ArticleFolder[];
      imports: ArticleImportSummary[];
    };
    if (!valid() || snapshot.owner !== account) return;
    const old = (await read<ArticleSummary[]>(key("summaries"))) ?? [];
    let complete = 0;
    // Bodies first: images and narration never delay offline reading of other articles.
    await concurrent(snapshot.articles, 4, async (summary) => {
      if (!valid()) return;
      const stored = await read<Article>(key(`article:${summary.id}`));
      if (
        !stored ||
        stored.updatedAt !== summary.updatedAt ||
        stored.progress.updatedAt !== summary.progress.updatedAt
      ) {
        const articleResponse = await fetch(
          `/api/articles/${encodeURIComponent(summary.id)}`,
          { signal: AbortSignal.timeout(20000) },
        );
        if (!articleResponse.ok) {
          if (articleResponse.status === 404) return;
          throw new Error("Article sync failed");
        }
        const { article } = (await articleResponse.json()) as {
          article: Article;
        };
        await locked(async () => {
          if (!valid()) return;
          const queue = (await read<Operation[]>(key("queue"))) ?? [];
          if (!queue.some((o) => o.target === `/api/articles/${summary.id}`))
            await write([[key(`article:${summary.id}`), article]]);
        });
      }
      report(
        `Preparing offline library · ${++complete}/${snapshot.articles.length} articles`,
      );
    });
    await locked(async () => {
      if (!valid()) return;
      const queue = (await read<Operation[]>(key("queue"))) ?? [];
      const pending = new Set(queue.map((o) => o.target));
      const local = (await read<ArticleSummary[]>(key("summaries"))) ?? [];
      const merged = snapshot.articles.filter(
        (a) => !pending.has(`/api/articles/${a.id}`),
      );
      merged.push(...local.filter((a) => pending.has(`/api/articles/${a.id}`)));
      const remoteIds = new Set(snapshot.articles.map((a) => a.id));
      const removed = old.filter(
        (a) => !remoteIds.has(a.id) && !pending.has(`/api/articles/${a.id}`),
      );
      const folders = (await read<ArticleFolder[]>(key("folders"))) ?? [];
      const pendingFolderIds = new Set(
        queue
          .filter((o) => o.target === "/api/folders")
          .map((o) => `offline-${o.id}`),
      );
      await write(
        [
          [key("imports"), snapshot.imports ?? []],
          [key("summaries"), merged],
          [
            key("folders"),
            [
              ...snapshot.folders,
              ...folders.filter((f) => pendingFolderIds.has(f.id)),
            ],
          ],
        ],
        removed.map((a) => key(`article:${a.id}`)),
      );
    });
    window.dispatchEvent(new Event("reader-offline-synced"));
    const media = await caches.open(
      `reader-media-${encodeURIComponent(account!)}`,
    );
    const wanted = new Set<string>();
    let failed = 0;
    await concurrent(snapshot.articles, 4, async (summary) => {
      if (!valid()) return;
      const article = await read<Article>(key(`article:${summary.id}`));
      if (!article) return;
      const urls = new Set<string>();
      const fallbacks = new Map<string, string[]>();
      if (article.thumbnailUrl)
        urls.add(proxiedImageSrc(article.thumbnailUrl, article.sourceUrl));
      for (const block of article.blocks)
        if (block.type === "image") {
          const candidates = articleImageSourceCandidates(
            block.src,
            block.originalSrc,
            article.sourceUrl,
          );
          if (candidates[0]) {
            urls.add(candidates[0]);
            fallbacks.set(candidates[0], candidates.slice(1));
          }
        }
      const narration = article.narration;
      if (narration) {
        const segments = narration.segments ?? [];
        if (segments.length > 1)
          for (const s of segments)
            urls.add(
              `/api/articles/${encodeURIComponent(article.id)}/audio?segment=${s.index}`,
            );
        else urls.add(`/api/articles/${encodeURIComponent(article.id)}/audio`);
      }
      const mediaVersion = JSON.stringify([
        narration?.generationFingerprint,
        narration?.generatedAt,
        [...urls],
      ]);
      const changed =
        (await read<string>(key(`media:${article.id}`))) !== mediaVersion;
      let allSaved = true;
      for (const url of urls) {
        const absolute = new URL(url, location.origin);
        if (absolute.origin !== location.origin) continue;
        wanted.add(absolute.href);
        if (!changed && (await media.match(absolute.href))) continue;
        report(`Saving images and audio · ${article.title}`);
        try {
          let resource: Response | undefined;
          for (const candidate of [
            absolute.href,
            ...(fallbacks.get(url) ?? []),
          ]) {
            try {
              const resolved = new URL(candidate, location.origin);
              if (resolved.origin !== location.origin) continue;
              const fetched = await fetch(resolved.href, {
                cache: "reload",
                signal: AbortSignal.timeout(30000),
              });
              if (fetched.ok && fetched.status !== 206) {
                resource = fetched;
                break;
              }
            } catch {
              /* Try the original image if its stored artifact is missing. */
            }
          }
          if (!resource) throw new Error("Media unavailable");
          if (!valid()) return;
          await media.put(absolute.href, resource);
        } catch {
          failed++;
          allSaved = false;
        }
      }
      if (valid() && allSaved)
        await write([[key(`media:${article.id}`), mediaVersion]]);
    });
    if (!valid()) return;
    for (const request of await media.keys())
      if (!wanted.has(request.url)) await media.delete(request);
    if (navigator.serviceWorker && !navigator.serviceWorker.controller) {
      report("Articles saved · preparing offline startup…");
      return;
    }
    report(
      failed
        ? `Articles available offline · ${failed} media files will retry`
        : "Library available offline",
    );
  } finally {
    syncing = false;
    if (syncAgain && !signedOut) {
      syncAgain = false;
      void synchronize().catch(() =>
        report("Offline sync interrupted. Will retry automatically."),
      );
    }
  }
}

export async function offlineRequest(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    await initialize();
  } catch (error) {
    report("Offline storage unavailable. Retrying automatically.");
    if (navigator.onLine && !signedOut) return fetch(url, init);
    throw error;
  }
  if (signedOut) throw new Error("Sign in to use your library.");
  const epoch = generation;
  const method = init?.method ?? "GET";
  const target = url.split("?")[0];
  if (
    ((method === "PATCH" || method === "DELETE") &&
      /^\/api\/articles\/[^/]+$/.test(target)) ||
    (method === "POST" && target === "/api/folders")
  ) {
    const response = await locked(async () => {
      const id = crypto.randomUUID();
      const at = new Date().toISOString();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const operation: Operation = { id, at, target, method, body };
      const queue = (await read<Operation[]>(key("queue"))) ?? [];
      let summaries = (await read<ArticleSummary[]>(key("summaries"))) ?? [];
      const entries: [string, unknown][] = [];
      const removals: string[] = [];
      let result: unknown;
      if (target === "/api/folders") {
        if (
          typeof body?.name !== "string" ||
          !body.name.trim() ||
          body.name.trim().length > 80
        )
          throw new Error("Folder names must be 1–80 characters.");
        const folder: ArticleFolder = {
          id: `offline-${id}`,
          name: body.name.trim(),
          isArchive: false,
          createdAt: at,
          updatedAt: at,
        };
        const folders = (await read<ArticleFolder[]>(key("folders"))) ?? [];
        entries.push([key("folders"), [...folders, folder]]);
        result = { folder };
      } else {
        const articleId = decodeURIComponent(
          target.slice("/api/articles/".length),
        );
        let article = await read<Article>(key(`article:${articleId}`));
        if (!article && navigator.onLine) {
          const response = await fetch(target);
          if (response.ok) article = (await response.json()).article;
        }
        if (!article)
          throw new Error(
            "This article has not finished syncing to this device.",
          );
        if (method === "DELETE") {
          summaries = summaries.filter((a) => a.id !== articleId);
          removals.push(key(`article:${articleId}`));
          result = { ok: true };
        } else {
          if (body.progress)
            article.progress = {
              ...article.progress,
              ...body.progress,
              percent: Math.min(1, Math.max(0, body.progress.percent)),
              sentenceIndex: Math.min(Math.max(0, body.progress.sentenceIndex), Math.max(0, article.sentenceCount - 1)),
              updatedAt: at,
            };
          if (body.organization) {
            if (typeof body.organization.archived === "boolean")
              article.archivedAt = body.organization.archived ? at : undefined;
            if (body.organization.folderId)
              article.folderId = body.organization.folderId;
            else if (body.organization.archived === false) {
              const folders =
                (await read<ArticleFolder[]>(key("folders"))) ?? [];
              if (folders.find((f) => f.id === article.folderId)?.isArchive)
                article.folderId =
                  folders.find((f) => f.slug === "default")?.id ??
                  folders.find((f) => !f.isArchive)?.id;
            }
          }
          article.updatedAt = at;
          summaries = [...summaries.filter((a) => a.id !== articleId), article];
          entries.push([key(`article:${articleId}`), article]);
          result = {
            article,
            summary: article,
            organization: {
              id: articleId,
              folderId: article.folderId ?? null,
              archivedAt: article.archivedAt ?? null,
              updatedAt: at,
            },
          };
        }
      }
      if (body?.progress) {
        // Only the latest locally saved position matters, including backward seeks.
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i].target === target && queue[i].body?.progress)
            queue.splice(i, 1);
      }
      if (generation !== epoch || signedOut)
        throw new Error("Session changed.");
      queue.push(operation);
      entries.push([key("queue"), queue], [key("summaries"), summaries]);
      await write(entries, removals);
      report(
        navigator.onLine
          ? "Saving changes…"
          : "Offline · changes saved on this device",
      );
      return Response.json(result);
    });
    void synchronize().catch(() =>
      report("Changes saved on device · sync will retry"),
    );
    return response;
  }
  if (method === "GET") {
    const summaries = await read<ArticleSummary[]>(key("summaries"));
    const folders = await read<ArticleFolder[]>(key("folders"));
    if (target === "/api/folders" && folders) return Response.json({ folders });
    if (target === "/api/articles" && summaries) {
      const params = new URL(url, location.origin).searchParams;
      const sorted = filterAndSortArticles(
        summaries,
        (params.get("location") ?? "default") as ArticleListLocation,
        (params.get("sort") ?? "saved-desc") as ArticleListSortMode,
        folders?.find((f) => f.slug === "default")?.id,
      );
      const offset =
        Number(params.get("cursor")?.replace("offline:", "") ?? 0) || 0;
      const limit = Number(params.get("limit") ?? 30);
      return Response.json({
        articles: sorted.slice(offset, offset + limit),
        total: sorted.length,
        activeTotal: summaries.filter((a) => !a.archivedAt).length,
        nextCursor:
          offset + limit < sorted.length ? `offline:${offset + limit}` : null,
        imports: (await read<ArticleImportSummary[]>(key("imports"))) ?? [],
      });
    }
    const match = target.match(/^\/api\/articles\/([^/]+)$/);
    if (match) {
      const article = await read<Article>(
        key(`article:${decodeURIComponent(match[1])}`),
      );
      if (article) return Response.json({ article });
    }
  }
  const response = await fetch(url, init);
  if (response.status === 401 || response.status === 403)
    await clearOfflineLibrary();
  if (response.ok && generation === epoch && !signedOut) {
    const data = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (data.article) await rememberArticle(data.article);
    if (data.folders) await write([[key("folders"), data.folders]]);
    if (method !== "GET") void synchronize().catch(() => undefined);
  }
  return response;
}

async function concurrent<T>(
  items: T[],
  count: number,
  action: (item: T) => Promise<void>,
) {
  let index = 0;
  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      while (index < items.length) await action(items[index++]);
    }),
  );
  const failed = results.find((r) => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function rememberArticle(article: Article) {
  const epoch = generation;
  await locked(async () => {
    if (signedOut || epoch !== generation) return;
    const queue = (await read<Operation[]>(key("queue"))) ?? [];
    if (queue.some((o) => o.target === `/api/articles/${article.id}`)) {
      const local = await read<Article>(key(`article:${article.id}`));
      if (local)
        article = {
          ...article,
          progress: local.progress,
          folderId: local.folderId,
          archivedAt: local.archivedAt,
        };
      else return;
    }
    const summaries = await read<ArticleSummary[]>(key("summaries"));
    const entries: [string, unknown][] = [
      [key(`article:${article.id}`), article],
    ];
    if (summaries)
      entries.push([
        key("summaries"),
        [...summaries.filter((a) => a.id !== article.id), article],
      ]);
    await write(entries);
  });
}
