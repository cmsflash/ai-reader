import assert from "node:assert/strict";
import test from "node:test";
import { publicationEntries } from "../src/server/publications/sources.ts";
test("OpenAI keeps notices separate even when they link to the same rolling update", () => {
  const entries = publicationEntries(
    "openai-misalignment",
    `<main>
    <article class="ap-notice" id="notice-a"><h3>A</h3><time datetime="2026-09-11"></time><p>First incident.</p><a href="https://openai.com/update/#a">Update</a></article>
    <article class="ap-notice" id="notice-b"><h3>B</h3><p>Second incident.</p><a href="https://openai.com/update/#b">Update</a></article>
    <a class="ap-report-link" href="/misalignment-reports/report/"><h3>Report</h3></a>
    <a class="ap-report-link" href="/misalignment-reports/report/"><h3>Report</h3></a>
    <a class="ap-report-link" href="https://evil.test/misalignment-reports/report/"><h3>Unrelated</h3></a>
    <a href="https://openai.com/privacy">Privacy</a></main>`,
  );
  assert.equal(entries.length, 3);
  assert.match(entries[0].url, /#notice-a$/);
  assert.match(entries[1].url, /#notice-b$/);
  assert.equal(entries[0].publishedAt, "2026-09-11");
  assert.match(entries[0].html, /First incident/);
  assert.equal(
    entries[2].url,
    "https://alignment.openai.com/misalignment-reports/report/",
  );
});
test("Anthropic follows publication cards but excludes datasets and footer links", () => {
  const entries = publicationEntries(
    "anthropic-alignment",
    `<div class="toc">
 <a href="2026/report/"><h3>Report</h3></a><a href="https://www.anthropic.com/research/study"><h3>Study</h3></a>
 <a href="https://drive.google.com/data"><h3>Data</h3></a></div><a href="/jobs"><h3>Jobs</h3></a>`,
  );
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Report", "Study"],
  );
});
test("a layout change raises an error instead of silently reporting success", () => {
  assert.throws(
    () => publicationEntries("openai-misalignment", "<main>No cards</main>"),
    /No publications found/,
  );
});
test("Rundown only imports AI newsletter cards and deduplicates tracking URLs", () => {
  const entries = publicationEntries("rundown-ai", `<main>
    <a href="/articles/new-ai?utm_source=web"><span>AI</span><h3>New AI</h3></a>
    <a href="/articles/new-ai"><span>AI</span><h3>New AI</h3></a>
    <a href="/articles/tech"><span>Tech</span><h3>Tech</h3></a>
    <a href="/news/story"><span>AI</span><h3>News</h3></a>
    <a href="https://other.test/articles/story"><span>AI</span><h3>Other</h3></a>
    <a href="/articles-category/ai"><h3>AI archive</h3></a>
  </main>`);
  assert.deepEqual(entries, [{
    url: "https://www.therundown.ai/articles/new-ai", title: "New AI",
  }]);
});
