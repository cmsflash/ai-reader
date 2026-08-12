import assert from "node:assert/strict";
import test from "node:test";
import {
  articleMatchesLocation,
  filterAndSortArticles,
} from "../src/lib/articleList.ts";
import {
  ArticleListCursorError,
  decodeArticleListCursor,
  encodeArticleListCursor,
} from "../src/server/articles/articleListCursor.ts";

test("filters every library location and preserves archive separation", () => {
  const articles = [
    summary("default", { folderId: "folder-default" }),
    summary("research", { folderId: "folder-research" }),
    summary("archived", {
      folderId: "folder-research",
      archivedAt: "2026-08-11T04:00:00.000Z",
    }),
  ];

  assert.equal(
    articleMatchesLocation(articles[0], "default", "folder-default"),
    true,
  );
  assert.deepEqual(
    filterAndSortArticles(
      articles,
      "folder:folder-research",
      "saved-desc",
      "folder-default",
    ).map(({ id }) => id),
    ["research"],
  );
  assert.deepEqual(
    filterAndSortArticles(
      articles,
      "all",
      "saved-desc",
      "folder-default",
    ).map(({ id }) => id),
    ["default", "research"],
  );
  assert.deepEqual(
    filterAndSortArticles(
      articles,
      "archive",
      "saved-desc",
      "folder-default",
    ).map(({ id }) => id),
    ["archived"],
  );
});

test("implements all six list sorts with a deterministic ID tie-breaker", () => {
  const articles = [
    summary("a", {
      title: "Beta",
      createdAt: "2026-08-03T00:00:00.000Z",
      progressUpdatedAt: "2026-08-05T00:00:00.000Z",
      estimatedMinutes: 5,
    }),
    summary("b", {
      title: "Alpha",
      createdAt: "2026-08-03T00:00:00.000Z",
      progressUpdatedAt: "2026-08-04T00:00:00.000Z",
      estimatedMinutes: 2,
    }),
    summary("c", {
      title: "Alpha",
      createdAt: "2026-08-02T00:00:00.000Z",
      progressUpdatedAt: "2026-08-06T00:00:00.000Z",
      estimatedMinutes: 2,
    }),
    summary("z", {
      title: "Alpha",
      createdAt: "2026-08-03T00:00:00.000Z",
      progressUpdatedAt: "2026-08-04T00:00:00.000Z",
      estimatedMinutes: 2,
    }),
  ];
  const ids = (sort) =>
    filterAndSortArticles(articles, "all", sort).map(({ id }) => id);

  assert.deepEqual(ids("saved-desc"), ["b", "z", "a", "c"]);
  assert.deepEqual(ids("saved-asc"), ["c", "b", "z", "a"]);
  assert.deepEqual(ids("read-desc"), ["c", "a", "b", "z"]);
  assert.deepEqual(ids("title-asc"), ["b", "z", "c", "a"]);
  assert.deepEqual(ids("duration-asc"), ["b", "z", "c", "a"]);
  assert.deepEqual(ids("duration-desc"), ["a", "b", "z", "c"]);
});

test("article list cursors are versioned, opaque, and bound to the query", () => {
  const query = { location: "default", sort: "saved-desc", limit: 30 };
  const cursor = encodeArticleListCursor(query, 30);

  assert.doesNotMatch(cursor, /default|saved-desc/u);
  assert.equal(decodeArticleListCursor(cursor, query), 30);
  assert.throws(
    () =>
      decodeArticleListCursor(cursor, {
        ...query,
        location: "archive",
      }),
    ArticleListCursorError,
  );
  assert.throws(
    () =>
      decodeArticleListCursor(cursor, {
        ...query,
        limit: 60,
      }),
    ArticleListCursorError,
  );

  const unsupportedVersion = Buffer.from(
    JSON.stringify({ ...query, v: 2, offset: 30 }),
  ).toString("base64url");
  assert.throws(
    () => decodeArticleListCursor(unsupportedVersion, query),
    ArticleListCursorError,
  );
  assert.throws(
    () => decodeArticleListCursor("not/a/cursor", query),
    ArticleListCursorError,
  );
});

function summary(id, overrides = {}) {
  const createdAt = overrides.createdAt ?? "2026-08-03T00:00:00.000Z";

  return {
    id,
    title: overrides.title ?? `Article ${id}`,
    sourceType: "text",
    folderId: overrides.folderId,
    archivedAt: overrides.archivedAt,
    createdAt,
    updatedAt: createdAt,
    wordCount: 100,
    estimatedMinutes: overrides.estimatedMinutes ?? 1,
    sentenceCount: 5,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: overrides.progressUpdatedAt ?? createdAt,
    },
  };
}
