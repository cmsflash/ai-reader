#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { get, put } from "@vercel/blob";
import { loadLocalEnv } from "./lib/env.mjs";

loadLocalEnv();

const ownerEmail = "cmsflash99@gmail.com";
const originalArticleId = "4fdc1044-1b4b-4105-9775-2135b4a478fa";
const originalJobId = "narration-job-ba1ecd4d-e3d1-4cd5-9fdc-9792d38ecf0b";
const archiveFolderId = "cmsflash99@gmail.com:archive";
const currentAudioReviewId = "review-continual-learning-current-audio";
const sentenceAudioReviewId = "review-continual-learning-sentence-audio";
const expectedTitle = "Continual Learning: End of Frozen Software";
const expectedInputSha256 =
  "25478e820efa32d9e8af8c90bb849e915024079847af731520264e1b08b30ca9";
const expectedSourceSha256 =
  "8c044e2fc21b7ce56c2a859541f447920dc91afad584f4c83f25ae7b0371dc0b";
const expectedSentenceMapFingerprint = "fnv1a32:1a701529";
const expectedSentenceCount = 52;
const expectedSentenceInputCodePoints = 2_604;
const originalAudio = {
  artifactKey:
    "articles/4fdc1044-1b4b-4105-9775-2135b4a478fa/audio/v2/090676969b329fe57a6ba96ba5435edaadca0167eb18167fdd3a9f55ffabec4a/segments/0000-25478e820efa32d9-attempt-1.mp3",
  byteLength: 2_631_168,
  durationSeconds: 164.44,
  transcriptSha256:
    "b5cd8fa431c978e8b9e1cefab880999d6eabaac9f6b7b190f8ee6369426031e3",
};

const progressFile = argumentValue("--progress-file");

if (!process.argv.includes("--production") || !progressFile) {
  throw new Error(
    "Pass --production and --progress-file <decrypted-workflow-progress.json>.",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const openAiApiKey =
  process.env.OPENAI_API_KEY_AI_READER ?? process.env.OPENAI_API_KEY;

if (!databaseUrl || !openAiApiKey || !process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error("Production database, OpenAI, and Blob credentials are required.");
}

const sql = neon(databaseUrl);
const progress = JSON.parse(await readFile(progressFile, "utf8"));
const [article] = await sql.query(
  `
    SELECT
      id, title, source_type, source_url, blocks, text_content,
      thumbnail_url
    FROM articles
    WHERE id = $1 AND owner_email = $2
    LIMIT 1
  `,
  [originalArticleId, ownerEmail],
);
const [segment] = await sql.query(
  `
    SELECT input_text, input_sha256, input_code_points, unit_map
    FROM article_narration_job_segments
    WHERE job_id = $1 AND segment_index = 0
    LIMIT 1
  `,
  [originalJobId],
);
const [archiveFolder] = await sql.query(
  `
    SELECT id
    FROM reading_folders
    WHERE id = $1 AND owner_email = $2 AND is_archive = true
    LIMIT 1
  `,
  [archiveFolderId, ownerEmail],
);

if (!article || article.title !== expectedTitle || !segment || !archiveFolder) {
  throw new Error("The exact production review source could not be verified.");
}
if (
  segment.input_sha256 !== expectedInputSha256 ||
  segment.input_code_points !== 2_706
) {
  throw new Error("The retained narration segment no longer matches this review.");
}

const parts = segment.unit_map?.parts;
const recoveredCues =
  progress.localSentenceCues ?? progress.alignment?.sentenceCues;

if (
  !Array.isArray(parts) ||
  parts.length !== expectedSentenceCount ||
  !Array.isArray(recoveredCues) ||
  recoveredCues.length !== expectedSentenceCount
) {
  throw new Error("The 52-sentence review map or recovered cues are unavailable.");
}

for (const [index, part] of parts.entries()) {
  const cue = recoveredCues[index];
  if (
    !part?.speechText ||
    part.sentenceIndex !== cue?.sentenceIndex ||
    comparableText(part.sentenceText) !== comparableText(cue.sentenceText)
  ) {
    throw new Error(`Recovered cue ${index} does not match the source sentence.`);
  }
}

const sentenceInputCodePoints = parts.reduce(
  (total, part) => total + Array.from(part.speechText).length,
  0,
);
if (sentenceInputCodePoints !== expectedSentenceInputCodePoints) {
  throw new Error("Sentence inputs changed; refusing an incomparable paid run.");
}

const blocks = article.blocks.slice(0, 18).map(removeSharedArtifactOwnership);
const textContent = blocksToText(blocks);
const sourceTextSha256 = sha256Text(`${article.title}\n\n${textContent}`);

if (sourceTextSha256 !== expectedSourceSha256) {
  throw new Error("The review excerpt changed; refusing to create stale copies.");
}

if (process.argv.includes("--validate-only")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        articleId: originalArticleId,
        sentenceCount: parts.length,
        sentenceInputCodePoints,
        sourceTextSha256,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const generatedAt = new Date().toISOString();
const currentAudioKey =
  `articles/${currentAudioReviewId}/audio/review/current-passage.mp3`;
const copiedCurrentAudio = await copyPublicArtifact(
  originalAudio.artifactKey,
  currentAudioKey,
  "audio/mpeg",
  originalAudio.byteLength,
);
const currentNarration = {
  version: 2,
  artifactKey: copiedCurrentAudio.key,
  artifactVisibility: "public",
  contentType: copiedCurrentAudio.contentType,
  byteLength: copiedCurrentAudio.byteLength,
  sourceTextSha256,
  model: "tts-1",
  voice: "alloy",
  generatedAt,
  durationSeconds: originalAudio.durationSeconds,
  generationFingerprint: sha256Text(
    `continual-learning-review-current-v1:${sourceTextSha256}`,
  ),
  language: "en-US",
  profileVersion: 1,
  segments: [
    {
      index: 0,
      artifactKey: copiedCurrentAudio.key,
      artifactVisibility: "public",
      contentType: copiedCurrentAudio.contentType,
      byteLength: copiedCurrentAudio.byteLength,
      startSeconds: 0,
      durationSeconds: originalAudio.durationSeconds,
      inputSha256: expectedInputSha256,
    },
  ],
  alignment: {
    version: 1,
    model: progress.alignmentModel ?? "whisper-1",
    generatedAt,
    transcriptSha256:
      progress.transcriptSha256 ?? originalAudio.transcriptSha256,
    sentenceMapFingerprint: expectedSentenceMapFingerprint,
    sourceCoverage: numberValue(progress.qa?.sourceCoverage, 0.862949),
    exactMatchRatio: numberValue(progress.qa?.exactMatchRatio, 0.862476),
    maxUnmatchedSourceRun: numberValue(
      progress.qa?.maxUnmatchedSourceRun,
      14,
    ),
    maxUnmatchedTranscriptRun: numberValue(
      progress.qa?.maxUnmatchedTranscriptRun,
      2,
    ),
    sentenceCues: recoveredCues,
  },
};

const generatedSentences = await mapWithConcurrency(parts, 4, async (part, index) => {
  const inputSha256 = sha256Text(part.speechText);
  const key =
    `articles/${sentenceAudioReviewId}/audio/review/sentences/` +
    `${String(index).padStart(3, "0")}-${inputSha256.slice(0, 16)}.wav`;
  const stored = await loadPublicArtifact(key);

  if (stored) {
    return sentenceArtifact(index, part, inputSha256, stored);
  }

  const audio = await createSentenceSpeech(part.speechText, openAiApiKey);
  const saved = await put(key, audio, {
    access: "public",
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType: "audio/wav",
  });
  const artifact = {
    key: saved.pathname,
    body: audio,
    contentType: saved.contentType || "audio/wav",
    byteLength: audio.byteLength,
  };

  process.stdout.write(`Generated sentence ${index + 1}/${parts.length}.\n`);
  return sentenceArtifact(index, part, inputSha256, artifact);
});

let elapsedSeconds = 0;
const sentenceSegments = [];
const sentenceCues = [];

for (const generated of generatedSentences) {
  const startSeconds = round(elapsedSeconds, 6);
  const endSeconds = round(startSeconds + generated.durationSeconds, 6);
  sentenceSegments.push({
    index: generated.index,
    artifactKey: generated.artifactKey,
    artifactVisibility: "public",
    contentType: generated.contentType,
    byteLength: generated.byteLength,
    startSeconds,
    durationSeconds: generated.durationSeconds,
    inputSha256: generated.inputSha256,
  });
  sentenceCues.push({
    sentenceIndex: generated.sentenceIndex,
    sentenceText: generated.sentenceText,
    startSeconds,
    endSeconds,
  });
  elapsedSeconds = endSeconds;
}

const sentenceGenerationCostUsd = round(
  (sentenceInputCodePoints / 1_000_000) * 15,
  6,
);
const firstSentenceSegment = sentenceSegments[0];
const sentenceNarration = {
  version: 2,
  artifactKey: firstSentenceSegment.artifactKey,
  artifactVisibility: "public",
  contentType: firstSentenceSegment.contentType,
  byteLength: firstSentenceSegment.byteLength,
  sourceTextSha256,
  model: "tts-1",
  voice: "alloy",
  generatedAt,
  durationSeconds: elapsedSeconds,
  generationFingerprint: sha256Text(
    `continual-learning-review-sentences-v1:${sourceTextSha256}`,
  ),
  language: "en-US",
  profileVersion: 1,
  segments: sentenceSegments,
  alignment: {
    version: 1,
    model: "structural-sentence-boundaries-v1",
    generatedAt,
    transcriptSha256: sha256Text(parts.map((part) => part.speechText).join("\n")),
    sentenceMapFingerprint: expectedSentenceMapFingerprint,
    sourceCoverage: 1,
    exactMatchRatio: 1,
    maxUnmatchedSourceRun: 0,
    maxUnmatchedTranscriptRun: 0,
    sentenceCues,
  },
};

const commonArticle = {
  title: article.title,
  sourceType: article.source_type,
  sourceUrl: article.source_url,
  folderId: archiveFolderId,
  archivedAt: generatedAt,
  createdAt: generatedAt,
  updatedAt: generatedAt,
  wordCount: wordCount(textContent),
  estimatedMinutes: Math.max(1, Math.ceil(wordCount(textContent) / 225)),
  sentenceCount: 53,
  contentHtml: blocksToHtml(blocks),
  textContent,
  blocks,
  thumbnailUrl: article.thumbnail_url,
};

await upsertReviewArticle(sql, {
  ...commonArticle,
  id: currentAudioReviewId,
  excerpt: "Audio review A: retained whole-passage audio with best-effort sentence matching.",
  narration: currentNarration,
  processingCostUsd: 0,
});
await upsertReviewArticle(sql, {
  ...commonArticle,
  id: sentenceAudioReviewId,
  excerpt: "Audio review B: the same passage generated and played sentence by sentence.",
  narration: sentenceNarration,
  processingCostUsd: sentenceGenerationCostUsd,
});

const productionOrigin = "https://ai-reader-liard.vercel.app";
process.stdout.write(
  `${JSON.stringify(
    {
      currentAudioUrl:
        `${productionOrigin}/?article=${encodeURIComponent(currentAudioReviewId)}`,
      sentenceAudioUrl:
        `${productionOrigin}/?article=${encodeURIComponent(sentenceAudioReviewId)}`,
      currentAudioIncrementalOpenAiCostUsd: 0,
      currentAudioHistoricalOpenAiCostUsd: 0.057034,
      sentenceAudioActualOpenAiCostUsd: sentenceGenerationCostUsd,
      sentenceAudioDurationSeconds: elapsedSeconds,
      sentenceCount: sentenceSegments.length,
    },
    null,
    2,
  )}\n`,
);

async function createSentenceSpeech(text, apiKey) {
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

async function copyPublicArtifact(sourceKey, targetKey, contentType, byteLength) {
  const existing = await loadPublicArtifact(targetKey);
  if (existing) {
    if (existing.byteLength !== byteLength) {
      throw new Error("The existing review audio copy has an unexpected size.");
    }
    return existing;
  }

  const source = await loadPublicArtifact(sourceKey);
  if (!source || source.byteLength !== byteLength) {
    throw new Error("The retained current audio is unavailable or changed.");
  }
  const saved = await put(targetKey, source.body, {
    access: "public",
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType,
  });

  return {
    key: saved.pathname,
    body: source.body,
    contentType: saved.contentType || contentType,
    byteLength: source.byteLength,
  };
}

async function loadPublicArtifact(key) {
  const result = await get(key, { access: "public" });
  if (!result || result.statusCode !== 200) {
    return null;
  }
  const body = Buffer.from(await new Response(result.stream).arrayBuffer());
  return {
    key: result.blob.pathname,
    body,
    contentType: result.blob.contentType,
    byteLength: result.blob.size,
  };
}

function sentenceArtifact(index, part, inputSha256, artifact) {
  return {
    index,
    sentenceIndex: part.sentenceIndex,
    sentenceText: part.sentenceText,
    inputSha256,
    artifactKey: artifact.key,
    contentType: artifact.contentType || "audio/wav",
    byteLength: artifact.byteLength,
    durationSeconds: wavDurationSeconds(artifact.body),
  };
}

function wavDurationSeconds(buffer) {
  if (
    buffer.byteLength < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("OpenAI returned an invalid WAV file.");
  }

  let byteRate = 0;
  let dataBytes = 0;
  let cursor = 12;
  while (cursor + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString("ascii", cursor, cursor + 4);
    const chunkBytes = buffer.readUInt32LE(cursor + 4);
    const chunkStart = cursor + 8;
    if (chunkStart + chunkBytes > buffer.byteLength) {
      throw new Error("OpenAI returned a truncated WAV file.");
    }
    if (chunkId === "fmt " && chunkBytes >= 16) {
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkId === "data") {
      dataBytes += chunkBytes;
    }
    cursor = chunkStart + chunkBytes + (chunkBytes % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) {
    throw new Error("OpenAI returned WAV audio without playable sample data.");
  }
  return round(dataBytes / byteRate, 6);
}

async function upsertReviewArticle(sqlClient, articleToSave) {
  const rows = await sqlClient.query(
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
        $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
        $9::timestamptz, $10, $11, $12, $13::numeric, 0, 0,
        $9::timestamptz, $14, $15, $16::jsonb, $17::jsonb, $18, $19, 2, NULL
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
      articleToSave.id,
      ownerEmail,
      articleToSave.title,
      articleToSave.sourceType,
      articleToSave.sourceUrl,
      articleToSave.folderId,
      articleToSave.archivedAt,
      articleToSave.createdAt,
      articleToSave.updatedAt,
      articleToSave.wordCount,
      articleToSave.estimatedMinutes,
      articleToSave.sentenceCount,
      articleToSave.processingCostUsd,
      articleToSave.contentHtml,
      articleToSave.textContent,
      JSON.stringify(articleToSave.blocks),
      JSON.stringify(articleToSave.narration),
      articleToSave.excerpt,
      articleToSave.thumbnailUrl,
    ],
  );

  if (rows[0]?.id !== articleToSave.id) {
    throw new Error(`Could not save review article ${articleToSave.id}.`);
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

function blocksToText(blocks) {
  return blocks.map(blockToText).filter(Boolean).join("\n\n").trim();
}

function blockToText(block) {
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

function blocksToHtml(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "heading") {
        return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
      }
      if (block.type === "image") {
        return block.src
          ? `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || "")}"></figure>`
          : "";
      }
      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
      }
      if (block.type === "quote") {
        return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      }
      return `<p>${escapeHtml(block.text ?? "")}</p>`;
    })
    .join("");
}

function removeSharedArtifactOwnership(block) {
  if (block.type !== "image") return block;
  const safeBlock = { ...block };
  delete safeBlock.artifactKey;
  return safeBlock;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function comparableText(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function wordCount(value) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function numberValue(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
