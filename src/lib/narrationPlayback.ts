import type { SentenceSegment } from "./sentences";
import type {
  ArticleNarrationAlignment,
  ArticleNarrationCue,
} from "./types";

export const narrationTitleSentenceIndex = -1;

export function articleNarrationAudioUrl(articleId: string) {
  return `/api/articles/${encodeURIComponent(articleId)}/audio`;
}

export function narrationSentenceIndexAtProgress(
  sentences: SentenceSegment[],
  progress: number,
) {
  if (sentences.length === 0) {
    return 0;
  }

  const weights = sentences.map(({ text }) => spokenCharacterCount(text));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const normalizedProgress = Math.min(Math.max(progress, 0), 1);

  if (normalizedProgress >= 1) {
    return sentences.at(-1)?.sentenceIndex ?? 0;
  }

  const targetWeight = normalizedProgress * totalWeight;
  let elapsedWeight = 0;

  for (const [index, sentence] of sentences.entries()) {
    elapsedWeight += weights[index];

    if (targetWeight < elapsedWeight) {
      return sentence.sentenceIndex;
    }
  }

  return sentences.at(-1)?.sentenceIndex ?? 0;
}

export function narrationProgressForSentenceIndex(
  sentences: SentenceSegment[],
  sentenceIndex: number,
) {
  if (sentences.length === 0) {
    return 0;
  }

  const weights = sentences.map(({ text }) => spokenCharacterCount(text));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const targetOffset = sentences.findIndex(
    (sentence) => sentence.sentenceIndex >= sentenceIndex,
  );
  const boundedOffset = targetOffset < 0 ? sentences.length - 1 : targetOffset;
  const elapsedWeight = weights
    .slice(0, boundedOffset)
    .reduce((total, weight) => total + weight, 0);

  return totalWeight > 0 ? elapsedWeight / totalWeight : 0;
}

export function narrationSentenceIndexAtTime(
  cues: ArticleNarrationCue[] | undefined,
  currentTime: number,
) {
  if (!cues || cues.length === 0) {
    return null;
  }

  const safeTime = Number.isFinite(currentTime) ? Math.max(currentTime, 0) : 0;
  let low = 0;
  let high = cues.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (cues[middle].startSeconds <= safeTime) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return cues[result].sentenceIndex;
}

export function narrationTimeForSentenceIndex(
  cues: ArticleNarrationCue[] | undefined,
  sentenceIndex: number,
) {
  if (!cues || cues.length === 0) {
    return null;
  }

  const exact = cues.find((cue) => cue.sentenceIndex === sentenceIndex);

  if (exact) {
    return exact.startSeconds;
  }

  const next = cues.find(
    (cue) =>
      cue.sentenceIndex !== narrationTitleSentenceIndex &&
      cue.sentenceIndex > sentenceIndex,
  );

  return (next ?? cues.at(-1))?.startSeconds ?? null;
}

export function narrationSentenceMapFingerprint(sentences: SentenceSegment[]) {
  let hash = 0x811c9dc5;
  const value = sentences
    .map(
      ({ sentenceIndex, text }) =>
        `${sentenceIndex}:${text.normalize("NFKC").replace(/\s+/gu, " ").trim()}`,
    )
    .join("\n");

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function matchingNarrationCues(
  alignment: ArticleNarrationAlignment | undefined,
  sentences: SentenceSegment[],
  title: string,
  durationSeconds?: number,
) {
  if (
    alignment?.version !== 1 ||
    alignment.sentenceMapFingerprint !==
      narrationSentenceMapFingerprint(sentences) ||
    alignment.sentenceCues.length === 0
  ) {
    return undefined;
  }

  const sentenceByIndex = new Map(
    sentences.map((sentence) => [sentence.sentenceIndex, sentence.text]),
  );
  let previousStart = Number.NEGATIVE_INFINITY;

  for (const cue of alignment.sentenceCues) {
    const expectedText =
      cue.sentenceIndex === narrationTitleSentenceIndex
        ? title
        : sentenceByIndex.get(cue.sentenceIndex);

    if (
      !expectedText ||
      comparableCueText(expectedText) !== comparableCueText(cue.sentenceText) ||
      !Number.isFinite(cue.startSeconds) ||
      !Number.isFinite(cue.endSeconds) ||
      cue.startSeconds < 0 ||
      cue.startSeconds <= previousStart ||
      cue.endSeconds <= cue.startSeconds ||
      (typeof durationSeconds === "number" &&
        cue.endSeconds > durationSeconds + 0.5)
    ) {
      return undefined;
    }

    previousStart = cue.startSeconds;
  }

  return alignment.sentenceCues;
}

function comparableCueText(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function spokenCharacterCount(text: string) {
  const spoken = text
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]/gu, "");

  return Math.max(Array.from(spoken).length, 1);
}
