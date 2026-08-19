import { createHash } from "node:crypto";
import { narrationSentenceMapFingerprint } from "@/lib/narrationPlayback";
import { annotateBlocks, type SentenceSegment } from "@/lib/sentences";
import type { Article } from "@/lib/types";
import {
  articleNarrationProfileFor,
  detectArticleNarrationLanguage,
  type ArticleNarrationProfile,
} from "@/server/articles/articleNarrationProfiles";
import {
  comparableNarrationText,
  narrationSourceSha256,
  normalizeNarrationInput,
  sha256Text,
} from "@/server/articles/articleNarrationQa";

export const narrationChunkerVersion = 1;

export type ArticleNarrationUnit = {
  sentenceIndex: number;
  sentenceText: string;
  speechText: string;
};

export type ArticleNarrationChunkPart = {
  sentenceIndex: number;
  sentenceText: string;
  speechText: string;
  unitPartIndex: number;
  comparableText: string;
  comparableStart: number;
  comparableEnd: number;
};

export type ArticleNarrationChunk = {
  index: number;
  input: string;
  inputCodePoints: number;
  inputSha256: string;
  expectedComparableText: string;
  parts: ArticleNarrationChunkPart[];
};

export type PreparedArticleNarration = {
  articleId: string;
  title: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  generationFingerprint: string;
  profile: ArticleNarrationProfile;
  units: ArticleNarrationUnit[];
  chunks: ArticleNarrationChunk[];
};

export class ArticleNarrationPreparationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ArticleNarrationPreparationError";
    this.code = code;
  }
}

export function prepareArticleNarration(
  article: Pick<Article, "id" | "title" | "textContent" | "blocks">,
  options: {
    profile?: ArticleNarrationProfile;
    targetCodePoints?: number;
    maximumCodePoints?: number;
  } = {},
): PreparedArticleNarration {
  const profile =
    options.profile ??
    profileForArticle(article.title, article.textContent);
  const targetCodePoints = positiveChunkLimit(
    options.targetCodePoints,
    profile.chunkTargetCodePoints,
  );
  const maximumCodePoints = positiveChunkLimit(
    options.maximumCodePoints,
    profile.chunkMaximumCodePoints,
  );

  if (maximumCodePoints > 3_800) {
    throw new ArticleNarrationPreparationError(
      "Narration chunks cannot exceed 3,800 Unicode code points.",
      "chunk-limit",
    );
  }
  if (targetCodePoints > maximumCodePoints) {
    throw new ArticleNarrationPreparationError(
      "Narration chunk target cannot exceed its maximum.",
      "chunk-limit",
    );
  }

  const annotated = annotateBlocks(article.blocks);
  const units = narrationUnits(
    article.title,
    article.textContent,
    annotated.sentences,
    profile,
  );

  if (units.length < 2) {
    throw new ArticleNarrationPreparationError(
      "The article has no narratable body text.",
      "empty-article",
    );
  }

  const chunks = planNarrationChunks(units, {
    targetCodePoints,
    maximumCodePoints,
  });
  const sourceTextSha256 = narrationSourceSha256(
    article.title,
    article.textContent,
  );
  const sentenceMapFingerprint = narrationSentenceMapFingerprint(
    annotated.sentences,
  );
  const generationFingerprint = sha256Text(
    stableStringify({
      sourceTextSha256,
      sentenceMapFingerprint,
      profile: {
        id: profile.id,
        version: profile.version,
        language: profile.language,
        speechModel: profile.speechModel,
        voice: profile.voice,
        speechInstructions: profile.speechInstructions ?? null,
        transcriptionModel: profile.transcriptionModel,
        responseFormat: profile.responseFormat,
        speed: profile.speed,
      },
      chunker: {
        version: narrationChunkerVersion,
        targetCodePoints,
        maximumCodePoints,
      },
      chunks: chunks.map(({ inputSha256 }) => inputSha256),
    }),
  );

  return {
    articleId: article.id,
    title: article.title,
    sourceTextSha256,
    sentenceMapFingerprint,
    generationFingerprint,
    profile,
    units,
    chunks,
  };
}

export function planNarrationChunks(
  units: ArticleNarrationUnit[],
  limits: {
    targetCodePoints: number;
    maximumCodePoints: number;
  },
): ArticleNarrationChunk[] {
  const targetCodePoints = positiveChunkLimit(
    limits.targetCodePoints,
    2_800,
  );
  const maximumCodePoints = positiveChunkLimit(
    limits.maximumCodePoints,
    3_800,
  );

  if (targetCodePoints > maximumCodePoints || maximumCodePoints > 3_800) {
    throw new ArticleNarrationPreparationError(
      "Invalid narration chunk limits.",
      "chunk-limit",
    );
  }

  const fragments = units.flatMap((unit) =>
    splitNarrationUnit(unit, maximumCodePoints),
  );
  const chunkFragments: Array<typeof fragments> = [];
  let pending: typeof fragments = [];
  let pendingCodePoints = 0;

  for (const fragment of fragments) {
    const fragmentLength = codePointLength(fragment.speechText);
    const separatorLength = pending.length > 0 ? 2 : 0;
    const nextLength = pendingCodePoints + separatorLength + fragmentLength;

    if (
      pending.length > 0 &&
      (nextLength > targetCodePoints || nextLength > maximumCodePoints)
    ) {
      chunkFragments.push(pending);
      pending = [];
      pendingCodePoints = 0;
    }

    const nextSeparatorLength = pending.length > 0 ? 2 : 0;
    pending.push(fragment);
    pendingCodePoints += nextSeparatorLength + fragmentLength;

    if (pendingCodePoints > maximumCodePoints) {
      throw new ArticleNarrationPreparationError(
        "A narration fragment exceeded its maximum size.",
        "chunk-limit",
      );
    }
  }

  if (pending.length > 0) {
    chunkFragments.push(pending);
  }

  return chunkFragments.map((fragmentsForChunk, index) => {
    const input = fragmentsForChunk
      .map(({ speechText }) => speechText)
      .join("\n\n");
    let comparableCursor = 0;
    const parts = fragmentsForChunk.map((fragment) => {
      const comparableText = comparableNarrationText(fragment.speechText);
      const comparableStart = comparableCursor;
      comparableCursor += comparableText.length;

      return {
        ...fragment,
        comparableText,
        comparableStart,
        comparableEnd: comparableCursor,
      };
    });

    return {
      index,
      input,
      inputCodePoints: codePointLength(input),
      inputSha256: sha256Text(input),
      expectedComparableText: parts
        .map(({ comparableText }) => comparableText)
        .join(""),
      parts,
    };
  });
}

export function narrationSegmentArtifactKey(input: {
  articleId: string;
  generationFingerprint: string;
  chunkIndex: number;
  inputSha256: string;
  attempt: number;
}) {
  if (
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1
  ) {
    throw new ArticleNarrationPreparationError(
      "Narration segment indexes and attempts must be positive integers.",
      "artifact-key",
    );
  }

  const articlePart = safeArtifactPart(input.articleId);
  const index = input.chunkIndex.toString().padStart(4, "0");

  return (
    `articles/${articlePart}/audio/v2/${input.generationFingerprint}/segments/` +
    `${index}-${input.inputSha256.slice(0, 16)}-attempt-${input.attempt}.mp3`
  );
}

function profileForArticle(title: string, textContent: string) {
  const language = detectArticleNarrationLanguage(title, textContent);

  if (!language) {
    throw new ArticleNarrationPreparationError(
      "Only Chinese and English narration are currently supported.",
      "unsupported-language",
    );
  }

  return articleNarrationProfileFor(language);
}

function narrationUnits(
  title: string,
  textContent: string,
  sentences: SentenceSegment[],
  profile: ArticleNarrationProfile,
) {
  const normalizedTitle = normalizeNarrationInput(title);
  const titleSpeech = ensureTerminalPunctuation(
    normalizedTitle,
    profile.language,
  );
  const comparableBody = comparableNarrationText(textContent);
  const bodyUnits: ArticleNarrationUnit[] = [];
  let bodyCursor = 0;
  let representedBody = "";

  for (const sentence of sentences) {
    const speechText = normalizeNarrationInput(sentence.text);
    const comparableSentence = comparableNarrationText(speechText);

    if (!comparableSentence) {
      continue;
    }

    const bodyOffset = comparableBody.indexOf(
      comparableSentence,
      bodyCursor,
    );

    // Some legacy articles contain image alt/caption blocks that are rendered
    // in the reader but were never included in textContent. textContent is the
    // canonical passage fingerprint and must remain the narration source.
    if (bodyOffset < 0) {
      continue;
    }

    bodyUnits.push({
      sentenceIndex: sentence.sentenceIndex,
      sentenceText: sentence.text,
      speechText,
    });
    representedBody += comparableSentence;
    bodyCursor = bodyOffset + comparableSentence.length;
  }

  if (!comparableBody || representedBody !== comparableBody) {
    throw new ArticleNarrationPreparationError(
      "The article sentence map does not cover its canonical text.",
      "sentence-map-mismatch",
    );
  }

  const comparableTitle = comparableNarrationText(titleSpeech);
  const firstBodyComparable = bodyUnits[0]
    ? comparableNarrationText(bodyUnits[0].speechText)
    : "";
  const standaloneTitle =
    comparableTitle && firstBodyComparable !== comparableTitle
      ? [{
          sentenceIndex: -1,
          sentenceText: title,
          speechText: titleSpeech,
        }]
      : [];

  return [...standaloneTitle, ...bodyUnits];
}

function splitNarrationUnit(
  unit: ArticleNarrationUnit,
  maximumCodePoints: number,
) {
  const fragments = splitSpeechText(unit.speechText, maximumCodePoints);

  return fragments.map((speechText, unitPartIndex) => ({
    sentenceIndex: unit.sentenceIndex,
    sentenceText: unit.sentenceText,
    speechText,
    unitPartIndex,
  }));
}

function splitSpeechText(text: string, maximumCodePoints: number) {
  const characters = Array.from(text);
  const fragments: string[] = [];
  let cursor = 0;

  while (characters.length - cursor > maximumCodePoints) {
    const hardEnd = cursor + maximumCodePoints;
    const preferredStart = cursor + Math.floor(maximumCodePoints * 0.6);
    let splitAt = -1;

    for (let index = hardEnd - 1; index >= preferredStart; index -= 1) {
      if (isNarrationBoundary(characters[index])) {
        splitAt = index + 1;
        break;
      }
    }

    if (splitAt <= cursor) {
      splitAt = hardEnd;
    }

    fragments.push(characters.slice(cursor, splitAt).join(""));
    cursor = splitAt;
  }

  const finalFragment = characters.slice(cursor).join("");
  if (finalFragment) {
    fragments.push(finalFragment);
  }

  return fragments;
}

function ensureTerminalPunctuation(
  text: string,
  language: ArticleNarrationProfile["language"],
) {
  if (!text || /[.!?。！？:：;；]$/u.test(text)) {
    return text;
  }

  return `${text}${language === "zh-CN" ? "。" : "."}`;
}

function isNarrationBoundary(character: string) {
  return /[\n\r.!?。！？;；:：,，、\s]/u.test(character);
}

function positiveChunkLimit(value: number | undefined, fallback: number) {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ArticleNarrationPreparationError(
      "Narration chunk limits must be positive integers.",
      "chunk-limit",
    );
  }

  return resolved;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function safeArtifactPart(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120) || "article";

  return normalized === value
    ? normalized
    : `${normalized}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function stableStringify(value: unknown) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }

  return value;
}
