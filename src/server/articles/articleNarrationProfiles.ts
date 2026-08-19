import { detectSpeechLanguage } from "@/lib/speechLanguage";

export type ArticleNarrationLanguage = "zh-CN" | "en-US";

export type ArticleNarrationProfile = {
  id: string;
  version: number;
  language: ArticleNarrationLanguage;
  speechModel: string;
  voice: string;
  speechInstructions?: string;
  transcriptionModel: "whisper-1";
  transcriptionLanguage: "zh" | "en";
  responseFormat: "mp3";
  speed: number;
  chunkTargetCodePoints: number;
  chunkMaximumCodePoints: number;
  qa: {
    minimumSourceCoverage: number;
    minimumExactMatchRatio: number;
    maximumUnmatchedSourceRun: number;
    maximumUnmatchedTranscriptRun: number;
    maximumLeadingAudioSeconds: number;
    maximumTrailingAudioSeconds: number;
  };
};

export type ArticleNarrationCost = {
  speechUsd: number;
  alignmentUsd: number;
  diagnosticTranscriptUsd: number;
  totalUsd: number;
};

const chineseNarrationInstructions =
  "最高优先级是忠实完整。只朗读输入内容，从第一个字按原顺序读到最后一个字才停止；不得概括、合并、改写、补字或漏字。" +
  "即使内容重复，也必须在每次出现时完整朗读。标点只控制停顿并区分对话，绝不念出标点或引号名称。" +
  "请使用自然、清晰的中国大陆普通话和沉稳温暖的有声书语气；准确完整高于表演，不要添加开场白或结语。";

export const articleNarrationProfiles = {
  "zh-CN": {
    id: "zh-cedar-complete-v1",
    version: 1,
    language: "zh-CN",
    speechModel: "gpt-4o-mini-tts-2025-12-15",
    voice: "cedar",
    speechInstructions: chineseNarrationInstructions,
    transcriptionModel: "whisper-1",
    transcriptionLanguage: "zh",
    responseFormat: "mp3",
    speed: 1,
    // Mandarin characters are commonly close to one token each. Keep the
    // speech input comfortably below this model's 2,000-input-token limit;
    // the endpoint's separate 4,096-character limit is not the tighter bound
    // for Chinese text.
    chunkTargetCodePoints: 1_200,
    chunkMaximumCodePoints: 1_600,
    qa: {
      minimumSourceCoverage: 0.95,
      minimumExactMatchRatio: 0.78,
      maximumUnmatchedSourceRun: 4,
      maximumUnmatchedTranscriptRun: 6,
      maximumLeadingAudioSeconds: 3,
      maximumTrailingAudioSeconds: 5,
    },
  },
  "en-US": {
    id: "en-tts1-alloy-v1",
    version: 1,
    language: "en-US",
    speechModel: "tts-1",
    voice: "alloy",
    transcriptionModel: "whisper-1",
    transcriptionLanguage: "en",
    responseFormat: "mp3",
    speed: 1,
    chunkTargetCodePoints: 2_800,
    chunkMaximumCodePoints: 3_800,
    qa: {
      minimumSourceCoverage: 0.95,
      minimumExactMatchRatio: 0.78,
      maximumUnmatchedSourceRun: 6,
      maximumUnmatchedTranscriptRun: 10,
      maximumLeadingAudioSeconds: 3,
      maximumTrailingAudioSeconds: 5,
    },
  },
} as const satisfies Record<
  ArticleNarrationLanguage,
  ArticleNarrationProfile
>;

export function detectArticleNarrationLanguage(
  title: string,
  textContent: string,
): ArticleNarrationLanguage | null {
  const text = `${title}\n${textContent}`;

  if (detectSpeechLanguage(text) === "zh-CN") {
    return "zh-CN";
  }

  const latinCount = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const hanCount = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kanaCount =
    text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const relevantLetters = latinCount + hanCount + kanaCount;

  return latinCount >= 2 &&
    (relevantLetters === 0 || latinCount / relevantLetters >= 0.5)
    ? "en-US"
    : null;
}

export function articleNarrationProfileFor(
  language: ArticleNarrationLanguage,
): ArticleNarrationProfile {
  return articleNarrationProfiles[language];
}

export function estimateArticleNarrationSegmentCost(
  profile: ArticleNarrationProfile,
  input: string,
  durationSeconds: number,
  options: { includeDiagnosticTranscript?: boolean } = {},
): ArticleNarrationCost {
  const safeDuration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : 0;
  const audioMinutes = safeDuration / 60;
  const inputCodePoints = Array.from(input).length;
  const speechUsd =
    profile.speechModel === "tts-1"
      ? (inputCodePoints / 1_000_000) * 15
      : (Math.ceil(inputCodePoints * 1.1) / 1_000_000) * 0.6 +
        audioMinutes * 0.015;
  const alignmentUsd = audioMinutes * 0.006;
  const diagnosticTranscriptUsd = options.includeDiagnosticTranscript
    ? audioMinutes * 0.0045
    : 0;

  return {
    speechUsd: roundCost(speechUsd),
    alignmentUsd: roundCost(alignmentUsd),
    diagnosticTranscriptUsd: roundCost(diagnosticTranscriptUsd),
    totalUsd: roundCost(
      speechUsd + alignmentUsd + diagnosticTranscriptUsd,
    ),
  };
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
