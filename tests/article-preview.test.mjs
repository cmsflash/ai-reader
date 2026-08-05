import assert from "node:assert/strict";
import test from "node:test";
import { articleExcerpt } from "../src/lib/articlePreview.ts";

test("uses an article lead instead of a byline or author biography", () => {
  const excerpt = articleExcerpt({
    title: "A new machine-learning approach",
    textContent: "",
    blocks: [
      { type: "paragraph", text: "November 7, 2025" },
      {
        type: "paragraph",
        text: "Ali Example, Student Researcher, and Vahab Example, VP and Fellow, Example Research",
      },
      {
        type: "paragraph",
        text: "Ali Example is the Chief Research Officer. Prior to Example Research, he led another laboratory.",
      },
      {
        type: "paragraph",
        text: "Ali received his Ph.D. in computer science from Example University before beginning his research career.",
      },
      {
        type: "paragraph",
        text: "We introduce a new approach that treats a model as several nested optimization problems so it can keep learning without forgetting earlier skills.",
      },
    ],
  });

  assert.equal(
    excerpt,
    "We introduce a new approach that treats a model as several nested optimization problems so it can keep learning without forgetting earlier skills.",
  );
});
