import assert from "node:assert/strict";
import test from "node:test";
import {
  articleNarrationAudioUrl,
  narrationProgressForSentenceIndex,
  matchingNarrationCues,
  narrationSentenceMapFingerprint,
  narrationSentenceIndexAtProgress,
  narrationSentenceIndexAtTime,
  narrationTimeForSentenceIndex,
  narrationTitleSentenceIndex,
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

test("uses exact narration cues for title and sentence highlighting", () => {
  const cues = [
    {
      sentenceIndex: narrationTitleSentenceIndex,
      sentenceText: "Title",
      startSeconds: 0.4,
      endSeconds: 2.1,
    },
    { sentenceIndex: 6, sentenceText: "First", startSeconds: 2.4, endSeconds: 5.8 },
    { sentenceIndex: 8, sentenceText: "Second", startSeconds: 6.2, endSeconds: 9.1 },
  ];

  assert.equal(narrationSentenceIndexAtTime(cues, 0), narrationTitleSentenceIndex);
  assert.equal(narrationSentenceIndexAtTime(cues, 2.39), narrationTitleSentenceIndex);
  assert.equal(narrationSentenceIndexAtTime(cues, 2.4), 6);
  assert.equal(narrationSentenceIndexAtTime(cues, 99), 8);
});

test("seeks to exact cues and skips UI-only sentence indexes", () => {
  const cues = [
    {
      sentenceIndex: narrationTitleSentenceIndex,
      sentenceText: "Title",
      startSeconds: 0.4,
      endSeconds: 2.1,
    },
    { sentenceIndex: 6, sentenceText: "First", startSeconds: 2.4, endSeconds: 5.8 },
    { sentenceIndex: 8, sentenceText: "Second", startSeconds: 6.2, endSeconds: 9.1 },
  ];

  assert.equal(narrationTimeForSentenceIndex(cues, 6), 2.4);
  assert.equal(narrationTimeForSentenceIndex(cues, 7), 6.2);
  assert.equal(narrationTimeForSentenceIndex(cues, 99), 6.2);
  assert.equal(narrationTimeForSentenceIndex(undefined, 6), null);
  assert.equal(narrationSentenceIndexAtTime([], 3), null);
});

test("uses cues only when their sentence map and text still match", () => {
  const sentences = [
    { sentenceIndex: 6, text: "第一句。" },
    { sentenceIndex: 8, text: "第二句。" },
  ];
  const alignment = {
    version: 1,
    model: "whisper-1",
    generatedAt: "2026-08-18T00:00:00.000Z",
    transcriptSha256: "a".repeat(64),
    sentenceMapFingerprint: narrationSentenceMapFingerprint(sentences),
    sourceCoverage: 1,
    exactMatchRatio: 1,
    maxUnmatchedSourceRun: 0,
    maxUnmatchedTranscriptRun: 0,
    sentenceCues: [
      {
        sentenceIndex: narrationTitleSentenceIndex,
        sentenceText: "标题",
        startSeconds: 0.2,
        endSeconds: 1.8,
      },
      {
        sentenceIndex: 6,
        sentenceText: "第一句。",
        startSeconds: 2,
        endSeconds: 4,
      },
      {
        sentenceIndex: 8,
        sentenceText: "第二句。",
        startSeconds: 4.2,
        endSeconds: 6,
      },
    ],
  };

  assert.equal(
    matchingNarrationCues(alignment, sentences, "标题", 6)?.length,
    3,
  );
  assert.equal(
    matchingNarrationCues(
      {
        ...alignment,
        sentenceCues: alignment.sentenceCues.map((cue) =>
          cue.sentenceIndex === 6 ? { ...cue, sentenceText: "stale" } : cue,
        ),
      },
      sentences,
      "标题",
      6,
    ),
    undefined,
  );
  assert.equal(
    matchingNarrationCues(
      alignment,
      [{ sentenceIndex: 6, text: "第一句。" }],
      "标题",
      6,
    ),
    undefined,
  );
});
