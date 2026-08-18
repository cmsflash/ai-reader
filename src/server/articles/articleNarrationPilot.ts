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
const transcriptModel = "gpt-4o-mini-transcribe";
const voice = "cedar";
const openAiBaseUrl = "https://api.openai.com/v1";

type PilotNarrationDependencies = {
  articleRepository: Pick<
    ArticleRepository,
    "findById" | "updateNarration"
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

  constructor(message: string, status: number) {
    super(message);
    this.name = "PilotNarrationError";
    this.status = status;
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

  const response = await fetcher(
    `${openAiBaseUrl}/models/${encodeURIComponent(speechModel)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );

  if (!response.ok) {
    throw new PilotNarrationError(
      `OpenAI narration access check failed (${response.status}).`,
      502,
    );
  }

  return { model: speechModel };
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
  const narrationInput = normalizeNarrationInput(canonicalSource);
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

  const transcript = await transcribeAudio(audio, apiKey, fetcher);
  const qa = evaluateNarrationTranscript(canonicalSource, transcript);

  if (!qa.ok) {
    throw new PilotNarrationError(
      `Generated narration did not pass coverage QA: ${qa.failures.join("; ")}`,
      422,
    );
  }

  const safeModel = speechModel.replace(/[^a-z0-9.-]+/giu, "-");
  const artifactKey =
    `articles/${article.id}/audio/` +
    `${sourceTextSha256}-${safeModel}-${voice}-${randomUUID()}.mp3`;
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
  );
  const updated = await dependencies.articleRepository.updateNarration(
    article.id,
    ownerEmail,
    narration,
    estimatedCostUsd,
    true,
  );

  if (!updated) {
    await dependencies.artifactStorage.delete(stored.key);
    throw new PilotNarrationError("Could not attach narration to the article.", 500);
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
        "请用自然、清晰的中国大陆普通话，以沉稳温暖的有声书叙事风格朗读。逐字完整朗读每一句，不得增删、跳过或改写内容；标点和引号只用于停顿与区分对话，绝对不要念出任何标点或引号名称；段落之间自然停顿；对白与叙述略作区分，但不要夸张表演。",
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
) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
    "narration.mp3",
  );
  form.set("model", transcriptModel);
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

function estimatedPilotCostUsd(input: string, durationSeconds: number) {
  const estimatedInputTokens = Math.ceil(Array.from(input).length * 1.1);
  const speechInputCost = (estimatedInputTokens / 1_000_000) * 0.6;
  const audioMinutes = durationSeconds / 60;
  const speechAudioCost = audioMinutes * 0.015;
  const transcriptionCost = audioMinutes * 0.003;
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
