import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let basePath;

    if (specifier.startsWith("@/")) {
      basePath = path.join(projectRoot, "src", specifier.slice(2));
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      basePath = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
    }

    const resolvedPath = basePath && resolveSourceFile(basePath);

    if (resolvedPath) {
      return {
        url: pathToFileURL(resolvedPath).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

const {
  articleNarrationProfiles,
  detectArticleNarrationLanguage,
} = await import(
  "../src/server/articles/articleNarrationProfiles.ts"
);
const {
  narrationSegmentArtifactKey,
  prepareArticleNarration,
} = await import("../src/server/articles/articleNarrationPlan.ts");
const {
  ArticleNarrationSegmentError,
  assembleArticleNarration,
  generateArticleNarrationSegment,
  maximumNarrationSegmentAudioBytes,
} = await import("../src/server/articles/articleNarrationGeneration.ts");
const { alignNarrationSegment } = await import(
  "../src/server/articles/articleNarrationSegmentAlignment.ts"
);
const {
  comparableNarrationText,
  normalizeNarrationInput,
} = await import(
  "../src/server/articles/articleNarrationQa.ts"
);

test("selects explicit Chinese and English narration profiles", () => {
  assert.equal(
    detectArticleNarrationLanguage("黑风山土地", "这是一篇中文文章。"),
    "zh-CN",
  );
  assert.equal(
    detectArticleNarrationLanguage(
      "An English article",
      "This passage should use the English narration profile.",
    ),
    "en-US",
  );
  assert.equal(
    detectArticleNarrationLanguage("日本語", "これは日本語の記事です。"),
    null,
  );
  assert.equal(articleNarrationProfiles["zh-CN"].voice, "cedar");
  assert.equal(articleNarrationProfiles["en-US"].speechModel, "tts-1");
});

test("skips legacy image captions that are absent from canonical text", () => {
  const article = articleFixture({
    title: "黑风山土地",
    textContent: "第一句。\n\n第二句。",
    blocks: [
      {
        id: "image-1",
        type: "image",
        alt: "黑风山土地 实机图",
        caption: "实机图",
      },
      { id: "p-1", type: "paragraph", text: "第一句。" },
      { id: "p-2", type: "paragraph", text: "第二句。" },
    ],
  });
  const prepared = prepareArticleNarration(article);

  assert.deepEqual(
    prepared.units.map(({ sentenceIndex }) => sentenceIndex),
    [-1, 2, 3],
  );
  assert.doesNotMatch(
    prepared.chunks.map(({ input }) => input).join("\n"),
    /实机图/u,
  );
  assert.equal(
    prepared.units.slice(1).map(({ speechText }) =>
      comparableNarrationText(speechText)).join(""),
    comparableNarrationText(article.textContent),
  );
});

test("rejects a sentence map that cannot represent canonical article text", () => {
  assert.throws(
    () =>
      prepareArticleNarration(
        articleFixture({
          title: "Narration mismatch",
          textContent: "First sentence. Missing sentence.",
          blocks: [
            { id: "p-1", type: "paragraph", text: "First sentence." },
          ],
        }),
      ),
    /sentence map does not cover/u,
  );
});

test("does not narrate a leading title heading twice", () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "A title already in the article",
      textContent:
        "A title already in the article\n\nThe body starts here.",
      blocks: [
        {
          id: "heading-1",
          type: "heading",
          level: 1,
          text: "A title already in the article",
        },
        { id: "p-1", type: "paragraph", text: "The body starts here." },
      ],
    }),
  );

  assert.deepEqual(
    prepared.units.map(({ sentenceIndex }) => sentenceIndex),
    [0, 1],
  );
  assert.equal(
    prepared.units.filter(
      ({ speechText }) =>
        comparableNarrationText(speechText) ===
        comparableNarrationText("A title already in the article"),
    ).length,
    1,
  );
});

test("chunks pathological Unicode sentences without loss or overflow", () => {
  const body = `${"甲😀".repeat(2_100)}终。`;
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "超长文章",
      textContent: body,
      blocks: [{ id: "p-1", type: "paragraph", text: body }],
    }),
  );
  const bodyParts = prepared.chunks
    .flatMap(({ parts }) => parts)
    .filter(({ sentenceIndex }) => sentenceIndex === 0);

  assert.ok(prepared.chunks.length >= 2);
  assert.ok(
    prepared.chunks.every(
      ({ inputCodePoints }) =>
        inputCodePoints <=
        articleNarrationProfiles["zh-CN"].chunkMaximumCodePoints,
    ),
  );
  assert.equal(
    bodyParts.map(({ speechText }) => speechText).join(""),
    normalizeNarrationInput(body),
  );
  assert.equal(new Set(bodyParts.map(({ unitPartIndex }) => unitPartIndex)).size,
    bodyParts.length);

  const repeated = prepareArticleNarration(
    articleFixture({
      title: "超长文章",
      textContent: body,
      blocks: [{ id: "p-1", type: "paragraph", text: body }],
    }),
  );
  assert.equal(
    repeated.generationFingerprint,
    prepared.generationFingerprint,
  );
  assert.deepEqual(
    repeated.chunks.map(({ inputSha256 }) => inputSha256),
    prepared.chunks.map(({ inputSha256 }) => inputSha256),
  );
});

test("builds deterministic, attempt-specific segment artifact keys", () => {
  const base = {
    articleId: "article/with spaces",
    generationFingerprint: "a".repeat(64),
    chunkIndex: 2,
    inputSha256: "b".repeat(64),
  };
  const first = narrationSegmentArtifactKey({ ...base, attempt: 1 });

  assert.equal(first, narrationSegmentArtifactKey({ ...base, attempt: 1 }));
  assert.notEqual(first, narrationSegmentArtifactKey({ ...base, attempt: 2 }));
  assert.match(first, /\/0002-b{16}-attempt-1\.mp3$/u);
  assert.doesNotMatch(first, /with spaces/u);
});

test("stores Chinese speech before producing exact timestamp cues", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "中文标题",
      textContent: "第一句。第二句。",
      blocks: [
        { id: "p-1", type: "paragraph", text: "第一句。第二句。" },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const calls = [];
  const result = await generateArticleNarrationSegment(
    {
      articleId: prepared.articleId,
      generationFingerprint: prepared.generationFingerprint,
      profile: prepared.profile,
      chunk,
      attempt: 1,
    },
    generationDependencies(chunk, calls),
  );

  assert.equal(result.qa.ok, true);
  assert.equal(result.sentenceCues.length, prepared.units.length);
  assert.deepEqual(calls.map(([kind]) => kind), ["speech", "put", "transcribe"]);
  assert.equal(calls[0][1].model, "gpt-4o-mini-tts-2025-12-15");
  assert.equal(calls[0][1].voice, "cedar");
  assert.match(calls[0][1].instructions, /不得概括/u);
  assert.equal(calls[2][1].get("language"), "zh");
  assert.ok(result.cost.totalUsd > 0);
});

test("uses tts-1 without unsupported instructions for English", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "English title",
      textContent: "First sentence. Second sentence.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "First sentence. Second sentence.",
        },
      ],
    }),
  );
  const calls = [];

  await generateArticleNarrationSegment(
    {
      articleId: prepared.articleId,
      generationFingerprint: prepared.generationFingerprint,
      profile: prepared.profile,
      chunk: prepared.chunks[0],
      attempt: 1,
    },
    generationDependencies(prepared.chunks[0], calls),
  );

  assert.equal(calls[0][1].model, "tts-1");
  assert.equal(Object.hasOwn(calls[0][1], "instructions"), false);
  assert.equal(calls[2][1].get("language"), "en");
});

test("retries timestamp transcription on the same stored speech audio", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Retry test",
      textContent: "One stored voice file should be transcribed twice.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "One stored voice file should be transcribed twice.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const calls = [];
  const dependencies = generationDependencies(chunk, calls);
  const successfulFetch = dependencies.fetch;
  let transcriptionAttempts = 0;
  dependencies.fetch = async (url, init) => {
    if (
      url.endsWith("/audio/transcriptions") &&
      transcriptionAttempts++ === 0
    ) {
      calls.push(["transcribe", init.body]);
      return new Response("temporary failure", { status: 500 });
    }

    return successfulFetch(url, init);
  };

  const result = await generateArticleNarrationSegment(
    {
      articleId: prepared.articleId,
      generationFingerprint: prepared.generationFingerprint,
      profile: prepared.profile,
      chunk,
      attempt: 1,
    },
    dependencies,
  );

  assert.equal(result.qa.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), [
    "speech",
    "put",
    "transcribe",
    "transcribe",
  ]);
  assert.equal(calls.filter(([kind]) => kind === "speech").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
});

test("exhausted timestamp retries preserve audio without requesting TTS again", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Retry exhaustion",
      textContent: "The stored audio remains available for later alignment.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "The stored audio remains available for later alignment.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const calls = [];
  const dependencies = generationDependencies(chunk, calls);
  const speechFetch = dependencies.fetch;
  dependencies.fetch = async (url, init) => {
    if (url.endsWith("/audio/transcriptions")) {
      calls.push(["transcribe", init.body]);
      return new Response("still unavailable", { status: 503 });
    }

    return speechFetch(url, init);
  };

  await assert.rejects(
    generateArticleNarrationSegment(
      {
        articleId: prepared.articleId,
        generationFingerprint: prepared.generationFingerprint,
        profile: prepared.profile,
        chunk,
        attempt: 1,
      },
      dependencies,
    ),
    (error) => {
      assert.ok(error instanceof ArticleNarrationSegmentError);
      assert.equal(error.code, "alignment-retries-exhausted");
      assert.equal(error.retryable, true);
      assert.match(error.details.artifactKey, /\/audio\/v2\//u);
      return true;
    },
  );
  assert.deepEqual(calls.map(([kind]) => kind), [
    "speech",
    "put",
    "transcribe",
    "transcribe",
  ]);
});

test("a later alignment attempt reuses persisted speech without another TTS call", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Durable alignment retry",
      textContent: "Persisted speech should survive a transcription outage.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "Persisted speech should survive a transcription outage.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const calls = [];
  const artifacts = new Map();
  let alignmentAvailable = false;
  const dependencies = {
    apiKey: "test-openai-key",
    now: () => new Date("2026-08-19T10:00:00.000Z"),
    artifactStorage: {
      async put(input) {
        calls.push(["put", input]);
        const stored = {
          key: input.key,
          contentType: input.contentType,
          byteLength: input.body.byteLength,
          body: Buffer.from(input.body),
        };
        artifacts.set(input.key, stored);
        return stored;
      },
      async get(key) {
        calls.push(["get", key]);
        return artifacts.get(key) ?? null;
      },
    },
    async fetch(url, init) {
      if (url.endsWith("/audio/speech")) {
        calls.push(["speech", JSON.parse(init.body)]);
        return new Response(new Uint8Array(2_048), {
          headers: { "content-type": "audio/mpeg" },
        });
      }

      if (url.endsWith("/audio/transcriptions")) {
        calls.push(["transcribe", init.body]);
        return alignmentAvailable
          ? Response.json(timestampTranscription(chunk.expectedComparableText))
          : new Response("temporary outage", { status: 503 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  };
  let persistedSpeechArtifact;

  await assert.rejects(
    generateArticleNarrationSegment(
      {
        articleId: prepared.articleId,
        generationFingerprint: prepared.generationFingerprint,
        profile: prepared.profile,
        chunk,
        attempt: 1,
      },
      dependencies,
    ),
    (error) => {
      assert.ok(error instanceof ArticleNarrationSegmentError);
      persistedSpeechArtifact = {
        artifactKey: error.details.artifactKey,
        artifactVisibility: error.details.artifactVisibility,
        contentType: error.details.contentType,
        byteLength: error.details.byteLength,
      };
      return error.code === "alignment-retries-exhausted";
    },
  );

  alignmentAvailable = true;
  const result = await generateArticleNarrationSegment(
    {
      articleId: prepared.articleId,
      generationFingerprint: prepared.generationFingerprint,
      profile: prepared.profile,
      chunk,
      attempt: 2,
      persistedSpeechArtifact,
    },
    dependencies,
  );

  assert.equal(result.qa.ok, true);
  assert.equal(result.cost.speechUsd, 0);
  assert.equal(calls.filter(([kind]) => kind === "speech").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "get").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "transcribe").length, 3);
});

test("does not retry a paid TTS call when artifact persistence fails", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Storage failure",
      textContent: "Speech was generated before persistence failed.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "Speech was generated before persistence failed.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const dependencies = generationDependencies(chunk, []);
  dependencies.artifactStorage.put = async () => {
    throw new Error("storage unavailable");
  };

  await assert.rejects(
    generateArticleNarrationSegment(
      {
        articleId: prepared.articleId,
        generationFingerprint: prepared.generationFingerprint,
        profile: prepared.profile,
        chunk,
        attempt: 1,
      },
      dependencies,
    ),
    (error) =>
      error instanceof ArticleNarrationSegmentError &&
      error.code === "artifact-storage" &&
      error.retryable === false,
  );
});

test("rejects declared oversized audio before loading or storing it", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Size test",
      textContent: "This passage has an unexpectedly large audio response.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "This passage has an unexpectedly large audio response.",
        },
      ],
    }),
  );
  let audioRead = false;
  let artifactStored = false;

  await assert.rejects(
    generateArticleNarrationSegment(
      {
        articleId: prepared.articleId,
        generationFingerprint: prepared.generationFingerprint,
        profile: prepared.profile,
        chunk: prepared.chunks[0],
        attempt: 1,
      },
      {
        apiKey: "test-key",
        artifactStorage: {
          async put() {
            artifactStored = true;
            throw new Error("oversized audio must not be stored");
          },
        },
        async fetch() {
          return {
            ok: true,
            headers: new Headers({
              "content-type": "audio/mpeg",
              "content-length": String(
                maximumNarrationSegmentAudioBytes + 1,
              ),
            }),
            async arrayBuffer() {
              audioRead = true;
              throw new Error("oversized audio must not be read");
            },
          };
        },
      },
    ),
    (error) =>
      error instanceof ArticleNarrationSegmentError &&
      error.code === "speech-response-too-large" &&
      error.retryable === false,
  );
  assert.equal(audioRead, false);
  assert.equal(artifactStored, false);
});

test("rejects timestamp transcripts that skip a contiguous passage", () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Coverage test",
      textContent: "Alpha bravo charlie delta echo foxtrot.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "Alpha bravo charlie delta echo foxtrot.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const actual = chunk.expectedComparableText.replace("charliedelta", "");
  const alignment = alignNarrationSegment(
    chunk,
    prepared.profile,
    timestampTranscription(actual),
  );

  assert.equal(alignment.qa.ok, false);
  assert.ok(alignment.qa.maxUnmatchedSourceRun > 6);
  assert.match(alignment.qa.failures.join(" "), /contiguous source span/u);
});

test("assembles segment-local cues into one global V2 timeline", () => {
  const body = `${"甲".repeat(4_100)}。`;
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "长文",
      textContent: body,
      blocks: [{ id: "p-1", type: "paragraph", text: body }],
    }),
  );
  const generated = prepared.chunks.map((chunk) =>
    generatedSegmentFixture(prepared, chunk),
  );
  const assembled = assembleArticleNarration(prepared, generated, {
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  });

  assert.equal(assembled.narration.version, 2);
  assert.equal(
    assembled.narration.segments.length,
    prepared.chunks.length,
  );
  assert.deepEqual(
    assembled.narration.segments.map(({ startSeconds }) => startSeconds),
    prepared.chunks.map((_, index) => index * 2),
  );
  assert.equal(assembled.narration.durationSeconds, prepared.chunks.length * 2);
  assert.equal(assembled.narration.alignment.sentenceCues.length, 2);
  assert.equal(
    assembled.narration.alignment.sentenceCues[1].sentenceIndex,
    0,
  );
  assert.ok(
    assembled.narration.alignment.sentenceCues[1].endSeconds > 2,
  );
});

test("surfaces persisted candidate metadata when segment QA fails", async () => {
  const prepared = prepareArticleNarration(
    articleFixture({
      title: "Failure test",
      textContent: "This complete passage must be spoken.",
      blocks: [
        {
          id: "p-1",
          type: "paragraph",
          text: "This complete passage must be spoken.",
        },
      ],
    }),
  );
  const chunk = prepared.chunks[0];
  const calls = [];

  await assert.rejects(
    generateArticleNarrationSegment(
      {
        articleId: prepared.articleId,
        generationFingerprint: prepared.generationFingerprint,
        profile: prepared.profile,
        chunk,
        attempt: 1,
      },
      generationDependencies(chunk, calls, "failuretestthisspoken"),
    ),
    (error) => {
      assert.ok(error instanceof ArticleNarrationSegmentError);
      assert.equal(error.code, "qa-failed");
      assert.equal(error.retryable, false);
      assert.match(error.details.artifactKey, /\/audio\/v2\//u);
      assert.equal(error.details.qa.ok, false);
      return true;
    },
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["speech", "put", "transcribe"]);
});

function generationDependencies(chunk, calls, transcript) {
  return {
    apiKey: "test-openai-key",
    now: () => new Date("2026-08-19T10:00:00.000Z"),
    artifactStorage: {
      async put(input) {
        calls.push(["put", input]);
        return {
          key: input.key,
          contentType: input.contentType,
          byteLength: input.body.byteLength,
        };
      },
    },
    async fetch(url, init) {
      if (url.endsWith("/audio/speech")) {
        const request = JSON.parse(init.body);
        calls.push(["speech", request]);
        return new Response(new Uint8Array(2_048), {
          headers: { "content-type": "audio/mpeg" },
        });
      }

      if (url.endsWith("/audio/transcriptions")) {
        calls.push(["transcribe", init.body]);
        return Response.json(
          timestampTranscription(
            transcript ?? chunk.expectedComparableText,
          ),
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    },
  };
}

function timestampTranscription(text) {
  const characters = Array.from(text);
  const words = characters.map((word, index) => ({
    word,
    start: 0.2 + index * 0.03,
    end: 0.2 + (index + 1) * 0.03,
  }));

  return {
    text,
    duration: 0.7 + characters.length * 0.03,
    words,
  };
}

function generatedSegmentFixture(prepared, chunk) {
  const sentenceCues = chunk.parts.map((part, index) => ({
    sentenceIndex: part.sentenceIndex,
    sentenceText: part.sentenceText,
    startSeconds: 0.1 + index * 0.5,
    endSeconds: 0.5 + index * 0.5,
  }));

  return {
    index: chunk.index,
    inputSha256: chunk.inputSha256,
    inputCodePoints: chunk.inputCodePoints,
    generationFingerprint: prepared.generationFingerprint,
    profileId: prepared.profile.id,
    speechModel: prepared.profile.speechModel,
    voice: prepared.profile.voice,
    alignmentModel: prepared.profile.transcriptionModel,
    artifactKey: `articles/test/${chunk.index}.mp3`,
    artifactVisibility: "public",
    contentType: "audio/mpeg",
    byteLength: 2_048,
    durationSeconds: 2,
    transcriptSha256: String(chunk.index).padStart(64, "0"),
    sentenceCues,
    qa: {
      ok: true,
      expectedCharacters: chunk.expectedComparableText.length,
      transcriptCharacters: chunk.expectedComparableText.length,
      sourceCoverage: 1,
      exactMatchRatio: 1,
      maxUnmatchedSourceRun: 0,
      maxUnmatchedTranscriptRun: 0,
      firstAnchorExactRatio: 1,
      lastAnchorExactRatio: 1,
      forbiddenQuoteMarkers: [],
      failures: [],
    },
    cost: {
      speechUsd: 0.01,
      alignmentUsd: 0.001,
      diagnosticTranscriptUsd: 0,
      totalUsd: 0.011,
    },
    generatedAt: "2026-08-19T10:00:00.000Z",
  };
}

function articleFixture({ title, textContent, blocks }) {
  return {
    id: "article-test",
    title,
    textContent,
    blocks,
  };
}

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
  ];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
