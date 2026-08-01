import type { Article, ArticleBlock } from "@/lib/types";

const maxExcerptCharacters = 360;
const lowValueImagePattern = /(?:^|[\s/_-])(avatar|emoji|favicon|icon|logo|profile)(?:[\s/_.-]|$)/i;

export function articleExcerpt(
  article: Pick<Article, "title" | "textContent" | "blocks">,
) {
  const blockCandidates = article.blocks
    .map(textFromBlock)
    .filter(
      (text) =>
        Boolean(text) &&
        !isLikelyPreviewBoilerplate(text) &&
        normalizedComparableText(text) !==
          normalizedComparableText(article.title),
    );
  const blockText =
    blockCandidates.find((text) => text.length >= 80) ??
    blockCandidates.find((text) => text.length >= 40) ??
    blockCandidates[0];
  const fallback = withoutLeadingTitle(article.textContent, article.title);
  return compactPreviewText(blockText || fallback, article.title);
}

export function articleThumbnailUrl(
  article: Pick<Article, "blocks">,
) {
  const candidates = article.blocks
    .filter(
      (block): block is Extract<ArticleBlock, { type: "image" }> =>
        block.type === "image" && Boolean(block.src || block.originalSrc),
    )
    .map((block) => ({
      url: block.src ?? block.originalSrc ?? "",
      descriptor: `${block.alt} ${block.src ?? ""} ${block.originalSrc ?? ""}`,
    }));

  return (
    candidates.find((candidate) => !lowValueImagePattern.test(candidate.descriptor))
      ?.url ?? candidates[0]?.url
  );
}

export function compactPreviewText(value: string | undefined, title = "") {
  const compact = (value ?? "").replace(/\s+/gu, " ").trim();

  if (!compact) {
    return undefined;
  }

  const withoutTitle = withoutLeadingTitle(compact, title);
  const preview = withoutTitle || compact;
  return preview.length > maxExcerptCharacters
    ? `${preview.slice(0, maxExcerptCharacters - 1).trimEnd()}…`
    : preview;
}

function textFromBlock(block: ArticleBlock) {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
    case "code":
      return block.text.trim();
    case "list":
      return block.items.join(" ").trim();
    case "table":
      return block.rows.flat().join(" ").trim();
    case "image":
      return "";
    default:
      block satisfies never;
      return "";
  }
}

function withoutLeadingTitle(value: string, title: string) {
  const compactValue = value.replace(/\s+/gu, " ").trim();
  const compactTitle = title.replace(/\s+/gu, " ").trim();

  if (!compactTitle || !compactValue) {
    return compactValue;
  }

  if (
    compactValue
      .slice(0, compactTitle.length)
      .localeCompare(compactTitle, undefined, { sensitivity: "base" }) === 0
  ) {
    return compactValue
      .slice(compactTitle.length)
      .replace(/^[\s:–—|·-]+/u, "")
      .trim();
  }

  return compactValue;
}

function normalizedComparableText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isLikelyPreviewBoilerplate(value: string) {
  const text = value.replace(/\s+/gu, " ").trim();
  const normalized = text.toLocaleLowerCase();

  if (
    /^(?:updated|published|posted|last updated)\s+(?:on\s+)?/u.test(
      normalized,
    ) ||
    /^(?:share this(?: post)?|in this (?:blog|article))$/u.test(normalized)
  ) {
    return true;
  }

  const rolePattern =
    /\b(?:student researcher|researcher|fellow|vice president|vp|chief [a-z -]+ officer|editor|writer)\b/iu;
  const endsLikeSentence = /[.!?][”"']?$/u.test(text);
  const looksLikeByline =
    !endsLikeSentence && text.split(",").length >= 2 && rolePattern.test(text);
  const looksLikeAuthorBio =
    /^[^.!?]{1,80}\s+(?:is|was)\s+(?:the|a|an)\s+(?:chief|vice president|vp|president|director|professor|researcher|writer|editor|founder|co-founder)\b/iu.test(
      text,
    );
  const looksLikeCredentials =
    /^[^.!?]{1,80}\s+(?:received|earned|holds?)\s+(?:his|her|their|a)\s+(?:ph\.?d|doctorate|master)/iu.test(
      text,
    );

  return looksLikeByline || looksLikeAuthorBio || looksLikeCredentials;
}
