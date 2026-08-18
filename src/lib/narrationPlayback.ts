import type { SentenceSegment } from "./sentences";

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

function spokenCharacterCount(text: string) {
  const spoken = text
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]/gu, "");

  return Math.max(Array.from(spoken).length, 1);
}
