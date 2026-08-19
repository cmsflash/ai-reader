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

const { getSavedArticleNarrationArtifact } = await import(
  "../src/server/articles/articleService.ts"
);
const { articleNarrationResponse } = await import(
  "../src/server/articles/articleNarrationResponse.ts"
);
const {
  generatePilotArticleNarration,
  mp3DurationSeconds,
  PilotNarrationError,
  verifyPilotNarrationModelAccess,
} = await import("../src/server/articles/articleNarrationPilot.ts");
const {
  alignPilotArticleNarration,
  alignSourceCharacters,
  buildNarrationAlignment,
} = await import("../src/server/articles/articleNarrationAlignment.ts");
const {
  canonicalNarrationSource,
  comparableNarrationText,
  narrationSourceSha256,
} = await import(
  "../src/server/articles/articleNarrationQa.ts"
);

const pilotBody = [
  "慈眉掩善光，善目遮锋芒。",
  "妙法助英豪，良心因果长。",
  "天规载，土地公有察点本坊生灵，保育此地水土的职责。",
  "这日，黑风山土地公依例在山中巡视俗务，正见有位老道士自远处而来。他穿一领星辰点就的道袍，挎一个青藤编就的药篮，手里敲着渔鼓，嘴里唱着月高，三两步飘摇到了近前。",
  "土地公仔细打量，认定不曾相识，但凭那鹤发童颜，星目含威的气度，便知不是凡人，赶紧道了个问讯：“老道长，小仙起手了。”",
  "老道士微微颔首，将自己的药篮递了过去。土地公一瞧，篮中俱是些珍奇事物，灵丹妙药，不由心惊，问道：“小仙如何受得起这般厚礼？”",
  "那道士笑道：“我原是路过此地，但料想此后不久，这山中有场大动荡，想这篮中之物，必能帮你熬上一阵，便来拜访了。”",
  "“道长何出此言？”",
  "“我有个故人，性子不良，如今虽积下些功业，但依着他那倨傲的本心，准是难以安生，总怕他再闯些烧身大祸来……”",
  "土地公细细寻思，诚然道：“小仙能帮些什么？” 老道士见他有些乖觉，招手让他上前，附耳传了他几门保命的法术，并嘱咐道：“若你在山中遇着他，可将此两法相传。我不便出面，只能借你手，教他一二，全了一场情义。”",
  "土地公感激不已，作揖深谢，那老道士还了一礼，就要乘云而去，土地公急急追问：“敢问道长，仙居何处？”",
  "那道士早已踏着祥云远去，天上飘下一片叶子，香味清远，叶尖极细极长。土地公似有所悟，赶紧朝着远处行礼作揖，直至云烟都不见了，方才离去。",
  "慈眉掩善光，善目遮锋芒。",
  "妙法助英豪，良心因果长。",
].join("\n\n");

test("checks the pinned narration model without generating audio", async () => {
  const requests = [];
  const result = await verifyPilotNarrationModelAccess(
    "black-myth-journal-5df74e22bc38174a8a99c9b2",
    "cmsflash99@gmail.com",
    {
      apiKey: "test-openai-key",
      async fetch(url, init) {
        requests.push({ url, init });
        return Response.json({ id: url.split("/").at(-1) });
      },
    },
  );

  assert.equal(result.model, "gpt-4o-mini-tts-2025-12-15");
  assert.equal(result.transcriptModel, "gpt-transcribe");
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/models\/gpt-4o-mini-tts-2025-12-15$/u);
  assert.match(requests[1].url, /\/models\/gpt-transcribe$/u);
  assert.ok(
    requests.every(
      (request) =>
        request.init.headers.authorization === "Bearer test-openai-key" &&
        request.init.method === undefined,
    ),
  );
});

test("model access check rejects every non-pilot owner before an API call", async () => {
  let requested = false;

  await assert.rejects(
    verifyPilotNarrationModelAccess(
      "black-myth-journal-5df74e22bc38174a8a99c9b2",
      "other@example.com",
      {
        apiKey: "test-openai-key",
        async fetch() {
          requested = true;
          return Response.json({});
        },
      },
    ),
    /limited to one article/u,
  );
  assert.equal(requested, false);
});

test("reads duration from the generated MP3 frame bitrate", () => {
  const audio = Buffer.alloc(2_400_000);
  audio.writeUInt32BE(0xfffb9000, 0);

  assert.equal(mp3DurationSeconds(audio), 150);
});

test("stores a complete narration after high-accuracy QA without the mini diagnostic", async () => {
  const article = pilotArticleFixture();
  const calls = [];
  const result = await generatePilotArticleNarration(
    article.id,
    "cmsflash99@gmail.com",
    {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost() {
          throw new Error("diagnostic cost should not be recorded on success");
        },
        async updateNarration(id, ownerEmail, narration, costUsd, onlyIfEmpty) {
          calls.push(["update", id, ownerEmail, costUsd, onlyIfEmpty]);
          return { ...article, narration, processingCostUsd: costUsd };
        },
      },
      artifactStorage: narrationStorage(calls),
      fetch: narrationFetch(calls, {
        primaryTranscript: canonicalNarrationSource(article.title, pilotBody),
      }),
      apiKey: "test-key",
      durationSecondsForAudio: () => 150,
    },
  );

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.qa.ok, true);
  assert.match(result.narration.artifactKey, /\/audio\//u);
  assert.doesNotMatch(result.narration.artifactKey, /\/candidates\//u);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "transcribe").map(([, model]) => model),
    ["gpt-transcribe"],
  );
  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "delete").length, 0);
  assert.equal(calls.filter(([kind]) => kind === "update").length, 1);
});

test("accepts a strict mini QA pass when the primary transcript has homophone errors", async () => {
  const article = pilotArticleFixture();
  const calls = [];
  const complete = canonicalNarrationSource(article.title, pilotBody);
  const primaryWithHomophones = complete
    .replaceAll("慈眉掩善光", "慈眉眼善光")
    .replaceAll("善目遮锋芒", "善目遮风芒");
  const result = await generatePilotArticleNarration(
    article.id,
    "cmsflash99@gmail.com",
    {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost() {
          throw new Error("accepted audio uses the atomic narration cost write");
        },
        async updateNarration(id, ownerEmail, narration, costUsd, onlyIfEmpty) {
          calls.push(["update", id, ownerEmail, costUsd, onlyIfEmpty]);
          return { ...article, narration, processingCostUsd: costUsd };
        },
      },
      artifactStorage: narrationStorage(calls),
      fetch: narrationFetch(calls, {
        primaryTranscript: primaryWithHomophones,
        diagnosticTranscript: complete,
      }),
      apiKey: "test-key",
      durationSecondsForAudio: () => 150,
    },
  );

  assert.equal(result.qa.ok, true);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "transcribe").map(([, model]) => model),
    ["gpt-transcribe", "gpt-4o-mini-transcribe"],
  );
  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "cost").length, 0);
  assert.equal(calls.filter(([kind]) => kind === "update").length, 1);
});

test("does not let a mini pass hide quote-marker speech in the primary transcript", async () => {
  const article = pilotArticleFixture();
  const calls = [];
  const complete = canonicalNarrationSource(article.title, pilotBody);

  await assert.rejects(
    generatePilotArticleNarration(article.id, "cmsflash99@gmail.com", {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost(id, ownerEmail, costUsd) {
          calls.push(["cost", id, ownerEmail, costUsd]);
          return { ...article, processingCostUsd: costUsd };
        },
        async updateNarration() {
          throw new Error("unsafe audio must not attach");
        },
      },
      artifactStorage: narrationStorage(calls),
      fetch: narrationFetch(calls, {
        primaryTranscript: `${complete} right handed quotation mark`,
        diagnosticTranscript: complete,
      }),
      apiKey: "test-key",
      durationSecondsForAudio: () => 150,
    }),
    (error) => {
      assert.ok(error instanceof PilotNarrationError);
      assert.equal(error.status, 422);
      assert.ok(error.details.qa.forbiddenQuoteMarkers.includes("quotation"));
      assert.equal(error.details.diagnosticQa.ok, true);
      assert.match(error.details.candidateArtifactKey, /\/audio\/candidates\//u);
      return true;
    },
  );

  assert.equal(calls.filter(([kind]) => kind === "update").length, 0);
  assert.equal(calls.filter(([kind]) => kind === "cost").length, 1);
});

test("retains and accounts for a rejected candidate with two transcript reports", async () => {
  const article = pilotArticleFixture();
  const calls = [];
  const incomplete = canonicalNarrationSource(article.title, pilotBody)
    .split("\n\n")
    .slice(0, -2)
    .join("\n\n");

  await assert.rejects(
    generatePilotArticleNarration(article.id, "cmsflash99@gmail.com", {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost(id, ownerEmail, costUsd) {
          calls.push(["cost", id, ownerEmail, costUsd]);
          return { ...article, processingCostUsd: costUsd };
        },
        async updateNarration() {
          throw new Error("a rejected candidate must not attach");
        },
      },
      artifactStorage: narrationStorage(calls),
      fetch: narrationFetch(calls, {
        primaryTranscript: incomplete,
        diagnosticTranscript: incomplete,
      }),
      apiKey: "test-key",
      durationSecondsForAudio: () => 150,
    }),
    (error) => {
      assert.ok(error instanceof PilotNarrationError);
      assert.equal(error.status, 422);
      assert.equal(error.details.costRecorded, true);
      assert.match(error.details.candidateArtifactKey, /\/audio\/candidates\//u);
      assert.match(error.details.candidateAudioPath, /^\/api\/artifacts\//u);
      assert.equal(error.details.qa.ok, false);
      assert.equal(error.details.diagnosticQa.ok, false);
      return true;
    },
  );

  assert.deepEqual(
    calls.filter(([kind]) => kind === "transcribe").map(([, model]) => model),
    ["gpt-transcribe", "gpt-4o-mini-transcribe"],
  );
  assert.equal(calls.filter(([kind]) => kind === "cost").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
});

test("deletes generated audio when the narration database write throws", async () => {
  const article = pilotArticleFixture();
  const calls = [];

  await assert.rejects(
    generatePilotArticleNarration(article.id, "cmsflash99@gmail.com", {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost() {
          return article;
        },
        async updateNarration() {
          throw new Error("database unavailable");
        },
      },
      artifactStorage: narrationStorage(calls),
      fetch: narrationFetch(calls, {
        primaryTranscript: canonicalNarrationSource(article.title, pilotBody),
      }),
      apiKey: "test-key",
      durationSecondsForAudio: () => 150,
    }),
    (error) => error instanceof PilotNarrationError && error.status === 500,
  );

  assert.equal(calls.filter(([kind]) => kind === "put").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "delete").length, 1);
});

test("loads narration only after an owner-scoped article lookup succeeds", async () => {
  const calls = [];
  const article = articleFixture();
  const artifact = {
    key: article.narration.artifactKey,
    body: Buffer.from("audio"),
    contentType: "audio/mpeg",
    byteLength: 5,
  };
  const result = await getSavedArticleNarrationArtifact(
    article.id,
    "reader@example.com",
    {
      articleRepository: {
        async findById(id, ownerEmail) {
          calls.push(["article", id, ownerEmail]);
          return article;
        },
      },
      artifactStorage: {
        async get(key, visibility) {
          calls.push(["artifact", key, visibility]);
          return artifact;
        },
      },
    },
  );

  assert.deepEqual(calls, [
    ["article", article.id, "reader@example.com"],
    ["artifact", article.narration.artifactKey, "public"],
  ]);
  assert.equal(result?.article, article);
  assert.equal(result?.artifact, artifact);
});

test("loads only the requested narration segment", async () => {
  const article = articleFixture();
  article.narration.segments = [
    {
      index: 0,
      artifactKey: article.narration.artifactKey,
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 5,
      startSeconds: 0,
      durationSeconds: 1,
      inputSha256: "a".repeat(64),
    },
    {
      index: 1,
      artifactKey: "articles/narrated/audio/segment-1.mp3",
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 7,
      startSeconds: 1,
      durationSeconds: 2,
      inputSha256: "b".repeat(64),
    },
  ];
  const reads = [];
  const result = await getSavedArticleNarrationArtifact(
    article.id,
    "reader@example.com",
    {
      articleRepository: { async findById() { return article; } },
      artifactStorage: {
        async get(key, visibility) {
          reads.push([key, visibility]);
          return {
            key,
            body: Buffer.from("segment"),
            contentType: "audio/mpeg",
            byteLength: 7,
          };
        },
      },
    },
    1,
  );

  assert.deepEqual(reads, [
    ["articles/narrated/audio/segment-1.mp3", "public"],
  ]);
  assert.equal(result?.segment?.index, 1);
  assert.equal(
    await getSavedArticleNarrationArtifact(
      article.id,
      "reader@example.com",
      {
        articleRepository: { async findById() { return article; } },
        artifactStorage: { async get() { throw new Error("unexpected"); } },
      },
      99,
    ),
    null,
  );
});

test("does not load an artifact for a missing or unnarrated article", async () => {
  let artifactReads = 0;
  const artifactStorage = {
    async get() {
      artifactReads += 1;
      return null;
    },
  };

  assert.equal(
    await getSavedArticleNarrationArtifact("missing", "reader@example.com", {
      articleRepository: { async findById() { return null; } },
      artifactStorage,
    }),
    null,
  );
  assert.equal(
    await getSavedArticleNarrationArtifact("plain", "reader@example.com", {
      articleRepository: {
        async findById() {
          return { ...articleFixture(), narration: undefined };
        },
      },
      artifactStorage,
    }),
    null,
  );
  assert.equal(artifactReads, 0);
});

test("rejects non-audio narration artifacts", async () => {
  const result = await getSavedArticleNarrationArtifact(
    "narrated",
    "reader@example.com",
    {
      articleRepository: { async findById() { return articleFixture(); } },
      artifactStorage: {
        async get() {
          return {
            key: "articles/narrated/audio/body.mp3",
            body: Buffer.from("not audio"),
            contentType: "text/plain",
            byteLength: 9,
          };
        },
      },
    },
  );

  assert.equal(result, null);
});

test("serves full and ranged narration responses", async () => {
  const artifact = {
    key: "articles/narrated/audio/body.mp3",
    body: Buffer.from("0123456789"),
    contentType: "audio/mpeg",
    byteLength: 10,
  };
  const full = articleNarrationResponse(artifact, null);
  const ranged = articleNarrationResponse(artifact, "bytes=2-5");
  const suffix = articleNarrationResponse(artifact, "bytes=-3");
  const invalid = articleNarrationResponse(artifact, "bytes=20-30");

  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-length"), "10");
  assert.equal(await full.text(), "0123456789");

  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(ranged.headers.get("content-length"), "4");
  assert.equal(await ranged.text(), "2345");

  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await suffix.text(), "789");

  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
});

test("keeps homophone substitutions mapped to timestamped characters", () => {
  const result = alignSourceCharacters(
    Array.from("甲乙丙丁"),
    Array.from("甲已丙丁"),
  );

  assert.deepEqual(result.sourceToTranscript, [0, 1, 2, 3]);
  assert.equal(result.mappedCount, 4);
  assert.equal(result.exactMatchCount, 3);
  assert.equal(result.maxUnmatchedSourceRun, 0);
  assert.equal(result.maxUnmatchedTranscriptRun, 0);
});

test("detects a hallucinated transcript span even when source coverage is complete", () => {
  const result = alignSourceCharacters(
    Array.from("甲乙甲乙"),
    Array.from("甲乙多余五个字甲乙"),
  );

  assert.equal(result.mappedCount, 4);
  assert.equal(result.maxUnmatchedSourceRun, 0);
  assert.ok(result.maxUnmatchedTranscriptRun > 4);
});

test("builds exact cues for the 19 narrated body sentences", () => {
  const article = pilotAlignmentArticleFixture();
  const transcription = timestampTranscription(article, {
    replacements: new Map([
      ["慈", "词"],
      ["锋", "风"],
    ]),
  });
  const alignment = buildNarrationAlignment(
    article,
    transcription,
    142.104,
  );

  assert.equal(alignment.model, "whisper-1");
  assert.equal(alignment.sourceCoverage, 1);
  assert.ok(alignment.exactMatchRatio > 0.99);
  assert.equal(alignment.sentenceCues.length, 20);
  assert.deepEqual(
    alignment.sentenceCues.slice(1).map(({ sentenceIndex }) => sentenceIndex),
    [6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 21, 22, 23, 25, 27, 28, 29, 30],
  );
  assert.ok(
    alignment.sentenceCues.find(({ sentenceIndex }) => sentenceIndex === 29)
      .startSeconds -
      alignment.sentenceCues.find(({ sentenceIndex }) => sentenceIndex === 6)
        .startSeconds >
      30,
  );
  assert.ok(
    alignment.sentenceCues.at(-1).endSeconds > 137,
  );
});

test("transcribes and atomically attaches timestamps to the existing audio", async () => {
  const article = pilotAlignmentArticleFixture();
  const transcription = timestampTranscription(article);
  const calls = [];
  const result = await alignPilotArticleNarration(
    article.id,
    "cmsflash99@gmail.com",
    {
      articleRepository: {
        async findById() {
          return article;
        },
        async addProcessingCost() {
          throw new Error("successful alignment records cost with its update");
        },
        async updateNarration(id, ownerEmail, narration, costUsd) {
          calls.push(["update", id, ownerEmail, costUsd]);
          return { ...article, narration };
        },
      },
      artifactStorage: {
        async get(key, visibility) {
          calls.push(["get", key, visibility]);
          return {
            key,
            contentType: "audio/mpeg",
            byteLength: article.narration.byteLength,
            body: Buffer.alloc(article.narration.byteLength),
          };
        },
      },
      apiKey: "test-key",
      async fetch(url, init) {
        calls.push([
          "transcribe",
          init.body.get("model"),
          init.body.get("response_format"),
          init.body.getAll("timestamp_granularities[]"),
        ]);
        assert.match(url, /\/audio\/transcriptions$/u);
        return Response.json(transcription);
      },
    },
  );

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.alignment.sentenceCues.length, 20);
  assert.equal(result.estimatedCostUsd, 0.01421);
  assert.deepEqual(calls[0].slice(0, 3), [
    "get",
    article.narration.artifactKey,
    "public",
  ]);
  assert.deepEqual(calls[1], [
    "transcribe",
    "whisper-1",
    "verbose_json",
    ["word"],
  ]);
  assert.deepEqual(calls[2], [
    "update",
    article.id,
    "cmsflash99@gmail.com",
    0.01421,
  ]);
});

test("reuses a valid existing alignment without another paid transcription", async () => {
  const article = pilotAlignmentArticleFixture();
  const alignment = buildNarrationAlignment(
    article,
    timestampTranscription(article),
    142.104,
  );
  const alignedArticle = {
    ...article,
    narration: { ...article.narration, alignment },
  };
  const result = await alignPilotArticleNarration(
    article.id,
    "cmsflash99@gmail.com",
    {
      articleRepository: {
        async findById() {
          return alignedArticle;
        },
        async addProcessingCost() {
          throw new Error("existing timestamps must not add cost");
        },
        async updateNarration() {
          throw new Error("existing timestamps must not be rewritten");
        },
      },
      artifactStorage: {
        async get() {
          throw new Error("existing timestamps must not reload audio");
        },
      },
      async fetch() {
        throw new Error("existing timestamps must not call OpenAI");
      },
      apiKey: "test-key",
    },
  );

  assert.equal(result.alreadyExisted, true);
  assert.equal(result.alignment, alignment);
  assert.equal(result.estimatedCostUsd, undefined);
});

function articleFixture() {
  const timestamp = "2026-08-18T04:00:00.000Z";

  return {
    id: "narrated",
    title: "Narrated article",
    sourceType: "text",
    createdAt: timestamp,
    updatedAt: timestamp,
    wordCount: 2,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: timestamp,
    },
    contentHtml: "<p>Narrated article</p>",
    textContent: "Narrated article",
    blocks: [
      {
        id: "paragraph-0",
        type: "paragraph",
        text: "Narrated article",
      },
    ],
    narration: {
      artifactKey: "articles/narrated/audio/body.mp3",
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 5,
      sourceTextSha256: "c".repeat(64),
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      generatedAt: timestamp,
    },
  };
}

function pilotArticleFixture() {
  return {
    id: "black-myth-journal-5df74e22bc38174a8a99c9b2",
    title: "黑风山土地",
    textContent: pilotBody,
    processingCostUsd: 0,
  };
}

function pilotAlignmentArticleFixture() {
  const timestamp = "2026-08-18T05:27:32.281Z";
  const bodyBlocks = pilotBody.split("\n\n").map((text, index) => ({
    id: `paragraph-${index + 1}`,
    type: "paragraph",
    text,
  }));

  return {
    id: "black-myth-journal-5df74e22bc38174a8a99c9b2",
    title: "黑风山土地",
    sourceType: "url",
    createdAt: timestamp,
    updatedAt: timestamp,
    wordCount: 631,
    estimatedMinutes: 3,
    sentenceCount: 31,
    processingCostUsd: 0.098253,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: timestamp,
    },
    contentHtml: "",
    textContent: pilotBody,
    blocks: [
      {
        id: "image-1",
        type: "image",
        alt: "黑风山土地 实机图",
        caption: "实机图",
      },
      {
        id: "image-2",
        type: "image",
        alt: "黑风山土地 影神图",
        caption: "影神图",
      },
      {
        id: "image-3",
        type: "image",
        alt: "黑风山土地 原画",
        caption: "原画",
      },
      ...bodyBlocks,
    ],
    narration: {
      artifactKey: "articles/black-myth/audio/pilot.mp3",
      artifactVisibility: "public",
      contentType: "audio/mpeg",
      byteLength: 2_273_664,
      sourceTextSha256: narrationSourceSha256("黑风山土地", pilotBody),
      model: "gpt-4o-mini-tts-2025-12-15",
      voice: "cedar",
      generatedAt: timestamp,
      durationSeconds: 142.104,
    },
  };
}

function timestampTranscription(article, options = {}) {
  const source = Array.from(
    comparableNarrationText(
      canonicalNarrationSource(article.title, article.textContent),
    ),
  );
  const characters = source.map(
    (character) => options.replacements?.get(character) ?? character,
  );
  const words = characters.map((word, index) => ({
    word,
    start: 0.2 + index * 0.27,
    end: 0.2 + (index + 1) * 0.27,
  }));

  return {
    text: characters.join(""),
    duration: 142.104,
    words,
  };
}

function narrationStorage(calls) {
  return {
    async put(input) {
      calls.push(["put", input.key]);
      return {
        key: input.key,
        contentType: input.contentType,
        byteLength: input.body.byteLength,
      };
    },
    async delete(key) {
      calls.push(["delete", key]);
    },
  };
}

function narrationFetch(calls, transcripts) {
  const audio = Buffer.alloc(16_000);
  audio.writeUInt32BE(0xfffb9000, 0);

  return async (url, init) => {
    if (url.endsWith("/audio/speech")) {
      const request = JSON.parse(init.body);
      calls.push(["speech", request]);
      assert.match(request.instructions, /即使内容重复/u);
      return new Response(new Uint8Array(audio), {
        headers: { "content-type": "audio/mpeg" },
      });
    }

    if (url.endsWith("/audio/transcriptions")) {
      const model = init.body.get("model");
      calls.push(["transcribe", model]);
      const text =
        model === "gpt-transcribe"
          ? transcripts.primaryTranscript
          : transcripts.diagnosticTranscript ?? transcripts.primaryTranscript;
      return Response.json({ text });
    }

    throw new Error(`Unexpected narration request: ${url}`);
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
