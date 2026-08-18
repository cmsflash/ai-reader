import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNarrationSource,
  evaluateNarrationTranscript,
  narrationSourceSha256,
  normalizeNarrationInput,
} from "../src/server/articles/articleNarrationQa.ts";

const title = "黑风山土地";
const body = [
  "慈眉掩善光，善目遮锋芒。",
  "妙法助英豪，良心因果长。",
  "土地公问道：“小仙能帮些什么？敢问道长，仙居何处？”",
  "慈眉掩善光，善目遮锋芒。",
  "妙法助英豪，良心因果长。",
].join("\n\n");

test("builds a stable title-and-body fingerprint", () => {
  assert.equal(canonicalNarrationSource(title, body), `${title}\n\n${body}`);
  assert.equal(narrationSourceSha256(title, body).length, 64);
  assert.notEqual(
    narrationSourceSha256(title, body),
    narrationSourceSha256(`${title}改`, body),
  );
});

test("removes quote glyphs from speech input without removing dialogue", () => {
  const normalized = normalizeNarrationInput(
    "他说：“你好……”\n\n『再见』",
  );

  assert.equal(normalized, "他说:你好。\n\n再见");
  assert.doesNotMatch(normalized, /[“”‘’「」『』…]/u);
});

test("accepts a complete ordered narration transcript", () => {
  const source = canonicalNarrationSource(title, body);
  const qa = evaluateNarrationTranscript(source, source);

  assert.equal(qa.ok, true);
  assert.equal(qa.characterErrorRate, 0);
  assert.equal(qa.orderedCoverage, 1);
  assert.equal(qa.maxContiguousSourceDeletion, 0);
  assert.deepEqual(qa.repeatedCoupletCounts, [2, 2]);
});

test("rejects skipped passages and spoken quote-marker words", () => {
  const source = canonicalNarrationSource(title, body);
  const skipped = evaluateNarrationTranscript(
    source,
    `${title}。慈眉掩善光，善目遮锋芒。妙法助英豪，良心因果长。右手 quotation mark。`,
  );

  assert.equal(skipped.ok, false);
  assert.ok(skipped.maxContiguousSourceDeletion > 10);
  assert.ok(skipped.forbiddenQuoteMarkers.includes("quotation"));
  assert.ok(skipped.failures.length >= 2);
});

test("rejects one skipped short sentence inside an otherwise exact passage", () => {
  const source = canonicalNarrationSource(title, body);
  const skipped = evaluateNarrationTranscript(
    source,
    source.replace("小仙能帮些什么？", ""),
  );

  assert.equal(skipped.ok, false);
  assert.ok(skipped.maxContiguousSourceDeletion >= 7);
  assert.match(skipped.failures.join(" "), /contiguous source span/u);
});
