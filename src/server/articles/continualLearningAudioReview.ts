import { createHash } from "node:crypto";
import { annotateBlocks } from "@/lib/sentences";
import {
  narrationSentenceMapFingerprint,
} from "@/lib/narrationPlayback";
import type {
  ArticleBlock,
  ArticleNarration,
  SourceType,
} from "@/lib/types";
import { blocksToHtml } from "@/lib/extractors";
import { getDatabaseSql } from "@/server/database";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";
import { getNarrationPolicyRepository } from "@/server/runtime/narrationPolicyRepository";
import {
  narrationSourceSha256,
  sha256Text,
} from "@/server/articles/articleNarrationQa";
import { continualLearningRecoveredCues } from "@/server/articles/continualLearningAudioReviewFixture";

export const continualLearningAudioReviewOwnerEmail =
  "cmsflash99@gmail.com";
export const continualLearningAudioReviewCurrentArticleId =
  "review-continual-learning-current-audio";
export const continualLearningAudioReviewSentenceArticleId =
  "review-continual-learning-sentence-audio";

const originalArticleId = "4fdc1044-1b4b-4105-9775-2135b4a478fa";
const originalJobId = "narration-job-ba1ecd4d-e3d1-4cd5-9fdc-9792d38ecf0b";
const archiveFolderId = "cmsflash99@gmail.com:archive";
const expectedTitle = "Continual Learning: End of Frozen Software";
const expectedInputSha256 =
  "25478e820efa32d9e8af8c90bb849e915024079847af731520264e1b08b30ca9";
const expectedOriginalSourceSha256 =
  "95ebf8903113d2e5973ccd204f1876d05f4227364c467a5e90a88672b3e806f6";
const expectedOriginalSentenceMapFingerprint = "fnv1a32:b53432e2";
const expectedOriginalGenerationFingerprint =
  "090676969b329fe57a6ba96ba5435edaadca0167eb18167fdd3a9f55ffabec4a";
const expectedSourceSha256 =
  "8c044e2fc21b7ce56c2a859541f447920dc91afad584f4c83f25ae7b0371dc0b";
const expectedSentenceMapFingerprint = "fnv1a32:1a701529";
const expectedSentenceInputCodePoints = 2_604;
const sentenceCount = 52;
const currentAudio = {
  sourceArtifactKey:
    "articles/4fdc1044-1b4b-4105-9775-2135b4a478fa/audio/v2/090676969b329fe57a6ba96ba5435edaadca0167eb18167fdd3a9f55ffabec4a/segments/0000-25478e820efa32d9-attempt-1.mp3",
  targetArtifactKey:
    `articles/${continualLearningAudioReviewCurrentArticleId}/audio/review/current-passage.mp3`,
  byteLength: 2_631_168,
  durationSeconds: 164.44,
  transcriptSha256:
    "b5cd8fa431c978e8b9e1cefab880999d6eabaac9f6b7b190f8ee6369426031e3",
  audioSha256:
    "f74782d9e4cdbb70b56e796d807646a90c5d8d8897b65b0d7385867c77a1a32b",
};

type ReviewPart = {
  sentenceIndex: number;
  sentenceText: string;
  speechText: string;
};

export type ContinualLearningAudioReviewSentence = ReviewPart & {
  index: number;
  inputSha256: string;
};

export type ContinualLearningAudioReviewPreparation = {
  ownerEmail: string;
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
  thumbnailUrl?: string;
  blocks: ArticleBlock[];
  textContent: string;
  sourceTextSha256: string;
  sentenceMapFingerprint: string;
  generatedAt: string;
  sentences: ContinualLearningAudioReviewSentence[];
};

export type ContinualLearningAudioReviewGeneratedSentence = {
  index: number;
  sentenceIndex: number;
  sentenceText: string;
  inputSha256: string;
  artifactKey: string;
  contentType: string;
  byteLength: number;
  durationSeconds: number;
};

export type ContinualLearningAudioReviewResult = {
  currentAudioArticleId: string;
  sentenceAudioArticleId: string;
  currentAudioIncrementalOpenAiCostUsd: number;
  currentAudioHistoricalOpenAiCostUsd: number;
  sentenceAudioActualOpenAiCostUsd: number;
  sentenceAudioDurationSeconds: number;
  sentenceCount: number;
};

export async function prepareContinualLearningAudioReview(
  ownerEmail: string,
): Promise<ContinualLearningAudioReviewPreparation> {
  assertOwner(ownerEmail);
  const articleRepository = getArticleRepository();
  const policyRepository = getNarrationPolicyRepository();
  const [article, storedJob, storedSegment, folders] = await Promise.all([
    articleRepository.findById(originalArticleId, ownerEmail),
    policyRepository.findNarrationJob(
      ownerEmail,
      originalArticleId,
      expectedOriginalGenerationFingerprint,
    ),
    policyRepository.findNarrationSegment(
      ownerEmail,
      originalJobId,
      0,
    ),
    articleRepository.listFolders(ownerEmail),
  ]);

  if (
    !article ||
    article.title !== expectedTitle ||
    !storedJob ||
    !storedSegment ||
    !folders.some(
      (folder) => folder.id === archiveFolderId && folder.isArchive,
    )
  ) {
    throw new Error("The exact production review source could not be verified.");
  }
  if (
    storedJob.id !== originalJobId ||
    storedJob.articleId !== originalArticleId ||
    storedJob.sourceTextSha256 !== expectedOriginalSourceSha256 ||
    storedJob.sentenceMapFingerprint !==
      expectedOriginalSentenceMapFingerprint ||
    storedJob.generationFingerprint !==
      expectedOriginalGenerationFingerprint ||
    storedJob.language !== "en-US" ||
    storedJob.profileId !== "en-tts1-alloy-v1" ||
    storedJob.profileVersion !== "1" ||
    storedJob.speechModel !== "tts-1" ||
    storedJob.voice !== "alloy" ||
    storedSegment.inputSha256 !== expectedInputSha256 ||
    storedSegment.inputCodePoints !== 2_706
  ) {
    throw new Error("The retained narration segment changed.");
  }

  const parts = parseParts(storedSegment.unitMap);
  const blocks = article.blocks.slice(0, 18).map(removeArtifactOwnership);
  const textContent = blocksToText(blocks);
  const sourceTextSha256 = narrationSourceSha256(article.title, textContent);
  const annotated = annotateBlocks(blocks);
  const sentenceMapFingerprint = narrationSentenceMapFingerprint(
    annotated.sentences,
  );

  if (
    sourceTextSha256 !== expectedSourceSha256 ||
    sentenceMapFingerprint !== expectedSentenceMapFingerprint ||
    annotated.sentences.length !== 53
  ) {
    throw new Error("The review excerpt changed.");
  }

  const sentences = parts.map((part, index) => ({
    ...part,
    index,
    inputSha256: sha256Text(part.speechText),
  }));
  const totalCodePoints = sentences.reduce(
    (total, sentence) => total + Array.from(sentence.speechText).length,
    0,
  );
  if (
    sentences.length !== sentenceCount ||
    totalCodePoints !== expectedSentenceInputCodePoints
  ) {
    throw new Error("The sentence inputs changed.");
  }
  validateRecoveredCues(sentences);

  const generatedAt = new Date().toISOString();
  const preparation: ContinualLearningAudioReviewPreparation = {
    ownerEmail,
    title: article.title,
    sourceType: article.sourceType,
    ...(article.sourceUrl ? { sourceUrl: article.sourceUrl } : {}),
    ...(article.thumbnailUrl ? { thumbnailUrl: article.thumbnailUrl } : {}),
    blocks,
    textContent,
    sourceTextSha256,
    sentenceMapFingerprint,
    generatedAt,
    sentences,
  };
  const currentArtifact = await copyCurrentAudio();
  const currentNarration = currentAudioNarration(
    preparation,
    currentArtifact,
  );

  await upsertReviewArticle(
    preparation,
    continualLearningAudioReviewCurrentArticleId,
    "Audio review A: retained whole-passage audio with best-effort sentence matching.",
    currentNarration,
    0,
  );

  return preparation;
}

export async function generateContinualLearningSentenceAudio(
  preparation: ContinualLearningAudioReviewPreparation,
  sentence: ContinualLearningAudioReviewSentence,
): Promise<ContinualLearningAudioReviewGeneratedSentence> {
  validatePreparation(preparation);
  const expected = preparation.sentences[sentence.index];
  if (
    !expected ||
    expected.inputSha256 !== sentence.inputSha256 ||
    expected.speechText !== sentence.speechText ||
    expected.sentenceIndex !== sentence.sentenceIndex
  ) {
    throw new Error("The requested review sentence is invalid.");
  }

  const key =
    `articles/${continualLearningAudioReviewSentenceArticleId}/audio/review/sentences/` +
    `${String(sentence.index).padStart(3, "0")}-${sentence.inputSha256.slice(0, 16)}.wav`;
  const artifactStorage = getArtifactStorage();
  const existing = await artifactStorage.get(key, "public");
  let artifact;

  if (existing) {
    artifact = existing;
  } else {
    const audio = await requestSentenceSpeech(sentence.speechText);
    const stored = await artifactStorage.put({
      key,
      body: audio,
      contentType: "audio/wav",
      visibility: "public",
    });
    artifact = {
      ...stored,
      body: audio,
    };
  }

  if (
    artifact.key !== key ||
    !artifact.contentType.toLowerCase().startsWith("audio/") ||
    artifact.byteLength !== artifact.body.byteLength
  ) {
    throw new Error("The stored sentence audio is invalid.");
  }

  return {
    index: sentence.index,
    sentenceIndex: sentence.sentenceIndex,
    sentenceText: sentence.sentenceText,
    inputSha256: sentence.inputSha256,
    artifactKey: artifact.key,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    durationSeconds: wavDurationSeconds(artifact.body),
  };
}

export async function finalizeContinualLearningAudioReview(
  preparation: ContinualLearningAudioReviewPreparation,
  generated: ContinualLearningAudioReviewGeneratedSentence[],
): Promise<ContinualLearningAudioReviewResult> {
  validatePreparation(preparation);
  if (generated.length !== preparation.sentences.length) {
    throw new Error("The sentence audio review is incomplete.");
  }

  let elapsedSeconds = 0;
  const segments = [];
  const sentenceCues = [];
  for (const [index, result] of generated.entries()) {
    const source = preparation.sentences[index];
    if (
      result.index !== index ||
      result.inputSha256 !== source.inputSha256 ||
      result.sentenceIndex !== source.sentenceIndex ||
      comparableText(result.sentenceText) !== comparableText(source.sentenceText) ||
      !result.contentType.toLowerCase().startsWith("audio/") ||
      !Number.isSafeInteger(result.byteLength) ||
      result.byteLength <= 0 ||
      !Number.isFinite(result.durationSeconds) ||
      result.durationSeconds <= 0
    ) {
      throw new Error(`Sentence audio ${index} is invalid.`);
    }

    const startSeconds = round(elapsedSeconds, 6);
    const endSeconds = round(startSeconds + result.durationSeconds, 6);
    segments.push({
      index,
      artifactKey: result.artifactKey,
      artifactVisibility: "public" as const,
      contentType: result.contentType,
      byteLength: result.byteLength,
      startSeconds,
      durationSeconds: result.durationSeconds,
      inputSha256: result.inputSha256,
    });
    sentenceCues.push({
      sentenceIndex: result.sentenceIndex,
      sentenceText: result.sentenceText,
      startSeconds,
      endSeconds,
    });
    elapsedSeconds = endSeconds;
  }

  const inputCodePoints = preparation.sentences.reduce(
    (total, sentence) => total + Array.from(sentence.speechText).length,
    0,
  );
  const costUsd = round((inputCodePoints / 1_000_000) * 15, 6);
  const first = segments[0];
  const narration: ArticleNarration = {
    version: 2,
    artifactKey: first.artifactKey,
    artifactVisibility: "public",
    contentType: first.contentType,
    byteLength: first.byteLength,
    sourceTextSha256: preparation.sourceTextSha256,
    model: "tts-1",
    voice: "alloy",
    generatedAt: preparation.generatedAt,
    durationSeconds: elapsedSeconds,
    generationFingerprint: sha256Text(
      `continual-learning-review-sentences-v1:${preparation.sourceTextSha256}`,
    ),
    language: "en-US",
    profileVersion: 1,
    segments,
    alignment: {
      version: 1,
      model: "structural-sentence-boundaries-v1",
      generatedAt: preparation.generatedAt,
      transcriptSha256: sha256Text(
        preparation.sentences.map((sentence) => sentence.speechText).join("\n"),
      ),
      sentenceMapFingerprint: preparation.sentenceMapFingerprint,
      sourceCoverage: 1,
      exactMatchRatio: 1,
      maxUnmatchedSourceRun: 0,
      maxUnmatchedTranscriptRun: 0,
      sentenceCues,
    },
  };

  await upsertReviewArticle(
    preparation,
    continualLearningAudioReviewSentenceArticleId,
    "Audio review B: the same passage generated and played sentence by sentence.",
    narration,
    costUsd,
  );

  return {
    currentAudioArticleId: continualLearningAudioReviewCurrentArticleId,
    sentenceAudioArticleId: continualLearningAudioReviewSentenceArticleId,
    currentAudioIncrementalOpenAiCostUsd: 0,
    currentAudioHistoricalOpenAiCostUsd: 0.057034,
    sentenceAudioActualOpenAiCostUsd: costUsd,
    sentenceAudioDurationSeconds: elapsedSeconds,
    sentenceCount: generated.length,
  };
}

export function wavDurationSeconds(buffer: Buffer) {
  if (
    buffer.byteLength < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Speech generation returned an invalid WAV file.");
  }

  let byteRate = 0;
  let dataBytes = 0;
  let cursor = 12;
  while (cursor + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString("ascii", cursor, cursor + 4);
    const declaredChunkBytes = buffer.readUInt32LE(cursor + 4);
    const chunkStart = cursor + 8;
    const availableChunkBytes = buffer.byteLength - chunkStart;
    const isStreamingDataChunk =
      chunkId === "data" && declaredChunkBytes === 0xffffffff;
    const chunkBytes = isStreamingDataChunk
      ? availableChunkBytes
      : declaredChunkBytes;
    if (chunkBytes > availableChunkBytes) {
      throw new Error("Speech generation returned a truncated WAV file.");
    }
    if (chunkId === "fmt " && chunkBytes >= 16) {
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkId === "data") {
      dataBytes += chunkBytes;
    }
    cursor = chunkStart + chunkBytes + (chunkBytes % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) {
    throw new Error("Speech generation returned WAV audio without sample data.");
  }
  return round(dataBytes / byteRate, 6);
}

async function requestSentenceSpeech(text: string) {
  const apiKey =
    process.env.OPENAI_API_KEY_AI_READER ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI narration is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: "alloy",
      input: text,
      response_format: "wav",
      speed: 1,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI speech generation failed with HTTP ${response.status}.`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  wavDurationSeconds(audio);
  return audio;
}

async function copyCurrentAudio() {
  const storage = getArtifactStorage();
  const existing = await storage.get(currentAudio.targetArtifactKey, "public");
  if (existing) {
    if (
      existing.byteLength !== currentAudio.byteLength ||
      sha256Bytes(existing.body) !== currentAudio.audioSha256
    ) {
      throw new Error("The existing review audio copy has an unexpected size.");
    }
    return existing;
  }

  const source = await storage.get(currentAudio.sourceArtifactKey, "public");
  if (
    !source ||
    source.byteLength !== currentAudio.byteLength ||
    sha256Bytes(source.body) !== currentAudio.audioSha256
  ) {
    throw new Error("The retained current audio is unavailable or changed.");
  }
  const saved = await storage.put({
    key: currentAudio.targetArtifactKey,
    body: source.body,
    contentType: "audio/mpeg",
    visibility: "public",
  });
  return { ...saved, body: source.body };
}

function currentAudioNarration(
  preparation: ContinualLearningAudioReviewPreparation,
  artifact: {
    key: string;
    contentType: string;
    byteLength: number;
  },
): ArticleNarration {
  return {
    version: 2,
    artifactKey: artifact.key,
    artifactVisibility: "public",
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    sourceTextSha256: preparation.sourceTextSha256,
    model: "tts-1",
    voice: "alloy",
    generatedAt: preparation.generatedAt,
    durationSeconds: currentAudio.durationSeconds,
    generationFingerprint: sha256Text(
      `continual-learning-review-current-v1:${preparation.sourceTextSha256}`,
    ),
    language: "en-US",
    profileVersion: 1,
    segments: [
      {
        index: 0,
        artifactKey: artifact.key,
        artifactVisibility: "public",
        contentType: artifact.contentType,
        byteLength: artifact.byteLength,
        startSeconds: 0,
        durationSeconds: currentAudio.durationSeconds,
        inputSha256: expectedInputSha256,
      },
    ],
    alignment: {
      version: 1,
      model: "whisper-1",
      generatedAt: preparation.generatedAt,
      transcriptSha256: currentAudio.transcriptSha256,
      sentenceMapFingerprint: preparation.sentenceMapFingerprint,
      sourceCoverage: 0.862949,
      exactMatchRatio: 0.862476,
      maxUnmatchedSourceRun: 14,
      maxUnmatchedTranscriptRun: 2,
      sentenceCues: continualLearningRecoveredCues,
    },
  };
}

async function upsertReviewArticle(
  preparation: ContinualLearningAudioReviewPreparation,
  id: string,
  excerpt: string,
  narration: ArticleNarration,
  processingCostUsd: number,
) {
  const sql = getDatabaseSql();
  const wordCount = preparation.textContent
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
  const sentenceTotal = annotateBlocks(preparation.blocks).sentences.length;
  const rows = await sql.query(
    `
      INSERT INTO articles (
        id, owner_email, title, source_type, source_url, folder_id,
        archived_at, created_at, updated_at, word_count, estimated_minutes,
        sentence_count, processing_cost_usd, progress_sentence_index,
        progress_percent, progress_updated_at, content_html, text_content,
        blocks, narration, excerpt, thumbnail_url, preview_version,
        content_fingerprint
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz,
        $7::timestamptz, $8, $9, $10, $11::numeric, 0, 0,
        $7::timestamptz, $12, $13, $14::jsonb, $15::jsonb, $16, $17, 2, NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        folder_id = EXCLUDED.folder_id,
        archived_at = EXCLUDED.archived_at,
        updated_at = EXCLUDED.updated_at,
        word_count = EXCLUDED.word_count,
        estimated_minutes = EXCLUDED.estimated_minutes,
        sentence_count = EXCLUDED.sentence_count,
        processing_cost_usd = EXCLUDED.processing_cost_usd,
        progress_sentence_index = 0,
        progress_percent = 0,
        progress_updated_at = EXCLUDED.progress_updated_at,
        content_html = EXCLUDED.content_html,
        text_content = EXCLUDED.text_content,
        blocks = EXCLUDED.blocks,
        narration = EXCLUDED.narration,
        excerpt = EXCLUDED.excerpt,
        thumbnail_url = EXCLUDED.thumbnail_url,
        preview_version = 2,
        content_fingerprint = NULL
      WHERE articles.owner_email = EXCLUDED.owner_email
      RETURNING id
    `,
    [
      id,
      preparation.ownerEmail,
      preparation.title,
      preparation.sourceType,
      preparation.sourceUrl ?? null,
      archiveFolderId,
      preparation.generatedAt,
      wordCount,
      Math.max(1, Math.ceil(wordCount / 225)),
      sentenceTotal,
      processingCostUsd,
      blocksToHtml(preparation.blocks),
      preparation.textContent,
      JSON.stringify(preparation.blocks),
      JSON.stringify(narration),
      excerpt,
      preparation.thumbnailUrl ?? null,
    ],
  );

  if ((rows[0] as { id?: unknown } | undefined)?.id !== id) {
    throw new Error(`Could not save review article ${id}.`);
  }
}

function validatePreparation(
  preparation: ContinualLearningAudioReviewPreparation,
) {
  assertOwner(preparation.ownerEmail);
  if (
    preparation.title !== expectedTitle ||
    preparation.sourceTextSha256 !== expectedSourceSha256 ||
    preparation.sentenceMapFingerprint !== expectedSentenceMapFingerprint ||
    preparation.sentences.length !== sentenceCount ||
    narrationSourceSha256(preparation.title, preparation.textContent) !==
      expectedSourceSha256 ||
    narrationSentenceMapFingerprint(
      annotateBlocks(preparation.blocks).sentences,
    ) !== expectedSentenceMapFingerprint
  ) {
    throw new Error("The audio review preparation is stale or invalid.");
  }
}

function parseParts(value: unknown): ReviewPart[] {
  const parts =
    value && typeof value === "object" && "parts" in value
      ? (value as { parts?: unknown }).parts
      : undefined;
  if (!Array.isArray(parts) || parts.length !== sentenceCount) {
    throw new Error("The retained narration sentence map is unavailable.");
  }

  return parts.map((part) => {
    const candidate = part as Partial<ReviewPart>;
    if (
      !Number.isSafeInteger(candidate.sentenceIndex) ||
      typeof candidate.sentenceText !== "string" ||
      !candidate.sentenceText ||
      typeof candidate.speechText !== "string" ||
      !candidate.speechText
    ) {
      throw new Error("The retained narration sentence map is invalid.");
    }
    return candidate as ReviewPart;
  });
}

function validateRecoveredCues(
  sentences: ContinualLearningAudioReviewSentence[],
) {
  if (continualLearningRecoveredCues.length !== sentences.length) {
    throw new Error("The recovered sentence cues are incomplete.");
  }
  for (const [index, sentence] of sentences.entries()) {
    const cue = continualLearningRecoveredCues[index];
    if (
      cue.sentenceIndex !== sentence.sentenceIndex ||
      comparableText(cue.sentenceText) !== comparableText(sentence.sentenceText)
    ) {
      throw new Error("The recovered sentence cues are stale.");
    }
  }
}

function blocksToText(blocks: ArticleBlock[]) {
  return blocks.map(blockToText).filter(Boolean).join("\n\n").trim();
}

function blockToText(block: ArticleBlock) {
  if (block.type === "list") return block.items.join("\n");
  if (block.type === "image") {
    return [block.alt, block.caption].filter(Boolean).join("\n");
  }
  if (block.type === "table") {
    return [
      block.caption,
      ...block.rows.map((row) => row.filter(Boolean).join("\t")),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return block.text;
}

function removeArtifactOwnership(block: ArticleBlock): ArticleBlock {
  if (block.type !== "image") return block;
  const safeBlock = { ...block };
  delete safeBlock.artifactKey;
  return safeBlock;
}

function comparableText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function assertOwner(ownerEmail: string) {
  if (ownerEmail !== continualLearningAudioReviewOwnerEmail) {
    throw new Error("This narration review is not available.");
  }
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sha256Bytes(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
