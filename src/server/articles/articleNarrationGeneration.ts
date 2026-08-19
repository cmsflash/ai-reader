import type {
  ArticleNarration,
  ArticleNarrationCue,
  ArticleNarrationSegment,
} from "@/lib/types";
import type { ArtifactStorage } from "@/server/ports/artifactStorage";
import {
  narrationSegmentArtifactKey,
  type ArticleNarrationChunk,
  type PreparedArticleNarration,
} from "@/server/articles/articleNarrationPlan";
import {
  estimateArticleNarrationSegmentCost,
  type ArticleNarrationCost,
  type ArticleNarrationProfile,
} from "@/server/articles/articleNarrationProfiles";
import {
  alignNarrationSegment,
  type ArticleNarrationSegmentQa,
  type NarrationTimestampTranscription,
} from "@/server/articles/articleNarrationSegmentAlignment";
import { sha256Text } from "@/server/articles/articleNarrationQa";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const minimumAudioBytes = 512;
export const maximumNarrationSegmentAudioBytes = 25 * 1024 * 1024;
const maximumTimestampTranscriptionAttempts = 2;

export type GenerateArticleNarrationSegmentInput = {
  articleId: string;
  generationFingerprint: string;
  profile: ArticleNarrationProfile;
  chunk: ArticleNarrationChunk;
  attempt: number;
  persistedSpeechArtifact?: PersistedArticleNarrationSpeechArtifact;
};

export type GenerateArticleNarrationSegmentDependencies = {
  artifactStorage: Pick<ArtifactStorage, "put"> &
    Partial<Pick<ArtifactStorage, "get">>;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  openAiBaseUrl?: string;
};

export type PersistedArticleNarrationSpeechArtifact = {
  artifactKey: string;
  artifactVisibility: "public";
  contentType: string;
  byteLength: number;
};

export type GeneratedArticleNarrationSegment = {
  index: number;
  inputSha256: string;
  inputCodePoints: number;
  generationFingerprint: string;
  profileId: string;
  speechModel: string;
  voice: string;
  alignmentModel: string;
  artifactKey: string;
  artifactVisibility: "public";
  contentType: string;
  byteLength: number;
  durationSeconds: number;
  transcriptSha256: string;
  sentenceCues: ArticleNarrationCue[];
  qa: ArticleNarrationSegmentQa;
  cost: ArticleNarrationCost;
  generatedAt: string;
};

export type AssembledArticleNarration = {
  narration: ArticleNarration;
  totalCostUsd: number;
};

export class ArticleNarrationSegmentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      retryable: boolean;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "ArticleNarrationSegmentError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

export async function generateArticleNarrationSegment(
  input: GenerateArticleNarrationSegmentInput,
  dependencies: GenerateArticleNarrationSegmentDependencies,
): Promise<GeneratedArticleNarrationSegment> {
  validateGenerationInput(input);
  const apiKey = narrationApiKey(dependencies.apiKey);
  const fetcher = dependencies.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetcher !== "function") {
    throw new ArticleNarrationSegmentError(
      "OpenAI narration is not configured.",
      {
        code: "configuration",
        status: 503,
        retryable: false,
      },
    );
  }

  const baseUrl = (
    dependencies.openAiBaseUrl ?? defaultOpenAiBaseUrl
  ).replace(/\/+$/u, "");
  let audio: Buffer;
  let artifact: PersistedArticleNarrationSpeechArtifact;

  if (input.persistedSpeechArtifact) {
    artifact = validatePersistedSpeechArtifact(input.persistedSpeechArtifact);
    audio = await loadPersistedSpeechArtifact(
      artifact,
      dependencies.artifactStorage,
    );
  } else {
    audio = await createSpeech(
      input.chunk.input,
      input.profile,
      apiKey,
      fetcher,
      baseUrl,
    );
    const requestedArtifactKey = narrationSegmentArtifactKey({
      articleId: input.articleId,
      generationFingerprint: input.generationFingerprint,
      chunkIndex: input.chunk.index,
      inputSha256: input.chunk.inputSha256,
      attempt: input.attempt,
    });
    let stored: Awaited<ReturnType<typeof dependencies.artifactStorage.put>>;

    try {
      stored = await dependencies.artifactStorage.put({
        key: requestedArtifactKey,
        body: audio,
        contentType: "audio/mpeg",
        visibility: "public",
      });
    } catch (error) {
      const cost = estimatedFailedGenerationCost(input, 0);

      throw new ArticleNarrationSegmentError(
        "Generated narration could not be persisted.",
        {
          code: "artifact-storage",
          status: 503,
          // The provider may already have charged for this speech. Retrying the
          // whole segment would request and pay for the same audio again.
          retryable: false,
          details: { cause: messageFromError(error), cost },
        },
      );
    }

    artifact = {
      artifactKey: stored.key,
      artifactVisibility: "public",
      contentType: stored.contentType || "audio/mpeg",
      byteLength: stored.byteLength,
    };
  }

  let transcription: NarrationTimestampTranscription;

  try {
    transcription = await transcribeWithWordTimestampsWithRetry(
      audio,
      input.profile,
      apiKey,
      fetcher,
      baseUrl,
    );
  } catch (error) {
    throw withPersistedArtifactDetails(error, {
      ...artifact,
      cost: estimatedFailedGenerationCost(
        input,
        maximumTimestampTranscriptionAttempts,
      ),
    });
  }

  const alignment = alignNarrationSegment(
    input.chunk,
    input.profile,
    transcription,
  );
  const estimatedCost = estimateArticleNarrationSegmentCost(
    input.profile,
    input.chunk.input,
    alignment.durationSeconds,
  );
  const cost = input.persistedSpeechArtifact
    ? {
        ...estimatedCost,
        speechUsd: 0,
        totalUsd: round(
          estimatedCost.alignmentUsd +
            estimatedCost.diagnosticTranscriptUsd,
          6,
        ),
      }
    : estimatedCost;
  if (!alignment.qa.ok) {
    throw new ArticleNarrationSegmentError(
      `Narration segment ${input.chunk.index} did not pass coverage QA: ` +
        alignment.qa.failures.join("; "),
      {
        code: "qa-failed",
        status: 422,
        retryable: false,
        details: {
          ...artifact,
          durationSeconds: alignment.durationSeconds,
          transcriptSha256: alignment.transcriptSha256,
          qa: alignment.qa,
          sentenceCues: alignment.sentenceCues,
          cost,
        },
      },
    );
  }

  return {
    index: input.chunk.index,
    inputSha256: input.chunk.inputSha256,
    inputCodePoints: input.chunk.inputCodePoints,
    generationFingerprint: input.generationFingerprint,
    profileId: input.profile.id,
    speechModel: input.profile.speechModel,
    voice: input.profile.voice,
    alignmentModel: alignment.model,
    ...artifact,
    durationSeconds: alignment.durationSeconds,
    transcriptSha256: alignment.transcriptSha256,
    sentenceCues: alignment.sentenceCues,
    qa: alignment.qa,
    cost,
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
}

export function assembleArticleNarration(
  prepared: PreparedArticleNarration,
  generatedSegments: GeneratedArticleNarrationSegment[],
  options: { now?: () => Date } = {},
): AssembledArticleNarration {
  const ordered = [...generatedSegments].sort(
    (left, right) => left.index - right.index,
  );

  if (
    ordered.length !== prepared.chunks.length ||
    ordered.some((segment, index) => {
      const chunk = prepared.chunks[index];
      return (
        segment.index !== index ||
        segment.inputSha256 !== chunk?.inputSha256 ||
        segment.generationFingerprint !== prepared.generationFingerprint ||
        segment.profileId !== prepared.profile.id ||
        !segment.qa.ok ||
        !Number.isFinite(segment.durationSeconds) ||
        segment.durationSeconds <= 0
      );
    })
  ) {
    throw new ArticleNarrationSegmentError(
      "Completed narration segments do not match the prepared article.",
      {
        code: "segment-mismatch",
        status: 409,
        retryable: false,
      },
    );
  }

  const segments: ArticleNarrationSegment[] = [];
  const cueParts: ArticleNarrationCue[] = [];
  let elapsedSeconds = 0;

  for (const segment of ordered) {
    const startSeconds = round(elapsedSeconds, 3);
    segments.push({
      index: segment.index,
      artifactKey: segment.artifactKey,
      artifactVisibility: segment.artifactVisibility,
      contentType: segment.contentType,
      byteLength: segment.byteLength,
      startSeconds,
      durationSeconds: segment.durationSeconds,
      inputSha256: segment.inputSha256,
    });
    cueParts.push(
      ...segment.sentenceCues.map((cue) => ({
        ...cue,
        startSeconds: round(startSeconds + cue.startSeconds, 3),
        endSeconds: round(startSeconds + cue.endSeconds, 3),
      })),
    );
    elapsedSeconds += segment.durationSeconds;
  }

  const sentenceCues = mergeSplitSentenceCues(cueParts);
  validateAssembledCues(
    prepared,
    sentenceCues,
    elapsedSeconds,
  );

  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const expectedCharacters = ordered.reduce(
    (total, segment) => total + segment.qa.expectedCharacters,
    0,
  );
  const weightedCoverage = ordered.reduce(
    (total, segment) =>
      total + segment.qa.sourceCoverage * segment.qa.expectedCharacters,
    0,
  );
  const weightedExactMatches = ordered.reduce(
    (total, segment) =>
      total + segment.qa.exactMatchRatio * segment.qa.expectedCharacters,
    0,
  );
  const first = ordered[0];
  const narration: ArticleNarration = {
    version: 2,
    artifactKey: first.artifactKey,
    artifactVisibility: first.artifactVisibility,
    contentType: first.contentType,
    byteLength: first.byteLength,
    sourceTextSha256: prepared.sourceTextSha256,
    model: prepared.profile.speechModel,
    voice: prepared.profile.voice,
    generatedAt,
    durationSeconds: round(elapsedSeconds, 3),
    generationFingerprint: prepared.generationFingerprint,
    language: prepared.profile.language,
    profileVersion: prepared.profile.version,
    segments,
    alignment: {
      version: 1,
      model: prepared.profile.transcriptionModel,
      generatedAt,
      transcriptSha256: sha256Text(
        ordered.map(({ transcriptSha256 }) => transcriptSha256).join("\n"),
      ),
      sentenceMapFingerprint: prepared.sentenceMapFingerprint,
      sourceCoverage: round(
        weightedCoverage / Math.max(expectedCharacters, 1),
        6,
      ),
      exactMatchRatio: round(
        weightedExactMatches / Math.max(expectedCharacters, 1),
        6,
      ),
      maxUnmatchedSourceRun: Math.max(
        ...ordered.map(({ qa }) => qa.maxUnmatchedSourceRun),
      ),
      maxUnmatchedTranscriptRun: Math.max(
        ...ordered.map(({ qa }) => qa.maxUnmatchedTranscriptRun),
      ),
      sentenceCues,
    },
  };

  return {
    narration,
    totalCostUsd: round(
      ordered.reduce((total, segment) => total + segment.cost.totalUsd, 0),
      6,
    ),
  };
}

function validatePersistedSpeechArtifact(
  artifact: PersistedArticleNarrationSpeechArtifact,
): PersistedArticleNarrationSpeechArtifact {
  const artifactKey = artifact.artifactKey.trim();
  const contentType = artifact.contentType.trim().toLowerCase();

  if (
    !artifactKey ||
    artifact.artifactVisibility !== "public" ||
    !contentType.startsWith("audio/") ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < minimumAudioBytes ||
    artifact.byteLength > maximumNarrationSegmentAudioBytes
  ) {
    throw new ArticleNarrationSegmentError(
      "Persisted narration speech metadata is invalid.",
      {
        code: "persisted-speech-invalid",
        status: 409,
        retryable: false,
      },
    );
  }

  return {
    artifactKey,
    artifactVisibility: "public",
    contentType,
    byteLength: artifact.byteLength,
  };
}

function estimatedFailedGenerationCost(
  input: GenerateArticleNarrationSegmentInput,
  alignmentAttempts: number,
): ArticleNarrationCost {
  const spokenCharacters = Array.from(
    input.chunk.input.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, ""),
  ).length;
  const charactersPerSecond = input.profile.language === "zh-CN" ? 3.5 : 14;
  const estimatedDurationSeconds = Math.max(
    spokenCharacters / charactersPerSecond,
    1,
  );
  const estimated = estimateArticleNarrationSegmentCost(
    input.profile,
    input.chunk.input,
    estimatedDurationSeconds,
  );
  const speechUsd = input.persistedSpeechArtifact ? 0 : estimated.speechUsd;
  const alignmentUsd = round(
    estimated.alignmentUsd * Math.max(Math.trunc(alignmentAttempts), 0),
    6,
  );

  return {
    speechUsd,
    alignmentUsd,
    diagnosticTranscriptUsd: 0,
    totalUsd: round(speechUsd + alignmentUsd, 6),
  };
}

async function loadPersistedSpeechArtifact(
  artifact: PersistedArticleNarrationSpeechArtifact,
  artifactStorage: GenerateArticleNarrationSegmentDependencies["artifactStorage"],
) {
  if (typeof artifactStorage.get !== "function") {
    throw new ArticleNarrationSegmentError(
      "Persisted narration speech cannot be loaded.",
      {
        code: "persisted-speech-storage",
        status: 503,
        retryable: false,
        details: artifact,
      },
    );
  }

  let stored: Awaited<ReturnType<ArtifactStorage["get"]>>;

  try {
    stored = await artifactStorage.get(
      artifact.artifactKey,
      artifact.artifactVisibility,
    );
  } catch (error) {
    throw new ArticleNarrationSegmentError(
      "Persisted narration speech could not be loaded.",
      {
        code: "persisted-speech-storage",
        status: 503,
        retryable: true,
        details: { ...artifact, cause: messageFromError(error) },
      },
    );
  }

  if (
    !stored ||
    stored.key !== artifact.artifactKey ||
    !stored.contentType.toLowerCase().startsWith("audio/") ||
    stored.byteLength !== artifact.byteLength ||
    stored.body.byteLength !== artifact.byteLength
  ) {
    throw new ArticleNarrationSegmentError(
      "Persisted narration speech is missing or does not match its metadata.",
      {
        code: "persisted-speech-invalid",
        status: 409,
        retryable: false,
        details: artifact,
      },
    );
  }

  return stored.body;
}

async function createSpeech(
  text: string,
  profile: ArticleNarrationProfile,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
) {
  let response: Response;

  try {
    response = await fetcher(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: profile.speechModel,
        voice: profile.voice,
        input: text,
        ...(profile.speechInstructions
          ? { instructions: profile.speechInstructions }
          : {}),
        response_format: profile.responseFormat,
        speed: profile.speed,
      }),
    });
  } catch (error) {
    throw new ArticleNarrationSegmentError(
      "OpenAI speech generation request failed before receiving a response.",
      {
        code: "speech-network",
        status: 502,
        retryable: true,
        details: { cause: messageFromError(error) },
      },
    );
  }

  if (!response.ok) {
    throw await upstreamError(
      response,
      "OpenAI speech generation",
      "speech-upstream",
    );
  }

  const responseContentType =
    response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
  const declaredContentLength = numericContentLength(
    response.headers.get("content-length"),
  );

  if (
    responseContentType &&
    !responseContentType.startsWith("audio/") &&
    responseContentType !== "application/octet-stream"
  ) {
    throw new ArticleNarrationSegmentError(
      "OpenAI speech generation returned a non-audio response.",
      {
        code: "speech-response",
        status: 502,
        retryable: true,
      },
    );
  }
  if (
    declaredContentLength !== null &&
    declaredContentLength > maximumNarrationSegmentAudioBytes
  ) {
    throw new ArticleNarrationSegmentError(
      "Generated narration audio exceeded the 25 MB segment limit.",
      {
        code: "speech-response-too-large",
        status: 502,
        retryable: false,
        details: { byteLength: declaredContentLength },
      },
    );
  }

  const audio = Buffer.from(await response.arrayBuffer());

  if (audio.byteLength < minimumAudioBytes) {
    throw new ArticleNarrationSegmentError(
      "Generated narration audio was unexpectedly small.",
      {
        code: "speech-response",
        status: 502,
        retryable: true,
        details: { byteLength: audio.byteLength },
      },
    );
  }
  if (audio.byteLength > maximumNarrationSegmentAudioBytes) {
    throw new ArticleNarrationSegmentError(
      "Generated narration audio exceeded the 25 MB segment limit.",
      {
        code: "speech-response-too-large",
        status: 502,
        retryable: false,
        details: { byteLength: audio.byteLength },
      },
    );
  }

  return audio;
}

async function transcribeWithWordTimestampsWithRetry(
  audio: Buffer,
  profile: ArticleNarrationProfile,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
) {
  let lastError: ArticleNarrationSegmentError | null = null;

  for (
    let attempt = 1;
    attempt <= maximumTimestampTranscriptionAttempts;
    attempt += 1
  ) {
    try {
      return await transcribeWithWordTimestamps(
        audio,
        profile,
        apiKey,
        fetcher,
        baseUrl,
      );
    } catch (error) {
      const narrationError =
        error instanceof ArticleNarrationSegmentError
          ? error
          : new ArticleNarrationSegmentError(
              "Timestamp transcription request failed before receiving a response.",
              {
                code: "alignment-network",
                status: 502,
                retryable: true,
                details: { cause: messageFromError(error) },
              },
            );

      if (!narrationError.retryable) {
        throw narrationError;
      }

      lastError = narrationError;
      if (attempt < maximumTimestampTranscriptionAttempts) {
        const retryAfterMs = Number(
          narrationError.details?.retryAfterMs ?? 0,
        );
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          await delay(Math.min(retryAfterMs, 2_000));
        }
      }
    }
  }

  throw new ArticleNarrationSegmentError(
    "Timestamp transcription failed after two attempts; the stored speech audio was preserved.",
    {
      code: "alignment-retries-exhausted",
      status: lastError?.status ?? 502,
      // The paid generation step itself has automatic retries disabled. The
      // workflow may claim a new bounded attempt, which will reuse the speech
      // artifact and retry only timestamp alignment.
      retryable: true,
      details: {
        attempts: maximumTimestampTranscriptionAttempts,
        upstreamCode: lastError?.code,
        ...lastError?.details,
      },
    },
  );
}

async function transcribeWithWordTimestamps(
  audio: Buffer,
  profile: ArticleNarrationProfile,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
): Promise<NarrationTimestampTranscription> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
    "narration-segment.mp3",
  );
  form.set("model", profile.transcriptionModel);
  form.set("language", profile.transcriptionLanguage);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.set("temperature", "0");

  const response = await fetcher(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw await upstreamError(
      response,
      "OpenAI timestamp transcription",
      "alignment-upstream",
    );
  }

  const result = (await response.json()) as {
    text?: unknown;
    duration?: unknown;
    words?: unknown;
  };

  if (
    typeof result.text !== "string" ||
    !Number.isFinite(result.duration) ||
    (result.duration as number) <= 0 ||
    !Array.isArray(result.words)
  ) {
    throw new ArticleNarrationSegmentError(
      "OpenAI timestamp transcription returned an invalid response.",
      {
        code: "alignment-response",
        status: 502,
        retryable: true,
      },
    );
  }

  return {
    text: result.text,
    duration: result.duration as number,
    words: result.words.flatMap((word) => {
      if (!word || typeof word !== "object") {
        return [];
      }

      const candidate = word as {
        word?: unknown;
        start?: unknown;
        end?: unknown;
      };

      return typeof candidate.word === "string" &&
        typeof candidate.start === "number" &&
        typeof candidate.end === "number"
        ? [
            {
              word: candidate.word,
              start: candidate.start,
              end: candidate.end,
            },
          ]
        : [];
    }),
  };
}

function validateGenerationInput(input: GenerateArticleNarrationSegmentInput) {
  if (
    input.chunk.inputCodePoints >
      input.profile.chunkMaximumCodePoints ||
    input.chunk.inputCodePoints > 3_800 ||
    input.chunk.inputCodePoints !== Array.from(input.chunk.input).length ||
    input.chunk.inputSha256 !== sha256Text(input.chunk.input) ||
    input.chunk.expectedComparableText.length === 0
  ) {
    throw new ArticleNarrationSegmentError(
      "Narration segment input is invalid or stale.",
      {
        code: "invalid-input",
        status: 409,
        retryable: false,
      },
    );
  }
}

function mergeSplitSentenceCues(cues: ArticleNarrationCue[]) {
  const merged: ArticleNarrationCue[] = [];
  const positionBySentence = new Map<number, number>();

  for (const cue of cues) {
    const existingPosition = positionBySentence.get(cue.sentenceIndex);

    if (existingPosition === undefined) {
      positionBySentence.set(cue.sentenceIndex, merged.length);
      merged.push({ ...cue });
      continue;
    }

    const existing = merged[existingPosition];
    if (existing.sentenceText !== cue.sentenceText) {
      throw new ArticleNarrationSegmentError(
        "Split narration cues did not agree on sentence text.",
        {
          code: "cue-mismatch",
          status: 409,
          retryable: false,
        },
      );
    }

    existing.startSeconds = Math.min(
      existing.startSeconds,
      cue.startSeconds,
    );
    existing.endSeconds = Math.max(existing.endSeconds, cue.endSeconds);
  }

  return merged;
}

function validateAssembledCues(
  prepared: PreparedArticleNarration,
  cues: ArticleNarrationCue[],
  durationSeconds: number,
) {
  const expectedByIndex = new Map(
    prepared.units.map((unit) => [unit.sentenceIndex, unit.sentenceText]),
  );
  let previousStart = Number.NEGATIVE_INFINITY;

  if (cues.length !== expectedByIndex.size) {
    throw new ArticleNarrationSegmentError(
      "Narration cues did not cover every narrated sentence.",
      {
        code: "cue-coverage",
        status: 422,
        retryable: false,
      },
    );
  }

  for (const cue of cues) {
    if (
      expectedByIndex.get(cue.sentenceIndex) !== cue.sentenceText ||
      cue.startSeconds < 0 ||
      cue.startSeconds <= previousStart ||
      cue.endSeconds <= cue.startSeconds ||
      cue.endSeconds > durationSeconds + 0.5
    ) {
      throw new ArticleNarrationSegmentError(
        "Narration cues did not form a complete ordered timeline.",
        {
          code: "cue-timeline",
          status: 422,
          retryable: false,
          details: { cue },
        },
      );
    }

    previousStart = cue.startSeconds;
  }
}

function withPersistedArtifactDetails(
  error: unknown,
  artifact: Record<string, unknown>,
) {
  if (error instanceof ArticleNarrationSegmentError) {
    return new ArticleNarrationSegmentError(error.message, {
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      details: { ...error.details, ...artifact },
    });
  }

  return new ArticleNarrationSegmentError(
    "Narration timestamp generation failed.",
    {
      code: "alignment-upstream",
      status: 502,
      retryable: true,
      details: { ...artifact, cause: messageFromError(error) },
    },
  );
}

async function upstreamError(
  response: Response,
  operation: string,
  code: string,
) {
  const body = (await response.text()).slice(0, 600);
  const redacted = body.replace(/[A-Za-z0-9_-]{24,}/gu, "[redacted]");
  const retryable = response.status === 429 || response.status >= 500;
  const retryAfterMs = retryAfterMilliseconds(
    response.headers.get("retry-after"),
  );

  return new ArticleNarrationSegmentError(
    `${operation} failed (${response.status}): ${redacted || "upstream error"}`,
    {
      code,
      status: 502,
      retryable,
      details: {
        upstreamStatus: response.status,
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
      },
    },
  );
}

function numericContentLength(value: string | null) {
  if (value === null || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) {
    return null;
  }

  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    return Math.max(Number(value) * 1_000, 0);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function narrationApiKey(explicitKey?: string) {
  return (
    explicitKey?.trim() ||
    process.env.OPENAI_API_KEY_AI_READER?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
