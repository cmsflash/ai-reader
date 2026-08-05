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

const { archiveArticleArtifacts } = await import(
  "../src/server/artifacts/archiveArticleArtifacts.ts"
);
const { normalizedImageContentType } = await import(
  "../src/server/artifacts/imageRequests.ts"
);

test("accepts extension-backed images served as generic binary data", () => {
  assert.equal(
    normalizedImageContentType(
      "application/octet-stream",
      new URL("https://cdn.example.com/preview.format-webp.webp"),
    ),
    "image/webp",
  );
  assert.equal(
    normalizedImageContentType(
      "application/octet-stream",
      new URL("https://cdn.example.com/not-an-image.bin"),
    ),
    null,
  );
});

test("stops best-effort image archiving at the article time budget", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;

  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;

      if (signal?.aborted) {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });

  const article = articleFixture();

  try {
    const archived = await archiveArticleArtifacts(article, {
      timeoutMs: 5,
    });

    assert.equal(aborted, true);
    assert.deepEqual(archived, article);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function articleFixture() {
  const timestamp = "2026-07-30T00:00:00.000Z";

  return {
    id: "article-with-slow-image",
    title: "Article with slow image",
    sourceType: "url",
    sourceUrl: "https://93.184.216.34/article",
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
    contentHtml: '<img src="https://93.184.216.34/image.png">',
    textContent: "Example article.",
    blocks: [
      {
        id: "image-1",
        type: "image",
        alt: "Slow",
        src: "https://93.184.216.34/image.png",
      },
    ],
  };
}

function resolveSourceFile(basePath) {
  const candidates = path.extname(basePath)
    ? [basePath]
    : [`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.js`, `${basePath}.mjs`];

  return candidates.find((candidate) => fs.existsSync(candidate));
}
