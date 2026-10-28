/** Blob is a cache for recoverable images, not the only copy of user media. */
export type MediaBlob = { pathname: string; url: string; size: number; uploadedAt: Date | string };
export type MediaArticle = { id: string; owner_email: string; blocks: Record<string, unknown>[]; narration: unknown; content_html?: string; thumbnail_url?: string | null; updated_at: string };
export type MediaSegment = { job_id: string; segment_index: number; artifact_key: string | null; job_status: string; job_updated_at: string; updated_at: string };
export type MediaDeletion = MediaBlob & { reason: "unused-image" | "expired-image" | "cancelled-audio" };

export function recoverableImageSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.hostname.endsWith(".vercel-storage.com");
  } catch { return false; }
}

export function planMediaCleanup(
  blobs: MediaBlob[], articles: MediaArticle[], segments: MediaSegment[],
  otherReferences: unknown = [], now = Date.now(),
): MediaDeletion[] {
  const protectedText = JSON.stringify(otherReferences);
  const articleText = articles.map(a => JSON.stringify(a)).join("\n");
  const day = 86_400_000;
  return blobs.flatMap<MediaDeletion>(blob => {
    const age = now - new Date(blob.uploadedAt).getTime();
    if (!Number.isFinite(age) || age < 7 * day) return [];
    // Scope garbage collection to app-generated paths; retain imports, repairs and review fixtures.
    const image = /^articles\/[^/]+\/images\//.test(blob.pathname);
    const audio = /^articles\/[^/]+\/audio\//.test(blob.pathname);
    if (!image && !audio) return [];
    if (protectedText.includes(blob.pathname) || protectedText.includes(blob.url)) return [];
    const referencingSegments = segments.filter(s => s.artifact_key === blob.pathname);
    const inArticles = articleText.includes(blob.pathname) || articleText.includes(blob.url);
    if (audio) {
      if (!inArticles && referencingSegments.length > 0 && referencingSegments.every(s =>
        s.job_status === "cancelled" && now - Date.parse(s.job_updated_at) >= 7 * day))
        return [{ ...blob, reason: "cancelled-audio" as const }];
      return [];
    }
    if (referencingSegments.length) return [];
    if (!inArticles) return [{ ...blob, reason: "unused-image" as const }];
    if (age < 30 * day) return [];
    const references = articles.flatMap(a => a.blocks.filter(b => b.artifactKey === blob.pathname || b.src === blob.url));
    if (!references.length || references.some(b => b.type !== "image" || !recoverableImageSource(b.originalSrc))) return [];
    // A shared image must be recoverable everywhere. Narration and unrecognized references are protected.
    for (const a of articles.filter(a => a.blocks.some(b => b.artifactKey === blob.pathname || b.src === blob.url))) {
      const rewritten = releaseImageReferences(a, new Set([blob.pathname]), new Map([[blob.pathname, blob.url]]));
      if (JSON.stringify(rewritten).includes(blob.pathname) || JSON.stringify(rewritten).includes(blob.url)) return [];
    }
    return [{ ...blob, reason: "expired-image" as const }];
  });
}

export function releaseImageReferences(article: MediaArticle, keys: Set<string>, urls: Map<string, string>): MediaArticle {
  let html = article.content_html;
  let thumbnail = article.thumbnail_url;
  const blocks = article.blocks.map(block => {
    const key = typeof block.artifactKey === "string" ? block.artifactKey : [...urls].find(([, url]) => url === block.src)?.[0];
    if (block.type !== "image" || !key || !keys.has(key) || !recoverableImageSource(block.originalSrc)) return block;
    const oldSources = [block.src, urls.get(key), `/api/artifacts/${key}`].filter((s): s is string => typeof s === "string");
    for (const old of oldSources) {
      if (html) html = html.split(old).join(block.originalSrc).split(old.replaceAll("&", "&amp;")).join(block.originalSrc.replaceAll("&", "&amp;"));
      if (thumbnail === old) thumbnail = block.originalSrc;
    }
    const result: Record<string, unknown> = { ...block, src: block.originalSrc };
    delete result.artifactKey;
    return result;
  });
  return { ...article, blocks, content_html: html, thumbnail_url: thumbnail };
}
