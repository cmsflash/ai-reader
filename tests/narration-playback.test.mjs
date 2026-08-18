import assert from "node:assert/strict";
import test from "node:test";
import {
  articleNarrationAudioUrl,
  narrationProgressForSentenceIndex,
  narrationSentenceIndexAtProgress,
} from "../src/lib/narrationPlayback.ts";

test("builds an owner-checked article narration URL", () => {
  assert.equal(
    articleNarrationAudioUrl("article/with spaces"),
    "/api/articles/article%2Fwith%20spaces/audio",
  );
});

test("maps whole-file playback to sentences by spoken character weight", () => {
  const sentences = [
    { sentenceIndex: 4, text: "短句。" },
    { sentenceIndex: 5, text: "这一个句子明显更长。" },
    { sentenceIndex: 6, text: "结尾。" },
  ];

  assert.equal(narrationSentenceIndexAtProgress(sentences, 0), 4);
  assert.equal(narrationSentenceIndexAtProgress(sentences, 0.2), 5);
  assert.equal(narrationSentenceIndexAtProgress(sentences, 0.8), 5);
  assert.equal(narrationSentenceIndexAtProgress(sentences, 1), 6);
});

test("clamps narration progress and tolerates punctuation-only segments", () => {
  const sentences = [
    { sentenceIndex: 10, text: "……" },
    { sentenceIndex: 11, text: "正文" },
  ];

  assert.equal(narrationSentenceIndexAtProgress(sentences, -1), 10);
  assert.equal(narrationSentenceIndexAtProgress(sentences, 2), 11);
  assert.equal(narrationSentenceIndexAtProgress([], 0.5), 0);
});

test("maps an explicit sentence tap back to an approximate audio position", () => {
  const sentences = [
    { sentenceIndex: 4, text: "短句。" },
    { sentenceIndex: 5, text: "这一个句子明显更长。" },
    { sentenceIndex: 6, text: "结尾。" },
  ];

  assert.equal(narrationProgressForSentenceIndex(sentences, 4), 0);
  assert.equal(narrationProgressForSentenceIndex(sentences, 5), 2 / 13);
  assert.equal(narrationProgressForSentenceIndex(sentences, 99), 11 / 13);
});
