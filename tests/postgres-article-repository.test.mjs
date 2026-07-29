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

const { PostgresArticleRepository } = await import(
  "../src/server/adapters/postgresArticleRepository.ts"
);

test("library listing selects and returns summary fields only", async () => {
  const queries = [];
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      queries.push({ statement, params });
      return [
        {
          id: "article-1",
          title: "A compact summary",
          source_type: "url",
          source_url: "https://example.com/read",
          created_at: "2026-07-29T08:00:00.000Z",
          updated_at: "2026-07-29T09:00:00.000Z",
          word_count: "420",
          estimated_minutes: 2,
          sentence_count: "18",
          processing_cost_usd: "0.125",
          progress_sentence_index: "4",
          progress_percent: "0.25",
          progress_updated_at: "2026-07-29T09:00:00.000Z",
        },
      ];
    },
  });

  const summaries = await repository.list(" Reader@Example.com ");
  const normalizedQuery = normalizeQuery(queries[0].statement);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ["reader@example.com"]);
  assert.doesNotMatch(normalizedQuery, /\bcontent_html\b/);
  assert.doesNotMatch(normalizedQuery, /\btext_content\b/);
  assert.doesNotMatch(normalizedQuery, /\bblocks\b/);
  assert.deepEqual(summaries, [
    {
      id: "article-1",
      title: "A compact summary",
      sourceType: "url",
      sourceUrl: "https://example.com/read",
      createdAt: "2026-07-29T08:00:00.000Z",
      updatedAt: "2026-07-29T09:00:00.000Z",
      wordCount: 420,
      estimatedMinutes: 2,
      sentenceCount: 18,
      processingCostUsd: 0.125,
      progress: {
        sentenceIndex: 4,
        percent: 0.25,
        updatedAt: "2026-07-29T09:00:00.000Z",
      },
    },
  ]);
});

test("deduplication listing transfers only fields used by the matcher", async () => {
  const queries = [];
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      queries.push({ statement, params });
      return [
        {
          id: "canonical",
          title: "Canonical article",
          source_url: null,
          text_content:
            "This compact row has enough normalized text for exact matching.",
        },
      ];
    },
  });

  const candidates = await repository.listDeduplicationCandidates(
    "reader@example.com",
  );
  const normalizedQuery = normalizeQuery(queries[0].statement);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ["reader@example.com"]);
  assert.match(normalizedQuery, /\btext_content\b/);
  assert.doesNotMatch(normalizedQuery, /\bcontent_html\b/);
  assert.doesNotMatch(normalizedQuery, /\bblocks\b/);
  assert.doesNotMatch(normalizedQuery, /\bprogress_percent\b/);
  assert.deepEqual(candidates, [
    {
      id: "canonical",
      title: "Canonical article",
      sourceUrl: undefined,
      textContent:
        "This compact row has enough normalized text for exact matching.",
    },
  ]);
});

function normalizeQuery(statement) {
  return statement.replace(/\s+/g, " ").trim();
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
