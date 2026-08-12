export type SentenceHighlightState = "playing" | "context-selected" | null;

export function sentenceHighlightState(
  sentenceIndex: number,
  playingSentenceIndex: number | null,
  contextSentenceIndex: number | null,
): SentenceHighlightState {
  if (sentenceIndex === playingSentenceIndex) {
    return "playing";
  }

  if (sentenceIndex === contextSentenceIndex) {
    return "context-selected";
  }

  return null;
}
