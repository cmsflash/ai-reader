import assert from "node:assert/strict";
import test from "node:test";
import { sentenceHighlightState } from "../src/lib/sentenceHighlight.ts";

test("highlights only playing and explicitly right-clicked sentences", () => {
  assert.equal(sentenceHighlightState(4, null, null), null);
  assert.equal(sentenceHighlightState(4, 4, null), "playing");
  assert.equal(sentenceHighlightState(3, 4, null), null);
  assert.equal(sentenceHighlightState(4, null, 4), "context-selected");
  assert.equal(sentenceHighlightState(3, 4, 3), "context-selected");
  assert.equal(sentenceHighlightState(4, 4, 4), "playing");
});
