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
const { mp3DurationSeconds, verifyPilotNarrationModelAccess } = await import(
  "../src/server/articles/articleNarrationPilot.ts"
);

test("checks the pinned narration model without generating audio", async () => {
  const requests = [];
  const result = await verifyPilotNarrationModelAccess(
    "black-myth-journal-5df74e22bc38174a8a99c9b2",
    "cmsflash99@gmail.com",
    {
      apiKey: "test-openai-key",
      async fetch(url, init) {
        requests.push({ url, init });
        return Response.json({ id: "gpt-4o-mini-tts-2025-12-15" });
      },
    },
  );

  assert.equal(result.model, "gpt-4o-mini-tts-2025-12-15");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/models\/gpt-4o-mini-tts-2025-12-15$/u);
  assert.equal(requests[0].init.headers.authorization, "Bearer test-openai-key");
  assert.equal(requests[0].init.method, undefined);
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
