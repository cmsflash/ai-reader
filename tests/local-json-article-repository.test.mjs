import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalJsonArticleRepository } from "../src/server/adapters/localJsonArticleRepository.ts";

test("serializes concurrent creates without losing either article", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await Promise.all([
      repository.create(article("first"), "reader@example.com"),
      repository.create(article("second"), "reader@example.com"),
    ]);

    const articles = await repository.list("reader@example.com");
    assert.deepEqual(
      new Set(articles.map((candidate) => candidate.id)),
      new Set(["first", "second"]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns the stored article when a deterministic ID is retried", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    const original = article("stable");
    const saved = await repository.create(original, "reader@example.com");
    const retried = await repository.create(
      { ...original, title: "Retry should not replace state" },
      "reader@example.com",
    );

    assert.equal(saved.title, "Article stable");
    assert.equal(retried.title, "Article stable");
    assert.equal(
      (await repository.list("reader@example.com")).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function article(id) {
  const timestamp = "2026-07-27T12:00:00.000Z";

  return {
    id,
    title: `Article ${id}`,
    sourceType: "text",
    createdAt: timestamp,
    updatedAt: timestamp,
    wordCount: 1,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: timestamp,
    },
    contentHtml: `<p>${id}</p>`,
    textContent: id,
    blocks: [
      {
        id: "paragraph-0",
        type: "paragraph",
        text: id,
      },
    ],
  };
}
