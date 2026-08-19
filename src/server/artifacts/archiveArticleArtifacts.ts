import { createHash } from "node:crypto";
import { blocksToHtml } from "@/lib/extractors";
import { imageFetchHeaders } from "@/server/artifacts/imageRequests";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";
import { fetchPublicImageResource } from "@/server/security/publicArticleUrl";
import type { Article, ArticleBlock } from "@/lib/types";

const maxArtifactBytes = 30 * 1024 * 1024;
const artifactArchiveTimeoutMs = 18_000;

type ArchiveArticleArtifactsOptions = {
  fetchImageResource?: typeof fetchPublicImageResource;
  timeoutMs?: number;
};

export async function archiveArticleArtifacts(
  article: Article,
  options: ArchiveArticleArtifactsOptions = {},
): Promise<Article> {
  let changed = false;
  const archivedBlocks: ArticleBlock[] = [];
  const controller = new AbortController();
  const requestedTimeoutMs = options.timeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? Math.trunc(requestedTimeoutMs)
      : artifactArchiveTimeoutMs;
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    for (const [index, block] of article.blocks.entries()) {
      if (block.type !== "image" || controller.signal.aborted) {
        archivedBlocks.push(block);
        continue;
      }

      const archived = await archiveImageBlock(
        article,
        block,
        index,
        controller.signal,
        options.fetchImageResource ?? fetchPublicImageResource,
      );
      changed ||= archived !== block;
      archivedBlocks.push(archived);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!changed) {
    return article;
  }

  return {
    ...article,
    blocks: archivedBlocks,
    contentHtml: blocksToHtml(archivedBlocks),
  };
}

export async function deleteArticleArtifacts(article: Article) {
  const imageKeys = article.blocks
    .filter((block): block is Extract<ArticleBlock, { type: "image" }> => block.type === "image")
    .map((block) => block.artifactKey)
    .filter((key): key is string => Boolean(key));
  const narrationKeys = article.narration
    ? [
        article.narration.artifactKey,
        ...(article.narration.segments?.map((segment) => segment.artifactKey) ?? []),
      ]
    : [];
  const keys = [...new Set([...imageKeys, ...narrationKeys])];

  await Promise.allSettled(keys.map((key) => getArtifactStorage().delete(key)));
}

async function archiveImageBlock(
  article: Article,
  block: Extract<ArticleBlock, { type: "image" }>,
  index: number,
  signal: AbortSignal,
  fetchImageResource: typeof fetchPublicImageResource,
) {
  const source = remoteImageUrl(block.originalSrc ?? block.src);

  if (!source || block.artifactKey) {
    return block;
  }

  try {
    const sourceUrl = article.sourceUrl ? new URL(article.sourceUrl) : null;
    const resource = await fetchImageResource(
      source.href,
      {
        headers: imageFetchHeaders(source, sourceUrl),
        signal,
      },
      maxArtifactBytes,
    );

    if (!resource) {
      return block;
    }

    const key = artifactKeyForImage(article, source, resource.contentType, index);
    const stored = await getArtifactStorage().put({
      key,
      body: resource.body,
      contentType: resource.contentType,
      visibility: "public",
    });

    return {
      ...block,
      src: stored.url ?? block.src,
      originalSrc: source.href,
      artifactKey: stored.key,
    };
  } catch {
    return block;
  }
}

function remoteImageUrl(value: string | undefined) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function artifactKeyForImage(article: Article, source: URL, contentType: string, index: number) {
  const hash = createHash("sha256").update(source.href).digest("hex").slice(0, 20);
  return `articles/${article.id}/images/${index}-${hash}.${extensionForImage(contentType, source)}`;
}

function extensionForImage(contentType: string, source: URL) {
  const normalizedType = contentType.toLowerCase().split(";")[0].trim();

  switch (normalizedType) {
    case "image/avif":
      return "avif";
    case "image/gif":
      return "gif";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    default: {
      const extension = source.pathname.split(".").at(-1)?.toLowerCase();
      return extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : "bin";
    }
  }
}
