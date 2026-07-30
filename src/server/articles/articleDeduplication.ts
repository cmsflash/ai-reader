import { createHash } from "node:crypto";
import type { Article } from "@/lib/types";

export type ArticleDeduplicationReason =
  | "exact-content"
  | "near-identical-content";

export type ArticleDeduplicationCandidate = Pick<
  Article,
  "id" | "title" | "sourceUrl" | "textContent"
>;

export type ArticleDeduplicationMatch = {
  article: ArticleDeduplicationCandidate;
  reason: ArticleDeduplicationReason;
  similarity: number;
};

type IndexedArticle = {
  article: ArticleDeduplicationCandidate;
  canonicalUrl?: string;
  normalizedTitle: string;
  normalizedContent: string;
  contentHash?: string;
  shingles?: Set<number>;
};

const MIN_EXACT_CONTENT_LENGTH = 40;
export const ARTICLE_CONTENT_FINGERPRINT_VERSION = "v1";
const MIN_NEAR_DUPLICATE_LENGTH = 500;
const MIN_LENGTH_RATIO = 0.82;
const MIN_JACCARD_SIMILARITY = 0.82;
const MIN_CONTAINMENT_SIMILARITY = 0.92;
const SHINGLE_LENGTH = 32;
const MAX_SHINGLES = 6_000;
const SOURCE_WORD_SHINGLE_LENGTH = 8;
const MAX_SOURCE_WORD_SHINGLES = 12_000;
const TRACKING_PARAMETER =
  /^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|_bhlid|trackingId|trk|trkInfo)$/i;
const SUBSTACK_TRACKING_PARAMETER =
  /^(?:publication_id|post_id|isFreemail|r|triedRedirect)$/i;

export class ArticleDeduplicationIndex {
  private readonly entries: IndexedArticle[] = [];
  private readonly entriesByContentHash = new Map<string, IndexedArticle[]>();

  constructor(articles: Iterable<ArticleDeduplicationCandidate> = []) {
    for (const article of articles) {
      this.add(article);
    }
  }

  add(article: ArticleDeduplicationCandidate) {
    const existingIndex = this.entries.findIndex(
      (entry) => entry.article.id === article.id,
    );

    if (existingIndex >= 0) {
      const [existing] = this.entries.splice(existingIndex, 1);

      if (existing.contentHash) {
        removeMapValue(
          this.entriesByContentHash,
          existing.contentHash,
          existing,
        );
      }
    }

    const entry = indexArticle(article);
    this.entries.push(entry);

    if (entry.contentHash) {
      appendMapValue(this.entriesByContentHash, entry.contentHash, entry);
    }
  }

  find(
    article: ArticleDeduplicationCandidate,
    options: { excludeArticleId?: string } = {},
  ): ArticleDeduplicationMatch | null {
    const incoming = indexArticle(article);

    if (incoming.contentHash) {
      const exactMatch = this.entriesByContentHash
        .get(incoming.contentHash)
        ?.filter(
          (candidate) =>
            candidate.article.id !== options.excludeArticleId,
        )
        .sort(compareCanonicalEntries)[0];

      if (exactMatch) {
        return {
          article: exactMatch.article,
          reason: "exact-content",
          similarity: 1,
        };
      }
    }

    if (
      incoming.normalizedContent.length < MIN_NEAR_DUPLICATE_LENGTH ||
      !incoming.shingles
    ) {
      return null;
    }

    let best:
      | {
          entry: IndexedArticle;
          similarity: number;
        }
      | undefined;

    for (const candidate of this.entries) {
      if (
        candidate.article.id === options.excludeArticleId ||
        candidate.normalizedContent.length < MIN_NEAR_DUPLICATE_LENGTH ||
        !candidate.shingles
      ) {
        continue;
      }

      const lengthRatio =
        Math.min(
          incoming.normalizedContent.length,
          candidate.normalizedContent.length,
        ) /
        Math.max(
          incoming.normalizedContent.length,
          candidate.normalizedContent.length,
        );
      const sameCanonicalUrl = Boolean(
        incoming.canonicalUrl &&
          candidate.canonicalUrl === incoming.canonicalUrl,
      );

      if (lengthRatio < MIN_LENGTH_RATIO && !sameCanonicalUrl) {
        continue;
      }

      const similarity = shingleSimilarity(
        incoming.shingles,
        candidate.shingles,
      );
      const sourceContainment = sameCanonicalUrl
        ? sourceWordShingleContainment(
            incoming.normalizedContent,
            candidate.normalizedContent,
          )
        : 0;

      const similarityThresholdMet =
        lengthRatio >= MIN_LENGTH_RATIO
          ? similarity.jaccard >= MIN_JACCARD_SIMILARITY ||
            similarity.containment >= MIN_CONTAINMENT_SIMILARITY ||
            sourceContainment >= 0.7
          : similarity.containment >= 0.97 || sourceContainment >= 0.7;

      if (!similarityThresholdMet) {
        continue;
      }

      const corroborated =
        sameCanonicalUrl ||
        titlesCorroborate(incoming.normalizedTitle, candidate.normalizedTitle) ||
        similarity.jaccard >= 0.9 ||
        similarity.containment >= 0.97;

      if (!corroborated) {
        continue;
      }

      const score = Math.max(
        similarity.jaccard,
        similarity.containment,
        sourceContainment,
      );

      if (
        !best ||
        score > best.similarity ||
        (
          score === best.similarity &&
          compareCanonicalEntries(candidate, best.entry) < 0
        )
      ) {
        best = { entry: candidate, similarity: score };
      }
    }

    return best
      ? {
          article: best.entry.article,
          reason: "near-identical-content",
          similarity: best.similarity,
        }
      : null;
  }
}

function compareCanonicalEntries(left: IndexedArticle, right: IndexedArticle) {
  return left.article.id.localeCompare(right.article.id);
}

export function canonicalizeArticleUrl(rawUrl?: string) {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const substackUrl =
      url.hostname === "substack.com" ||
      url.hostname.endsWith(".substack.com") ||
      (
        url.pathname.startsWith("/p/") &&
        (
          ["publication_id", "post_id", "isFreemail", "triedRedirect"].some(
            (key) => url.searchParams.has(key),
          ) ||
          url.searchParams.get("utm_source")?.toLowerCase() === "substack"
        )
      );

    for (const key of Array.from(url.searchParams.keys())) {
      if (
        TRACKING_PARAMETER.test(key) ||
        (substackUrl && SUBSTACK_TRACKING_PARAMETER.test(key))
      ) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();
    url.pathname =
      url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");

    return url.href;
  } catch {
    return undefined;
  }
}

export function normalizeArticleContent(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function articleContentFingerprint(article: Pick<Article, "textContent">) {
  const normalizedContent = normalizeArticleContent(article.textContent);

  return normalizedContent.length >= MIN_EXACT_CONTENT_LENGTH
    ? `${ARTICLE_CONTENT_FINGERPRINT_VERSION}:${createHash("sha256")
        .update(normalizedContent)
        .digest("hex")}`
    : undefined;
}

function indexArticle(article: ArticleDeduplicationCandidate): IndexedArticle {
  const normalizedContent = normalizeForSimilarity(article.textContent);
  const contentHash = articleContentFingerprint(article);

  return {
    article,
    canonicalUrl: canonicalizeArticleUrl(article.sourceUrl),
    normalizedTitle: normalizeForSimilarity(article.title),
    normalizedContent,
    contentHash,
    shingles:
      normalizedContent.length >= MIN_NEAR_DUPLICATE_LENGTH
        ? contentShingles(normalizedContent)
        : undefined,
  };
}

function normalizeForSimilarity(text: string) {
  return normalizeArticleContent(text);
}

function titlesCorroborate(left: string, right: string) {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;

  return (
    shorter.length >= 12 &&
    shorter.length / longer.length >= 0.72 &&
    longer.includes(shorter)
  );
}

function contentShingles(content: string) {
  const shingles = new Set<number>();
  const maxHeap: number[] = [];

  if (content.length <= SHINGLE_LENGTH) {
    shingles.add(hashShingle(content));
    return shingles;
  }

  forEachRollingShingleHash(content, (hash) => {
    if (maxHeap.length < MAX_SHINGLES) {
      if (!shingles.has(hash)) {
        shingles.add(hash);
        pushMaxHeap(maxHeap, hash);
      }
      return;
    }

    if (hash >= maxHeap[0] || shingles.has(hash)) {
      return;
    }

    shingles.delete(maxHeap[0]);
    shingles.add(hash);
    replaceMaxHeapRoot(maxHeap, hash);
  });
  return shingles;
}

function forEachRollingShingleHash(
  content: string,
  visit: (hash: number) => void,
) {
  const base = 257;
  let highestPower = 1;

  for (let index = 1; index < SHINGLE_LENGTH; index += 1) {
    highestPower = Math.imul(highestPower, base);
  }

  let hash = 0;

  for (let index = 0; index < SHINGLE_LENGTH; index += 1) {
    hash = Math.imul(hash, base) + content.charCodeAt(index);
  }

  visit(hash >>> 0);

  for (let index = SHINGLE_LENGTH; index < content.length; index += 1) {
    const outgoing = content.charCodeAt(index - SHINGLE_LENGTH);
    hash =
      Math.imul(
        hash - Math.imul(outgoing, highestPower),
        base,
      ) + content.charCodeAt(index);
    visit(hash >>> 0);
  }
}

function hashShingle(value: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function pushMaxHeap(heap: number[], value: number) {
  let index = heap.length;
  heap.push(value);

  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);

    if (heap[parent] >= value) {
      break;
    }

    heap[index] = heap[parent];
    index = parent;
  }

  heap[index] = value;
}

function replaceMaxHeapRoot(heap: number[], value: number) {
  let index = 0;

  while (true) {
    const left = index * 2 + 1;

    if (left >= heap.length) {
      break;
    }

    const right = left + 1;
    const child =
      right < heap.length && heap[right] > heap[left] ? right : left;

    if (heap[child] <= value) {
      break;
    }

    heap[index] = heap[child];
    index = child;
  }

  heap[index] = value;
}

function shingleSimilarity(left: Set<number>, right: Set<number>) {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let shared = 0;

  for (const value of smaller) {
    if (larger.has(value)) {
      shared += 1;
    }
  }

  return {
    jaccard: shared / Math.max(left.size + right.size - shared, 1),
    containment: shared / Math.max(smaller.size, 1),
  };
}

function sourceWordShingleContainment(left: string, right: string) {
  const leftTokens = articleTokens(left);
  const rightTokens = articleTokens(right);
  const smaller =
    leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const larger = smaller === leftTokens ? rightTokens : leftTokens;

  if (smaller.length < SOURCE_WORD_SHINGLE_LENGTH) {
    return 0;
  }

  const sampleStep = Math.max(
    1,
    Math.ceil(
      (smaller.length - SOURCE_WORD_SHINGLE_LENGTH + 1) /
        MAX_SOURCE_WORD_SHINGLES,
    ),
  );
  const sampled = tokenShingleHashes(smaller, sampleStep);
  const available = tokenShingleHashes(larger, 1);
  let shared = 0;

  for (const hash of sampled) {
    if (available.has(hash)) {
      shared += 1;
    }
  }

  return shared / Math.max(sampled.size, 1);
}

function articleTokens(content: string) {
  return (
    content.match(
      /\p{Script=Han}|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu,
    ) ?? []
  );
}

function tokenShingleHashes(tokens: string[], step: number) {
  const hashes = new Set<number>();

  for (
    let index = 0;
    index <= tokens.length - SOURCE_WORD_SHINGLE_LENGTH;
    index += step
  ) {
    let hash = 0x811c9dc5;

    for (
      let offset = 0;
      offset < SOURCE_WORD_SHINGLE_LENGTH;
      offset += 1
    ) {
      const token = tokens[index + offset];

      for (let character = 0; character < token.length; character += 1) {
        hash ^= token.charCodeAt(character);
        hash = Math.imul(hash, 0x01000193);
      }

      hash ^= 0;
      hash = Math.imul(hash, 0x01000193);
    }

    hashes.add(hash >>> 0);
  }

  return hashes;
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  const current = map.get(key);

  if (current) {
    current.push(value);
  } else {
    map.set(key, [value]);
  }
}

function removeMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  const current = map.get(key);

  if (!current) {
    return;
  }

  const next = current.filter((candidate) => candidate !== value);

  if (next.length > 0) {
    map.set(key, next);
  } else {
    map.delete(key);
  }
}
