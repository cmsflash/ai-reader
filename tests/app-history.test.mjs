import assert from "node:assert/strict";
import test from "node:test";
import {
  appHistoryEntry,
  appUrlForHistoryEntry,
  articleIdFromAppUrl,
} from "../src/lib/appHistory.ts";

test("reader history URLs carry the selected article and preserve other URL parts", () => {
  assert.equal(
    appUrlForHistoryEntry(
      "https://ai-reader.example/?source=review#reader",
      { view: "reader", articleId: "article / 1", depth: 1 },
    ),
    "/?source=review&article=article+%2F+1#reader",
  );
});

test("non-reader history URLs remove only the article parameter", () => {
  assert.equal(
    appUrlForHistoryEntry(
      "https://ai-reader.example/library?article=old&source=review#top",
      { view: "library", depth: 0 },
    ),
    "/library?source=review#top",
  );
});

test("article deep links accept a nonempty decoded id", () => {
  assert.equal(
    articleIdFromAppUrl("https://ai-reader.example/?article=review%2Fa"),
    "review/a",
  );
  assert.equal(articleIdFromAppUrl("/?article=%20"), null);
  assert.equal(articleIdFromAppUrl(`/?article=${"x".repeat(513)}`), null);
  assert.equal(articleIdFromAppUrl("not a valid url%"), null);
});

test("history state validation accepts readers and rejects incomplete readers", () => {
  assert.deepEqual(
    appHistoryEntry({
      unrelated: true,
      aiReader: { view: "reader", articleId: "article-1", depth: 2 },
    }),
    { view: "reader", articleId: "article-1", depth: 2 },
  );
  assert.equal(
    appHistoryEntry({ aiReader: { view: "reader", depth: 1 } }),
    null,
  );
  assert.equal(
    appHistoryEntry({ aiReader: { view: "reader", articleId: 42, depth: 1 } }),
    null,
  );
  assert.equal(
    appHistoryEntry({ aiReader: { view: "library", depth: -1 } }),
    null,
  );
});
