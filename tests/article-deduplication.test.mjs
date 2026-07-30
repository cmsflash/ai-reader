import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_CONTENT_FINGERPRINT_VERSION,
  ArticleDeduplicationIndex,
  articleContentFingerprint,
  canonicalizeArticleUrl,
  normalizeArticleContent,
} from "../src/server/articles/articleDeduplication.ts";
import {
  fingerprintArticleContentForMigration,
  normalizeArticleContentForFingerprint,
} from "../scripts/migrate-postgres.mjs";

test("canonicalizes equivalent article URLs without tracking parameters", () => {
  assert.equal(
    canonicalizeArticleUrl(
      "http://www.Example.com/story/?utm_source=newsletter&b=2&a=1#section",
    ),
    "http://www.example.com/story?a=1&b=2",
  );
  assert.equal(canonicalizeArticleUrl("file:///tmp/story"), undefined);
  assert.equal(
    canonicalizeArticleUrl(
      "https://newsletter.example.com/p/story?_bhlid=campaign&trackingId=reader&trk=feed&publication_id=7&post_id=8&isFreemail=false&r=abc&triedRedirect=true&utm_source=substack",
    ),
    "https://newsletter.example.com/p/story",
  );
  assert.equal(
    canonicalizeArticleUrl(
      "https://example.com/story?post_id=8&publication_id=7&r=article",
    ),
    "https://example.com/story?post_id=8&publication_id=7&r=article",
  );
});

test("deduplicates formatting variants by normalized article content", () => {
  const canonical = article({
    id: "canonical",
    title: "A careful explanation",
    textContent:
      "Reasoning systems combine evidence, constraints, and verification.",
  });
  const incoming = article({
    id: "incoming",
    title: "A careful explanation",
    textContent:
      "  REASONING systems combine evidence, constraints, and verification.  ",
  });
  const match = new ArticleDeduplicationIndex([canonical]).find(incoming);

  assert.equal(match?.article.id, "canonical");
  assert.equal(match?.reason, "exact-content");
  assert.equal(normalizeArticleContent("A\u00a0B"), "a b");
});

test("compact repository candidates preserve exact matching semantics", () => {
  const canonical = {
    id: "canonical",
    title: "A careful explanation",
    sourceUrl: "https://example.com/explanation",
    textContent:
      "Reasoning systems combine evidence, constraints, and verification.",
  };
  const incoming = article({
    id: "incoming",
    title: "A careful explanation",
    sourceUrl: "https://example.com/explanation",
    textContent:
      "  REASONING systems combine evidence, constraints, and verification.  ",
  });

  const match = new ArticleDeduplicationIndex([canonical]).find(incoming);

  assert.equal(match?.article.id, canonical.id);
  assert.equal(match?.reason, "exact-content");
});

test("chooses the same exact-content canonical as the historical backfill", () => {
  const sharedText =
    "A historical duplicate body that is long enough to receive a stable fingerprint.";
  const laterId = article({
    id: "z-provider-copy",
    title: "Later copy",
    textContent: sharedText,
  });
  const canonical = article({
    id: "a-provider-copy",
    title: "Canonical copy",
    textContent: sharedText,
  });
  const incoming = article({
    id: "new-provider-copy",
    title: "Incoming copy",
    textContent: sharedText,
  });

  assert.equal(
    new ArticleDeduplicationIndex([laterId, canonical]).find(incoming)?.article.id,
    canonical.id,
  );
});

test("exact fingerprints preserve semantic punctuation and operators", () => {
  const lessThan = article({
    id: "less-than",
    title: "Comparison",
    textContent:
      "The validation rule is x < y, and changing that operator changes the result.",
  });
  const greaterThan = article({
    id: "greater-than",
    title: "Comparison",
    textContent:
      "The validation rule is x > y, and changing that operator changes the result.",
  });

  assert.equal(
    new ArticleDeduplicationIndex([lessThan]).find(greaterThan),
    null,
  );
});

test("exact fingerprints are versioned and match the Postgres backfill", () => {
  const textContent =
    "  REASONING\u00a0systems combine evidence, constraints, and verification.  ";
  const fingerprint = articleContentFingerprint({ textContent });

  assert.match(
    fingerprint,
    new RegExp(`^${ARTICLE_CONTENT_FINGERPRINT_VERSION}:[a-f0-9]{64}$`),
  );
  assert.equal(
    fingerprintArticleContentForMigration(textContent),
    fingerprint,
  );
  assert.equal(
    normalizeArticleContentForFingerprint(textContent),
    normalizeArticleContent(textContent),
  );
  assert.equal(
    fingerprintArticleContentForMigration("too short"),
    undefined,
  );
});

test("deduplicates near-identical long articles but keeps related articles separate", () => {
  const sharedSections = Array.from(
    { length: 36 },
    (_, index) =>
      `Section ${index} explains how evidence ${index} is evaluated, checked against constraints, and summarized for a careful reader.`,
  );
  const canonical = article({
    id: "canonical",
    title: "Evaluation guide",
    textContent: sharedSections.join("\n\n"),
  });
  const nearDuplicate = article({
    id: "near",
    title: "Evaluation guide (saved copy)",
    textContent: sharedSections
      .map((section, index) =>
        index === 18
          ? section.replace("careful reader", "thoughtful reader")
          : section,
      )
      .join("\n"),
  });
  const different = article({
    id: "different",
    title: "Gardening guide",
    textContent: Array.from(
      { length: 36 },
      (_, index) =>
        `Chapter ${index} covers soil, irrigation, seasonal pruning, seed storage, and healthy garden planning for plot ${index}.`,
    ).join("\n"),
  });
  const index = new ArticleDeduplicationIndex([canonical]);

  assert.equal(index.find(nearDuplicate)?.reason, "near-identical-content");
  assert.equal(index.find(different), null);
});

test("source URLs corroborate extracted content across providers", () => {
  const sharedBody = Array.from(
    { length: 30 },
    (_, index) =>
      `Section ${index} explains the canonical article with evidence, constraints, and verification.`,
  ).join("\n");
  const canonical = article({
    id: "instapaper-article",
    title: "Shared article",
    sourceUrl: "https://example.com/read?id=7&utm_medium=reader",
    textContent: sharedBody,
  });
  const incoming = article({
    id: "dropbox-article",
    title: "Reader export",
    sourceUrl: "https://example.com/read?utm_source=dropbox&id=7#top",
    textContent: `${sharedBody}\nSaved from the reader application.`,
  });
  const match = new ArticleDeduplicationIndex([canonical]).find(incoming);

  assert.equal(match?.article.id, "instapaper-article");
  assert.equal(match?.reason, "near-identical-content");
});

test("a reused source URL does not hide materially changed content", () => {
  const canonical = article({
    id: "old-page",
    title: "Daily report",
    sourceUrl: "https://example.com/daily",
    textContent: Array.from(
      { length: 30 },
      (_, index) =>
        `Old report section ${index} covers rainfall, irrigation, soil health, and seed storage.`,
    ).join("\n"),
  });
  const changed = article({
    id: "new-page",
    title: "Daily report",
    sourceUrl: "https://example.com/daily",
    textContent: Array.from(
      { length: 30 },
      (_, index) =>
        `New report section ${index} covers compiler safety, memory ownership, type inference, and test isolation.`,
    ).join("\n"),
  });

  assert.equal(
    new ArticleDeduplicationIndex([canonical]).find(changed),
    null,
  );
});

test("same-source containment survives a large saved-page boilerplate tail", () => {
  const body = Array.from(
    { length: 80 },
    (_, index) =>
      `Section ${index} documents a distinct observation, supporting evidence, and the resulting conclusion for this report.`,
  ).join("\n");
  const canonical = article({
    id: "clean-reader-copy",
    title: "Long report",
    sourceUrl: "https://example.com/long-report",
    textContent: body,
  });
  const archived = article({
    id: "archive-with-chrome",
    title: "Long report",
    sourceUrl: "https://example.com/long-report?utm_source=reader",
    textContent: `${body}\n${Array.from(
      { length: 100 },
      (_, index) =>
        `Unrelated recommendation card ${index} promotes another story, newsletter, or navigation destination.`,
    ).join("\n")}`,
  });

  assert.ok(archived.textContent.length > canonical.textContent.length * 1.8);
  assert.equal(
    new ArticleDeduplicationIndex([canonical]).find(archived)?.reason,
    "near-identical-content",
  );
});

test("keeps generic source and ref query parameters as article identity", () => {
  assert.notEqual(
    canonicalizeArticleUrl("https://example.com/read?source=edition-a"),
    canonicalizeArticleUrl("https://example.com/read?source=edition-b"),
  );
  assert.notEqual(
    canonicalizeArticleUrl("https://example.com/read?ref=chapter-1"),
    canonicalizeArticleUrl("https://example.com/read?ref=chapter-2"),
  );
});

test("does not assume HTTP or www host variants are the same resource", () => {
  assert.notEqual(
    canonicalizeArticleUrl("http://example.com/read"),
    canonicalizeArticleUrl("https://example.com/read"),
  );
  assert.notEqual(
    canonicalizeArticleUrl("https://www.example.com/read"),
    canonicalizeArticleUrl("https://example.com/read"),
  );
});

test("near matching remains stable after a prefix insertion in a long document", () => {
  const body = Array.from(
    { length: 180 },
    (_, index) =>
      `Paragraph ${index} contains evidence, verification details, and a distinct observation numbered ${index}.`,
  ).join("\n");
  const canonical = article({
    id: "long-canonical",
    title: "Long report",
    textContent: body,
  });
  const shifted = article({
    id: "long-shifted",
    title: "Long report copy",
    textContent: `Saved reader copy.\n${body}`,
  });

  assert.equal(
    new ArticleDeduplicationIndex([canonical]).find(shifted)?.reason,
    "near-identical-content",
  );
});

test("near matching preserves semantic operators in long documents", () => {
  const lessThan = article({
    id: "less-than-guide",
    title: "Validation rules",
    textContent: Array.from(
      { length: 80 },
      (_, index) =>
        `Rule ${index}: accept the sample only when measured value ${index} < threshold ${index}; otherwise preserve the original state.`,
    ).join("\n"),
  });
  const greaterThan = article({
    id: "greater-than-guide",
    title: "Validation rules",
    textContent: Array.from(
      { length: 80 },
      (_, index) =>
        `Rule ${index}: accept the sample only when measured value ${index} > threshold ${index}; otherwise preserve the original state.`,
    ).join("\n"),
  });

  assert.ok(lessThan.textContent.length > 500);
  assert.equal(
    new ArticleDeduplicationIndex([lessThan]).find(greaterThan),
    null,
  );
});

test("replacement matching excludes the provider record's previous article", () => {
  const previous = article({
    id: "previous-provider-version",
    title: "Saved report",
    sourceUrl: "https://example.com/report",
    textContent: Array.from(
      { length: 40 },
      (_, index) =>
        `Section ${index} documents the previous provider version with evidence and verification details.`,
    ).join("\n"),
  });
  const replacement = article({
    id: "replacement-provider-version",
    title: "Saved report",
    sourceUrl: "https://example.com/report",
    textContent: `${previous.textContent}\nA newly published conclusion changes the saved provider content.`,
  });
  const index = new ArticleDeduplicationIndex([previous]);

  assert.equal(index.find(replacement)?.article.id, previous.id);
  assert.equal(
    index.find(replacement, {
      excludeArticleId: previous.id,
    }),
    null,
  );
});

function article({
  id,
  title,
  textContent,
  sourceUrl,
}) {
  const now = "2026-07-28T12:00:00.000Z";

  return {
    id,
    title,
    sourceType: sourceUrl ? "url" : "text",
    sourceUrl,
    createdAt: now,
    updatedAt: now,
    wordCount: textContent.split(/\s+/).length,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: now,
    },
    contentHtml: `<p>${textContent}</p>`,
    textContent,
    blocks: [
      {
        id: "paragraph-1",
        type: "paragraph",
        text: textContent,
      },
    ],
  };
}
