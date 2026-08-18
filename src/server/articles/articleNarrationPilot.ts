import { randomUUID } from "node:crypto";
import type { Article, ArticleNarration } from "@/lib/types";
import type { ArticleRepository } from "@/server/ports/articleRepository";
import type { ArtifactStorage } from "@/server/ports/artifactStorage";
import {
  canonicalNarrationSource,
  evaluateNarrationTranscript,
  narrationSourceSha256,
  normalizeNarrationInput,
  sha256Text,
  type ArticleNarrationQa,
} from "@/server/articles/articleNarrationQa";

export const pilotNarrationTarget = {
  id: "black-myth-journal-5df74e22bc38174a8a99c9b2",
  ownerEmail: "cmsflash99@gmail.com",
  title: "黑风山土地",
  bodySha256: "90bcf38817ce8537f787188d17d23c2967f5314d53720e501621bab642c5b95d",
} as const;

const speechModel = "gpt-4o-mini-tts-2025-12-15";
const transcriptModel = "gpt-transcribe";
const diagnosticTranscriptModel = "gpt-4o-mini-transcribe";
const voice = "cedar";
const openAiBaseUrl = "https://api.openai.com/v1";

type PilotNarrationDependencies = {
  articleRepository: Pick<
    ArticleRepository,
    "addProcessingCost" | "findById" | "updateNarration"
  >;
  artifactStorage: Pick<ArtifactStorage, "put" | "delete">;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  durationSecondsForAudio?: (audio: Buffer) => number;
};

export type PilotNarrationResult = {
  article: Article;
  narration: ArticleNarration;
  alreadyExisted: boolean;
  qa?: ArticleNarrationQa;
  estimatedCostUsd?: number;
};

export class PilotNarrationError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PilotNarrationError";
    this.status = status;
    this.details = details;
  }
}

export async function verifyPilotNarrationModelAccess(
  articleId: string,
  ownerEmail: string,
  options: {
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  if (
    articleId !== pilotNarrationTarget.id ||
    ownerEmail.trim().toLowerCase() !== pilotNarrationTarget.ownerEmail
  ) {
    throw new PilotNarrationError("This narration pilot is limited to one article.", 404);
  }

  const apiKey = narrationApiKey(options.apiKey);
  const fetcher = options.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetcher !== "function") {
    throw new PilotNarrationError("OpenAI narration is not configured.", 503);
  }

  const models = [speechModel, transcriptModel];
  const responses = await Promise.all(
    models.map((model) =>
      fetcher(`${openAiBaseUrl}/models/${encodeURIComponent(model)}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    ),
  );
  const failedIndex = responses.findIndex((response) => !response.ok);

  if (failedIndex >= 0) {
    throw new PilotNarrationError(
      `OpenAI narration access check failed for ${models[failedIndex]} (${responses[failedIndex].status}).`,
      502,
    );
  }

  return {
    model: speechModel,
    transcriptModel,
  };
}

export async function generatePilotArticleNarration(
  articleId: string,
  ownerEmail: string,
  dependencies: PilotNarrationDependencies,
): Promise<PilotNarrationResult> {
  if (
    articleId !== pilotNarrationTarget.id ||
    ownerEmail.trim().toLowerCase() !== pilotNarrationTarget.ownerEmail
  ) {
    throw new PilotNarrationError("This narration pilot is limited to one article.", 404);
  }

  const article = await dependencies.articleRepository.findById(
    articleId,
    ownerEmail,
  );

  if (!article) {
    throw new PilotNarrationError("Article not found.", 404);
  }
  if (
    article.title !== pilotNarrationTarget.title ||
    sha256Text(article.textContent) !== pilotNarrationTarget.bodySha256
  ) {
    throw new PilotNarrationError(
      "The pilot article changed; refusing to generate stale narration.",
      409,
    );
  }
  if (article.narration) {
    return {
      article,
      narration: article.narration,
      alreadyExisted: true,
    };
  }

  const apiKey = narrationApiKey(dependencies.apiKey);
  const fetcher = dependencies.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetcher !== "function") {
    throw new PilotNarrationError("OpenAI narration is not configured.", 503);
  }

  const canonicalSource = canonicalNarrationSource(
    article.title,
    article.textContent,
  );
  const narrationInput = normalizeNarrationInput(
    `${article.title.trim()}。\n\n${article.textContent.trim()}`,
  );
  const sourceTextSha256 = narrationSourceSha256(
    article.title,
    article.textContent,
  );
  const audio = await createSpeech(narrationInput, apiKey, fetcher);

  if (audio.byteLength < 10_000) {
    throw new PilotNarrationError("Generated narration audio was unexpectedly small.", 502);
  }

  const durationSeconds =
    plausibleAudioDuration(
      dependencies.durationSecondsForAudio?.(audio) ??
        mp3DurationSeconds(audio),
    ) ?? estimatedDurationFromText(narrationInput);

  const transcript = await transcribeAudio(
    audio,
    apiKey,
    fetcher,
    transcriptModel,
  );
  let qa = evaluateNarrationTranscript(canonicalSource, transcript);
  let usedDiagnosticTranscript = false;

  if (!qa.ok) {
    const diagnosticTranscript = await transcribeAudio(
      audio,
      apiKey,
      fetcher,
      diagnosticTranscriptModel,
    ).catch(() => null);
    const diagnosticQa = diagnosticTranscript
      ? evaluateNarrationTranscript(canonicalSource, diagnosticTranscript)
      : null;

    if (diagnosticQa?.ok && primaryQaAllowsDiagnosticOverride(qa)) {
      qa = diagnosticQa;
      usedDiagnosticTranscript = true;
    } else {
      const candidateKey = narrationArtifactKey(
        article.id,
        sourceTextSha256,
        true,
      );
      const candidate = await dependencies.artifactStorage
        .put({
          key: candidateKey,
          body: audio,
          contentType: "audio/mpeg",
          visibility: "public",
        })
        .catch(() => null);
      const estimatedCostUsd = estimatedPilotCostUsd(
        narrationInput,
        durationSeconds,
        true,
      );
      const costRecorded = await dependencies.articleRepository
        .addProcessingCost(article.id, ownerEmail, estimatedCostUsd)
        .then(Boolean)
        .catch(() => false);

      throw new PilotNarrationError(
        "Generated narration did not pass coverage QA. " +
          `High-accuracy transcript: ${qa.failures.join("; ")}. ` +
          `Mini transcript diagnostic: ${
            diagnosticQa
              ? diagnosticQa.ok
                ? "passed"
                : diagnosticQa.failures.join("; ")
              : "unavailable"
          }`,
        422,
        {
          byteLength: audio.byteLength,
          durationSeconds: round(durationSeconds, 3),
          transcript,
          transcriptTail: lastCharacters(transcript, 120),
          qa,
          diagnosticTranscript,
          diagnosticTranscriptTail: diagnosticTranscript
            ? lastCharacters(diagnosticTranscript, 120)
            : null,
          diagnosticQa,
          candidateArtifactKey: candidate?.key ?? null,
          candidateAudioPath: candidate
            ? `/api/artifacts/${candidate.key
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`
            : null,
          estimatedCostUsd,
          costRecorded,
        },
      );
    }
  }

  const artifactKey = narrationArtifactKey(article.id, sourceTextSha256, false);
  const stored = await dependencies.artifactStorage.put({
    key: artifactKey,
    body: audio,
    contentType: "audio/mpeg",
    visibility: "public",
  });
  const narration: ArticleNarration = {
    artifactKey: stored.key,
    artifactVisibility: "public",
    contentType: "audio/mpeg",
    byteLength: audio.byteLength,
    sourceTextSha256,
    model: speechModel,
    voice,
    generatedAt: new Date().toISOString(),
    durationSeconds: round(durationSeconds, 3),
  };
  const estimatedCostUsd = estimatedPilotCostUsd(
    narrationInput,
    durationSeconds,
    usedDiagnosticTranscript,
  );
  let updated: Article | null;

  try {
    updated = await dependencies.articleRepository.updateNarration(
      article.id,
      ownerEmail,
      narration,
      estimatedCostUsd,
      true,
    );
  } catch {
    const cleanedUp = await deleteArtifactQuietly(
      dependencies.artifactStorage,
      stored.key,
    );
    throw new PilotNarrationError(
      "Could not attach narration to the article.",
      500,
      cleanedUp ? undefined : { orphanedArtifactKey: stored.key },
    );
  }

  if (!updated) {
    const cleanedUp = await deleteArtifactQuietly(
      dependencies.artifactStorage,
      stored.key,
    );
    throw new PilotNarrationError(
      "Could not attach narration to the article.",
      500,
      cleanedUp ? undefined : { orphanedArtifactKey: stored.key },
    );
  }

  return {
    article: updated,
    narration,
    alreadyExisted: false,
    qa,
    estimatedCostUsd,
  };
}

async function createSpeech(
  input: string,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
) {
  const response = await fetcher(`${openAiBaseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: speechModel,
      voice,
      input,
      instructions:
        "最高优先级是忠实完整。只朗读输入内容，从第一个字按原顺序读到最后一个字才停止；不得概括、合并、改写、补字或漏字。即使内容重复，也必须在每次出现时完整朗读。标题和正文都要读。正文末尾两段诗句有意重复开头两段，必须再次逐字完整朗读，读完最后一个“长”字才结束。标点只控制停顿并区分对话，绝不念出标点或引号名称。请使用自然、清晰的中国大陆普通话和沉稳温暖的有声书语气；准确完整高于表演，不要添加开场白或结语。",
      response_format: "mp3",
      speed: 1,
    }),
  });

  if (!response.ok) {
    throw new PilotNarrationError(
      `OpenAI speech generation failed (${response.status}): ${await safeResponseError(response)}`,
      502,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function transcribeAudio(
  audio: Buffer,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  model: string,
) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
    "narration.mp3",
  );
  form.set("model", model);
  form.set("language", "zh");
  form.set("response_format", "json");
  form.set(
    "prompt",
    "黑风山，土地公，鹤发童颜，渔鼓，倨傲",
  );
  const response = await fetcher(`${openAiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new PilotNarrationError(
      `OpenAI transcription failed (${response.status}): ${await safeResponseError(response)}`,
      502,
    );
  }

  const result = (await response.json()) as { text?: unknown };
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new PilotNarrationError("OpenAI transcription returned no text.", 502);
  }
  return result.text.trim();
}

export function mp3DurationSeconds(audio: Buffer) {
  const frame = firstMp3Frame(audio);

  if (!frame) {
    return Number.NaN;
  }

  return ((audio.byteLength - frame.offset) * 8) / frame.bitsPerSecond;
}

function plausibleAudioDuration(durationSeconds: number) {
  return Number.isFinite(durationSeconds) &&
    durationSeconds >= 30 &&
    durationSeconds <= 600
    ? durationSeconds
    : null;
}

function estimatedDurationFromText(input: string) {
  const spokenCharacters = Array.from(
    input.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, ""),
  ).length;
  return Math.min(Math.max(spokenCharacters / 3.5, 30), 600);
}

function firstMp3Frame(audio: Buffer) {
  const searchStart = id3v2ByteLength(audio);
  const searchEnd = Math.min(audio.byteLength - 4, searchStart + 64 * 1024);

  for (let offset = searchStart; offset <= searchEnd; offset += 1) {
    const header = audio.readUInt32BE(offset);

    if (((header >>> 21) & 0x7ff) !== 0x7ff) {
      continue;
    }

    const versionBits = (header >>> 19) & 0b11;
    const layerBits = (header >>> 17) & 0b11;
    const bitrateIndex = (header >>> 12) & 0b1111;

    if (
      versionBits === 0b01 ||
      layerBits !== 0b01 ||
      bitrateIndex === 0 ||
      bitrateIndex === 0b1111
    ) {
      continue;
    }

    const mpeg1Bitrates = [
      0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const mpeg2Bitrates = [
      0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
    ];
    const kilobitsPerSecond =
      (versionBits === 0b11 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];

    return {
      offset,
      bitsPerSecond: kilobitsPerSecond * 1_000,
    };
  }

  return null;
}

function id3v2ByteLength(audio: Buffer) {
  if (
    audio.byteLength < 10 ||
    audio[0] !== 0x49 ||
    audio[1] !== 0x44 ||
    audio[2] !== 0x33
  ) {
    return 0;
  }

  const size =
    ((audio[6] & 0x7f) << 21) |
    ((audio[7] & 0x7f) << 14) |
    ((audio[8] & 0x7f) << 7) |
    (audio[9] & 0x7f);

  return Math.min(size + 10, audio.byteLength);
}

function estimatedPilotCostUsd(
  input: string,
  durationSeconds: number,
  includeDiagnosticTranscript: boolean,
) {
  const estimatedInputTokens = Math.ceil(Array.from(input).length * 1.1);
  const speechInputCost = (estimatedInputTokens / 1_000_000) * 0.6;
  const audioMinutes = durationSeconds / 60;
  const speechAudioCost = audioMinutes * 0.015;
  const transcriptionCost =
    audioMinutes * (0.0045 + (includeDiagnosticTranscript ? 0.003 : 0));
  return round(speechInputCost + speechAudioCost + transcriptionCost, 6);
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

function lastCharacters(value: string, count: number) {
  return Array.from(value).slice(-count).join("");
}

function primaryQaAllowsDiagnosticOverride(qa: ArticleNarrationQa) {
  return (
    qa.characterErrorRate <= 0.08 &&
    qa.orderedCoverage >= 0.95 &&
    qa.maxContiguousSourceDeletion <= 4 &&
    qa.forbiddenQuoteMarkers.length === 0
  );
}

function narrationArtifactKey(
  articleId: string,
  sourceTextSha256: string,
  candidate: boolean,
) {
  const safeModel = speechModel.replace(/[^a-z0-9.-]+/giu, "-");
  const directory = candidate ? "audio/candidates" : "audio";
  return (
    `articles/${articleId}/${directory}/` +
    `${sourceTextSha256}-${safeModel}-${voice}-${randomUUID()}.mp3`
  );
}

async function deleteArtifactQuietly(
  artifactStorage: Pick<ArtifactStorage, "delete">,
  key: string,
) {
  try {
    await artifactStorage.delete(key);
    return true;
  } catch {
    return false;
  }
}
