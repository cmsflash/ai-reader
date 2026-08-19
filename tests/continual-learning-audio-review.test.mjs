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
    return resolvedPath
      ? { url: pathToFileURL(resolvedPath).href, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const {
  continualLearningAudioReviewCurrentArticleId,
  continualLearningAudioReviewSentenceArticleId,
  wavDurationSeconds,
} = await import(
  "../src/server/articles/continualLearningAudioReview.ts"
);
const { continualLearningRecoveredCues } = await import(
  "../src/server/articles/continualLearningAudioReviewFixture.ts"
);
const { generateContinualLearningSentenceAudioStep } = await import(
  "../src/workflows/narrationReview/steps.ts"
);

test("the retained review fixture has 52 ordered cues and intentionally skips only the bullet", () => {
  assert.equal(continualLearningRecoveredCues.length, 52);
  assert.deepEqual(
    continualLearningRecoveredCues.slice(0, 3).map(({ sentenceIndex }) => sentenceIndex),
    [0, 1, 3],
  );
  assert.equal(continualLearningRecoveredCues.at(-1)?.sentenceIndex, 52);

  for (let index = 1; index < continualLearningRecoveredCues.length; index += 1) {
    assert.ok(
      continualLearningRecoveredCues[index].startSeconds >
        continualLearningRecoveredCues[index - 1].startSeconds,
    );
  }
});

test("sentence review audio uses distinct stable article ids", () => {
  assert.notEqual(
    continualLearningAudioReviewCurrentArticleId,
    continualLearningAudioReviewSentenceArticleId,
  );
  assert.match(continualLearningAudioReviewCurrentArticleId, /^review-/u);
  assert.match(continualLearningAudioReviewSentenceArticleId, /^review-/u);
});

test("WAV duration is derived from sample bytes and byte rate", () => {
  const byteRate = 48_000;
  const dataBytes = 96_000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  assert.equal(wavDurationSeconds(wav), 2);
  assert.throws(() => wavDurationSeconds(Buffer.alloc(44)), /invalid WAV/u);
});

test("WAV duration accepts a streaming data-length sentinel", () => {
  const byteRate = 48_000;
  const dataBytes = 96_000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(0xffffffff, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(0xffffffff, 40);

  assert.equal(wavDurationSeconds(wav), 2);

  const misalignedStream = wav.subarray(0, wav.byteLength - 1);
  assert.throws(
    () => wavDurationSeconds(misalignedStream),
    /without sample data/u,
  );

  const truncatedDeclaredChunk = Buffer.from(wav);
  truncatedDeclaredChunk.writeUInt32LE(dataBytes + 2, 40);
  assert.throws(
    () => wavDurationSeconds(truncatedDeclaredChunk),
    /truncated WAV/u,
  );
});

test("the paid sentence generation step never retries automatically", () => {
  assert.equal(generateContinualLearningSentenceAudioStep.maxRetries, 0);
});

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
