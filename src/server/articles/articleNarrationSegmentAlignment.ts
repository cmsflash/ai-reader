import type { ArticleNarrationCue } from "@/lib/types";
import type { ArticleNarrationChunk } from "@/server/articles/articleNarrationPlan";
import type { ArticleNarrationProfile } from "@/server/articles/articleNarrationProfiles";
import {
  comparableNarrationText,
  sha256Text,
} from "@/server/articles/articleNarrationQa";

export type NarrationTimestampWord = {
  word: string;
  start: number;
  end: number;
};

export type NarrationTimestampTranscription = {
  text: string;
  duration: number;
  words: NarrationTimestampWord[];
};

export type ArticleNarrationSegmentQa = {
  ok: boolean;
  expectedCharacters: number;
  transcriptCharacters: number;
  sourceCoverage: number;
  exactMatchRatio: number;
  maxUnmatchedSourceRun: number;
  maxUnmatchedTranscriptRun: number;
  firstAnchorExactRatio: number;
  lastAnchorExactRatio: number;
  forbiddenQuoteMarkers: string[];
  failures: string[];
};

export type ArticleNarrationSegmentAlignment = {
  model: string;
  transcriptSha256: string;
  durationSeconds: number;
  qa: ArticleNarrationSegmentQa;
  sentenceCues: ArticleNarrationCue[];
};

type TimedCharacter = {
  character: string;
  startSeconds: number;
  endSeconds: number;
};

export function alignNarrationSegment(
  chunk: ArticleNarrationChunk,
  profile: ArticleNarrationProfile,
  transcription: NarrationTimestampTranscription,
): ArticleNarrationSegmentAlignment {
  const expected = Array.from(chunk.expectedComparableText);
  const timedCharacters = timestampCharacters(transcription.words);
  const actual = timedCharacters.map(({ character }) => character);
  const mapping = alignComparableCharacters(expected, actual);
  const sourceCoverage =
    mapping.mappedCount / Math.max(expected.length, 1);
  const exactMatchRatio =
    mapping.exactMatchCount / Math.max(expected.length, 1);
  const anchorLength = Math.min(12, expected.length);
  const firstAnchorExactRatio = exactRatioForRange(
    expected,
    actual,
    mapping.sourceToTranscript,
    0,
    anchorLength,
  );
  const lastAnchorExactRatio = exactRatioForRange(
    expected,
    actual,
    mapping.sourceToTranscript,
    Math.max(expected.length - anchorLength, 0),
    expected.length,
  );
  const transcriptText = transcription.text.trim();
  const forbiddenQuoteMarkers = spokenQuoteMarkers(transcriptText);
  const failures: string[] = [];
  const sentenceCues: ArticleNarrationCue[] = [];

  if (expected.length === 0) {
    failures.push("the expected segment contained no comparable text");
  }
  if (timedCharacters.length === 0) {
    failures.push("timestamp transcription returned no usable words");
  }
  if (sourceCoverage < profile.qa.minimumSourceCoverage) {
    failures.push(
      `source coverage ${(sourceCoverage * 100).toFixed(2)}% is below ` +
        `${(profile.qa.minimumSourceCoverage * 100).toFixed(2)}%`,
    );
  }
  if (exactMatchRatio < profile.qa.minimumExactMatchRatio) {
    failures.push(
      `exact match ratio ${(exactMatchRatio * 100).toFixed(2)}% is below ` +
        `${(profile.qa.minimumExactMatchRatio * 100).toFixed(2)}%`,
    );
  }
  if (
    mapping.maxUnmatchedSourceRun >
    profile.qa.maximumUnmatchedSourceRun
  ) {
    failures.push(
      `a contiguous source span of ${mapping.maxUnmatchedSourceRun} characters was not matched`,
    );
  }
  if (
    mapping.maxUnmatchedTranscriptRun >
    profile.qa.maximumUnmatchedTranscriptRun
  ) {
    failures.push(
      `a contiguous transcript span of ${mapping.maxUnmatchedTranscriptRun} characters was not expected`,
    );
  }
  if (firstAnchorExactRatio < 0.5) {
    failures.push("the beginning of the segment was not transcribed closely enough");
  }
  if (lastAnchorExactRatio < 0.5) {
    failures.push("the end of the segment was not transcribed closely enough");
  }
  if (forbiddenQuoteMarkers.length > 0) {
    failures.push(
      `spoken quote-marker words detected: ${forbiddenQuoteMarkers.join(", ")}`,
    );
  }

  for (const part of chunk.parts) {
    if (!part.comparableText) {
      continue;
    }

    const mapped = mapping.sourceToTranscript
      .slice(part.comparableStart, part.comparableEnd)
      .filter((value): value is number => value !== null);

    if (mapped.length === 0) {
      failures.push(
        `no timestamp was found for sentence ${part.sentenceIndex}`,
      );
      continue;
    }

    const first = timedCharacters[mapped[0]];
    const last = timedCharacters[mapped.at(-1) ?? mapped[0]];

    if (!first || !last || last.endSeconds <= first.startSeconds) {
      failures.push(
        `timestamps were invalid for sentence ${part.sentenceIndex}`,
      );
      continue;
    }

    sentenceCues.push({
      sentenceIndex: part.sentenceIndex,
      sentenceText: part.sentenceText,
      startSeconds: round(first.startSeconds, 3),
      endSeconds: round(last.endSeconds, 3),
    });
  }

  validateLocalTimeline(
    sentenceCues,
    transcription.duration,
    profile,
    failures,
  );

  return {
    model: profile.transcriptionModel,
    transcriptSha256: sha256Text(transcriptText),
    durationSeconds: round(transcription.duration, 3),
    qa: {
      ok: failures.length === 0,
      expectedCharacters: expected.length,
      transcriptCharacters: actual.length,
      sourceCoverage: round(sourceCoverage, 6),
      exactMatchRatio: round(exactMatchRatio, 6),
      maxUnmatchedSourceRun: mapping.maxUnmatchedSourceRun,
      maxUnmatchedTranscriptRun: mapping.maxUnmatchedTranscriptRun,
      firstAnchorExactRatio: round(firstAnchorExactRatio, 6),
      lastAnchorExactRatio: round(lastAnchorExactRatio, 6),
      forbiddenQuoteMarkers,
      failures,
    },
    sentenceCues,
  };
}

export function alignComparableCharacters(
  source: string[],
  transcript: string[],
) {
  const rows = source.length + 1;
  const columns = transcript.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    table[sourceIndex][0] = sourceIndex;
  }
  for (
    let transcriptIndex = 1;
    transcriptIndex < columns;
    transcriptIndex += 1
  ) {
    table[0][transcriptIndex] = transcriptIndex;
  }

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (
      let transcriptIndex = 1;
      transcriptIndex < columns;
      transcriptIndex += 1
    ) {
      const substitution =
        table[sourceIndex - 1][transcriptIndex - 1] +
        (source[sourceIndex - 1] === transcript[transcriptIndex - 1] ? 0 : 1);
      table[sourceIndex][transcriptIndex] = Math.min(
        substitution,
        table[sourceIndex - 1][transcriptIndex] + 1,
        table[sourceIndex][transcriptIndex - 1] + 1,
      );
    }
  }

  const sourceToTranscript = new Array<number | null>(source.length).fill(null);
  let sourceIndex = source.length;
  let transcriptIndex = transcript.length;

  while (sourceIndex > 0 || transcriptIndex > 0) {
    if (sourceIndex > 0 && transcriptIndex > 0) {
      const substitutionCost =
        source[sourceIndex - 1] === transcript[transcriptIndex - 1] ? 0 : 1;

      if (
        table[sourceIndex][transcriptIndex] ===
        table[sourceIndex - 1][transcriptIndex - 1] + substitutionCost
      ) {
        sourceToTranscript[sourceIndex - 1] = transcriptIndex - 1;
        sourceIndex -= 1;
        transcriptIndex -= 1;
        continue;
      }
    }

    if (
      sourceIndex > 0 &&
      table[sourceIndex][transcriptIndex] ===
        table[sourceIndex - 1][transcriptIndex] + 1
    ) {
      sourceIndex -= 1;
      continue;
    }

    transcriptIndex -= 1;
  }

  let mappedCount = 0;
  let exactMatchCount = 0;
  let currentUnmatchedRun = 0;
  let maxUnmatchedSourceRun = 0;
  const mappedTranscript = new Uint8Array(transcript.length);

  for (const [position, mappedIndex] of sourceToTranscript.entries()) {
    if (mappedIndex === null) {
      currentUnmatchedRun += 1;
      maxUnmatchedSourceRun = Math.max(
        maxUnmatchedSourceRun,
        currentUnmatchedRun,
      );
      continue;
    }

    mappedCount += 1;
    mappedTranscript[mappedIndex] = 1;
    if (source[position] === transcript[mappedIndex]) {
      exactMatchCount += 1;
    }
    currentUnmatchedRun = 0;
  }

  currentUnmatchedRun = 0;
  let maxUnmatchedTranscriptRun = 0;

  for (const mapped of mappedTranscript) {
    if (mapped === 0) {
      currentUnmatchedRun += 1;
      maxUnmatchedTranscriptRun = Math.max(
        maxUnmatchedTranscriptRun,
        currentUnmatchedRun,
      );
    } else {
      currentUnmatchedRun = 0;
    }
  }

  return {
    sourceToTranscript,
    mappedCount,
    exactMatchCount,
    maxUnmatchedSourceRun,
    maxUnmatchedTranscriptRun,
  };
}

function timestampCharacters(words: NarrationTimestampWord[]) {
  const characters: TimedCharacter[] = [];

  for (const word of words) {
    if (
      typeof word.word !== "string" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end <= word.start
    ) {
      continue;
    }

    const comparable = Array.from(comparableNarrationText(word.word));
    const duration = word.end - word.start;

    for (const [index, character] of comparable.entries()) {
      characters.push({
        character,
        startSeconds: word.start + (duration * index) / comparable.length,
        endSeconds:
          word.start + (duration * (index + 1)) / comparable.length,
      });
    }
  }

  return characters;
}

function exactRatioForRange(
  source: string[],
  transcript: string[],
  sourceToTranscript: Array<number | null>,
  start: number,
  end: number,
) {
  if (end <= start) {
    return 0;
  }

  let exact = 0;
  for (let index = start; index < end; index += 1) {
    const mapped = sourceToTranscript[index];
    if (mapped !== null && source[index] === transcript[mapped]) {
      exact += 1;
    }
  }

  return exact / (end - start);
}

function validateLocalTimeline(
  cues: ArticleNarrationCue[],
  durationSeconds: number,
  profile: ArticleNarrationProfile,
  failures: string[],
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    failures.push("timestamp transcription returned an invalid duration");
    return;
  }

  for (const [index, cue] of cues.entries()) {
    const previous = cues[index - 1];
    if (
      !Number.isFinite(cue.startSeconds) ||
      !Number.isFinite(cue.endSeconds) ||
      cue.startSeconds < 0 ||
      cue.endSeconds <= cue.startSeconds ||
      cue.endSeconds > durationSeconds + 0.5 ||
      (previous && cue.startSeconds < previous.startSeconds)
    ) {
      failures.push(`cue ${index} did not have a valid ordered timestamp`);
    }
  }

  const first = cues[0];
  const last = cues.at(-1);
  if (
    !first ||
    first.startSeconds > profile.qa.maximumLeadingAudioSeconds
  ) {
    failures.push("timestamps did not cover the beginning of the segment");
  }
  if (
    !last ||
    durationSeconds - last.endSeconds >
      profile.qa.maximumTrailingAudioSeconds
  ) {
    failures.push("timestamps did not cover the end of the segment");
  }
}

function spokenQuoteMarkers(transcript: string) {
  const normalized = transcript.normalize("NFKC").toLocaleLowerCase();
  const patterns = [
    "right handed quotation mark",
    "right-hand quotation mark",
    "right double quotation mark",
    "left handed quotation mark",
    "left-hand quotation mark",
    "left double quotation mark",
    "open quotation mark",
    "close quotation mark",
    "右手引号",
    "右手引號",
    "左手引号",
    "左手引號",
  ];

  return patterns.filter((marker) => normalized.includes(marker));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
