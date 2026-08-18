import type {
  Article,
  ArticleNarrationAlignment,
  ArticleNarrationCue,
} from "@/lib/types";
import {
  matchingNarrationCues,
  narrationSentenceMapFingerprint,
  narrationTitleSentenceIndex,
} from "@/lib/narrationPlayback";
import { annotateBlocks } from "@/lib/sentences";
import type { ArticleRepository } from "@/server/ports/articleRepository";
import type { ArtifactStorage } from "@/server/ports/artifactStorage";
import {
  PilotNarrationError,
  pilotNarrationTarget,
} from "@/server/articles/articleNarrationPilot";
import {
  comparableNarrationText,
  narrationSourceSha256,
  sha256Text,
} from "@/server/articles/articleNarrationQa";

const alignmentModel = "whisper-1";
const openAiBaseUrl = "https://api.openai.com/v1";
const minimumSourceCoverage = 0.95;
const minimumExactMatchRatio = 0.8;
const maximumUnmatchedSourceRun = 4;
const maximumUnmatchedTranscriptRun = 4;
const maximumTrailingAudioSeconds = 5;
const expectedPilotCueCount = 20;
const maximumAudioBytes = 25 * 1024 * 1024;

type TimestampWord = {
  word: string;
  start: number;
  end: number;
};

type TimestampTranscription = {
  text: string;
  duration: number;
  words: TimestampWord[];
};

type AlignmentDependencies = {
  articleRepository: Pick<
    ArticleRepository,
    "addProcessingCost" | "findById" | "updateNarration"
  >;
  artifactStorage: Pick<ArtifactStorage, "get">;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

export type PilotNarrationAlignmentResult = {
  article: Article;
  alignment: ArticleNarrationAlignment;
  alreadyExisted: boolean;
  estimatedCostUsd?: number;
};

type TimedCharacter = {
  character: string;
  startSeconds: number;
  endSeconds: number;
};

type SourceSpan = {
  sentenceIndex: number;
  sentenceText: string;
  start: number;
  end: number;
};

export async function alignPilotArticleNarration(
  articleId: string,
  ownerEmail: string,
  dependencies: AlignmentDependencies,
): Promise<PilotNarrationAlignmentResult> {
  assertPilotTarget(articleId, ownerEmail);
  const article = await dependencies.articleRepository.findById(
    articleId,
    ownerEmail,
  );

  if (!article) {
    throw new PilotNarrationError("Article not found.", 404);
  }

  assertCurrentPilotArticle(article);

  if (!article.narration) {
    throw new PilotNarrationError("This article has no saved narration.", 409);
  }

  const annotatedSentences = annotateBlocks(article.blocks).sentences;
  const sentenceMapFingerprint =
    narrationSentenceMapFingerprint(annotatedSentences);
  const existingAlignment = article.narration.alignment;
  const existingCues = matchingNarrationCues(
    existingAlignment,
    annotatedSentences,
    article.title,
    article.narration.durationSeconds,
  );

  if (
    existingAlignment?.version === 1 &&
    existingAlignment.sentenceMapFingerprint === sentenceMapFingerprint &&
    existingCues?.length === expectedPilotCueCount
  ) {
    return {
      article,
      alignment: existingAlignment,
      alreadyExisted: true,
    };
  }

  const artifact = await dependencies.artifactStorage.get(
    article.narration.artifactKey,
    article.narration.artifactVisibility,
  );

  if (!artifact?.contentType.toLowerCase().startsWith("audio/")) {
    throw new PilotNarrationError("Saved narration audio is unavailable.", 404);
  }
  if (
    artifact.byteLength !== article.narration.byteLength ||
    artifact.body.byteLength !== article.narration.byteLength ||
    artifact.byteLength > maximumAudioBytes
  ) {
    throw new PilotNarrationError(
      "Saved narration audio does not match its metadata.",
      409,
    );
  }

  const apiKey = narrationApiKey(dependencies.apiKey);
  const fetcher = dependencies.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetcher !== "function") {
    throw new PilotNarrationError("OpenAI narration alignment is not configured.", 503);
  }

  const transcription = await transcribeWithTimestamps(
    artifact.body,
    artifact.contentType,
    apiKey,
    fetcher,
  );
  const durationSeconds =
    article.narration.durationSeconds ?? transcription.duration;
  const estimatedCostUsd = round((durationSeconds / 60) * 0.006, 6);
  let alignment: ArticleNarrationAlignment;

  try {
    alignment = buildNarrationAlignment(
      article,
      transcription,
      durationSeconds,
    );
  } catch (error) {
    const costRecorded = await dependencies.articleRepository
      .addProcessingCost(article.id, ownerEmail, estimatedCostUsd)
      .then(Boolean)
      .catch(() => false);

    if (error instanceof PilotNarrationError) {
      throw new PilotNarrationError(error.message, error.status, {
        ...error.details,
        transcript: transcription.text,
        estimatedCostUsd,
        costRecorded,
      });
    }

    throw error;
  }

  const updated = await dependencies.articleRepository.updateNarration(
    article.id,
    ownerEmail,
    {
      ...article.narration,
      alignment,
    },
    estimatedCostUsd,
  );

  if (!updated?.narration?.alignment) {
    throw new PilotNarrationError(
      "Could not attach narration timestamps to the article.",
      500,
    );
  }

  return {
    article: updated,
    alignment: updated.narration.alignment,
    alreadyExisted: false,
    estimatedCostUsd,
  };
}

export function buildNarrationAlignment(
  article: Article,
  transcription: TimestampTranscription,
  durationSeconds: number,
): ArticleNarrationAlignment {
  const annotated = annotateBlocks(article.blocks);
  const { source, spans } = narrationSourceSpans(article, annotated.sentences);
  const timedCharacters = timestampCharacters(transcription.words);
  const sourceCharacters = Array.from(source);

  if (timedCharacters.length === 0) {
    throw new PilotNarrationError(
      "Timestamp transcription returned no usable words.",
      502,
    );
  }

  const mapping = alignSourceCharacters(
    sourceCharacters,
    timedCharacters.map(({ character }) => character),
  );
  const sourceCoverage =
    mapping.mappedCount / Math.max(sourceCharacters.length, 1);
  const exactMatchRatio =
    mapping.exactMatchCount / Math.max(sourceCharacters.length, 1);

  if (
    sourceCoverage < minimumSourceCoverage ||
    exactMatchRatio < minimumExactMatchRatio ||
    mapping.maxUnmatchedSourceRun > maximumUnmatchedSourceRun ||
    mapping.maxUnmatchedTranscriptRun > maximumUnmatchedTranscriptRun
  ) {
    throw new PilotNarrationError(
      "Timestamp transcript did not cover the narration closely enough.",
      422,
      {
        sourceCoverage: round(sourceCoverage, 6),
        exactMatchRatio: round(exactMatchRatio, 6),
        maxUnmatchedSourceRun: mapping.maxUnmatchedSourceRun,
        maxUnmatchedTranscriptRun: mapping.maxUnmatchedTranscriptRun,
        sourceCharacters: sourceCharacters.length,
        timestampedCharacters: timedCharacters.length,
      },
    );
  }

  const sentenceCues = spans.map((span) =>
    cueForSourceSpan(span, mapping.sourceToTranscript, timedCharacters),
  );

  validateCueTimeline(sentenceCues, durationSeconds);

  return {
    version: 1,
    model: alignmentModel,
    generatedAt: new Date().toISOString(),
    transcriptSha256: sha256Text(transcription.text),
    sentenceMapFingerprint: narrationSentenceMapFingerprint(
      annotated.sentences,
    ),
    sourceCoverage: round(sourceCoverage, 6),
    exactMatchRatio: round(exactMatchRatio, 6),
    maxUnmatchedSourceRun: mapping.maxUnmatchedSourceRun,
    maxUnmatchedTranscriptRun: mapping.maxUnmatchedTranscriptRun,
    sentenceCues,
  };
}

function narrationSourceSpans(
  article: Article,
  sentences: ReturnType<typeof annotateBlocks>["sentences"],
) {
  const title = comparableNarrationText(article.title);
  const body = comparableNarrationText(article.textContent);
  const spans: SourceSpan[] = [
    {
      sentenceIndex: narrationTitleSentenceIndex,
      sentenceText: article.title,
      start: 0,
      end: title.length,
    },
  ];
  let cursor = 0;
  let representedBody = "";

  for (const sentence of sentences) {
    const comparable = comparableNarrationText(sentence.text);

    if (!comparable) {
      continue;
    }

    const offset = body.indexOf(comparable, cursor);

    if (offset < 0) {
      continue;
    }

    spans.push({
      sentenceIndex: sentence.sentenceIndex,
      sentenceText: sentence.text,
      start: title.length + offset,
      end: title.length + offset + comparable.length,
    });
    representedBody += comparable;
    cursor = offset + comparable.length;
  }

  if (!title || representedBody !== body || spans.length < 2) {
    throw new PilotNarrationError(
      "The article sentence map does not match the narrated text.",
      409,
      {
        representedBodyCharacters: representedBody.length,
        bodyCharacters: body.length,
      },
    );
  }

  return {
    source: `${title}${body}`,
    spans,
  };
}

function timestampCharacters(words: TimestampWord[]) {
  const characters: TimedCharacter[] = [];

  for (const word of words) {
    if (
      typeof word.word !== "string" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      continue;
    }

    const comparable = Array.from(comparableNarrationText(word.word));
    const duration = word.end - word.start;

    for (const [index, character] of comparable.entries()) {
      characters.push({
        character,
        startSeconds: word.start + (duration * index) / comparable.length,
        endSeconds: word.start + (duration * (index + 1)) / comparable.length,
      });
    }
  }

  return characters;
}

export function alignSourceCharacters(source: string[], transcript: string[]) {
  const rows = source.length + 1;
  const columns = transcript.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    table[sourceIndex][0] = sourceIndex;
  }
  for (let transcriptIndex = 1; transcriptIndex < columns; transcriptIndex += 1) {
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

  for (const [sourcePosition, mappedIndex] of sourceToTranscript.entries()) {
    if (mappedIndex === null) {
      currentUnmatchedRun += 1;
      maxUnmatchedSourceRun = Math.max(
        maxUnmatchedSourceRun,
        currentUnmatchedRun,
      );
    } else {
      mappedCount += 1;
      mappedTranscript[mappedIndex] = 1;
      if (source[sourcePosition] === transcript[mappedIndex]) {
        exactMatchCount += 1;
      }
      currentUnmatchedRun = 0;
    }
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

function cueForSourceSpan(
  span: SourceSpan,
  sourceToTranscript: Array<number | null>,
  timedCharacters: TimedCharacter[],
): ArticleNarrationCue {
  const mapped = sourceToTranscript
    .slice(span.start, span.end)
    .filter((value): value is number => value !== null);

  if (mapped.length === 0) {
    throw new PilotNarrationError(
      `No timestamp was found for sentence ${span.sentenceIndex}.`,
      422,
    );
  }

  const first = timedCharacters[mapped[0]];
  const last = timedCharacters[mapped.at(-1) ?? mapped[0]];

  return {
    sentenceIndex: span.sentenceIndex,
    sentenceText: span.sentenceText,
    startSeconds: round(first.startSeconds, 3),
    endSeconds: round(last.endSeconds, 3),
  };
}

function validateCueTimeline(
  cues: ArticleNarrationCue[],
  durationSeconds: number,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new PilotNarrationError("Narration duration is invalid.", 422);
  }

  for (const [index, cue] of cues.entries()) {
    const previous = cues[index - 1];

    if (
      !Number.isFinite(cue.startSeconds) ||
      !Number.isFinite(cue.endSeconds) ||
      cue.startSeconds < 0 ||
      cue.endSeconds <= cue.startSeconds ||
      cue.endSeconds > durationSeconds + 0.5 ||
      (previous && cue.startSeconds <= previous.startSeconds) ||
      (previous && cue.startSeconds < previous.endSeconds - 0.05)
    ) {
      throw new PilotNarrationError(
        "Narration timestamps were not strictly ordered.",
        422,
        { cueIndex: index, cue },
      );
    }
  }

  const titleCue = cues[0];
  const finalCue = cues.at(-1);

  if (
    titleCue?.sentenceIndex !== narrationTitleSentenceIndex ||
    titleCue.startSeconds > 3 ||
    !finalCue ||
    durationSeconds - finalCue.endSeconds > maximumTrailingAudioSeconds
  ) {
    throw new PilotNarrationError(
      "Narration timestamps did not cover the beginning and end of the audio.",
      422,
      {
        titleStartSeconds: titleCue?.startSeconds,
        finalEndSeconds: finalCue?.endSeconds,
        durationSeconds,
      },
    );
  }

  const bodyCues = cues.slice(1);
  const repeatedTexts = bodyCues
    .map(({ sentenceText }) => comparableNarrationText(sentenceText))
    .filter(
      (text, index, values) =>
        text && values.indexOf(text) !== index,
    );

  for (const repeatedText of new Set(repeatedTexts)) {
    const occurrences = bodyCues.filter(
      ({ sentenceText }) =>
        comparableNarrationText(sentenceText) === repeatedText,
    );

    if (
      occurrences.length < 2 ||
      occurrences.at(-1)!.startSeconds - occurrences[0].startSeconds < 30
    ) {
      throw new PilotNarrationError(
        "Repeated narration passages did not receive distinct timestamps.",
        422,
      );
    }
  }
}

async function transcribeWithTimestamps(
  audio: Buffer,
  contentType: string,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
): Promise<TimestampTranscription> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: contentType }),
    "narration.mp3",
  );
  form.set("model", alignmentModel);
  form.set("language", "zh");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.set("prompt", "黑风山，土地公，鹤发童颜，渔鼓，倨傲");
  const response = await fetcher(`${openAiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new PilotNarrationError(
      `OpenAI timestamp transcription failed (${response.status}): ${await safeResponseError(response)}`,
      502,
    );
  }

  const result = (await response.json()) as Partial<TimestampTranscription>;

  if (
    typeof result.text !== "string" ||
    !Number.isFinite(result.duration) ||
    !Array.isArray(result.words)
  ) {
    throw new PilotNarrationError(
      "OpenAI timestamp transcription returned an invalid response.",
      502,
    );
  }

  return {
    text: result.text,
    duration: result.duration as number,
    words: result.words,
  };
}

function assertPilotTarget(articleId: string, ownerEmail: string) {
  if (
    articleId !== pilotNarrationTarget.id ||
    ownerEmail.trim().toLowerCase() !== pilotNarrationTarget.ownerEmail
  ) {
    throw new PilotNarrationError(
      "This narration pilot is limited to one article.",
      404,
    );
  }
}

function assertCurrentPilotArticle(article: Article) {
  if (
    article.title !== pilotNarrationTarget.title ||
    sha256Text(article.textContent) !== pilotNarrationTarget.bodySha256 ||
    article.narration?.sourceTextSha256 !==
      narrationSourceSha256(article.title, article.textContent)
  ) {
    throw new PilotNarrationError(
      "The pilot article or narration changed; refusing stale alignment.",
      409,
    );
  }
}

function narrationApiKey(explicitKey?: string) {
  return (
    explicitKey?.trim() ??
    process.env.OPENAI_API_KEY_AI_READER?.trim() ??
    process.env.OPENAI_API_KEY?.trim()
  );
}

async function safeResponseError(response: Response) {
  const body = (await response.text()).slice(0, 600);
  return body.replace(/[A-Za-z0-9_-]{24,}/gu, "[redacted]");
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
