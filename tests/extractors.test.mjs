import assert from "node:assert/strict";
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

    if (resolvedPath) {
      return {
        url: pathToFileURL(resolvedPath).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

function resolveSourceFile(basePath) {
  for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`]) {
    try {
      if (process.getBuiltinModule("node:fs").statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

const {
  articleFromFile,
  articleFromHtml,
} = await import("../src/lib/extractors.ts");

const articleParagraphs = Array.from(
  { length: 6 },
  (_, index) =>
    `Article paragraph ${index + 1} contains substantive reporting, concrete evidence, and enough detail for a reader to understand the result.`,
);

test("removes LinkedIn Voyager payloads and trims post-article actions", async () => {
  const payload = JSON.stringify({
    request: "/voyager/api/graphql",
    data: {
      entityUrn: "urn:li:article:123",
      $type: "com.linkedin.voyager.Article",
      padding: "x".repeat(2_000),
    },
  });
  const article = await articleFromHtml(
    `
      <html>
        <head><meta property="og:title" content="A useful LinkedIn article"></head>
        <body>
          <main class="published-content">
            <code id="bpr-guid-123">${payload}</code>
            <h1>A useful LinkedIn article</h1>
            ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
            <p>Comments</p>
            <p>A reader comment that is not part of the article.</p>
            <p>urn:li:page:d_flagship3_pulse_read</p>
            <code>{"request":"/voyager/api/me","padding":"${"z".repeat(500)}"}</code>
          </main>
        </body>
      </html>
    `,
    { sourceUrl: "https://www.linkedin.com/pulse/useful-article/" },
  );

  assert.equal(article.title, "A useful LinkedIn article");
  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(article.textContent, /voyager\/api|entityUrn|padding/);
  assert.doesNotMatch(article.textContent, /reader comment|urn:li:page|\bComments\b/);
  assert.ok(article.wordCount < 180);
});

test("trims LinkedIn save and comment actions when no comments heading exists", async () => {
  const article = await articleFromHtml(
    `
      <html><body><main class="published-content">
        <h1>Another useful LinkedIn article</h1>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        <p>Save</p>
        <p>Comment</p>
        <p>Recommended by LinkedIn</p>
      </main></body></html>
    `,
    { sourceUrl: "https://www.linkedin.com/pulse/another-useful-article/" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(article.textContent, /\bSave\b|\bComment\b|Recommended/);
});

test("trims repeated responsive footers from Framer articles", async () => {
  const footer = `
    <div><p>Field Notes Straight Into Your Inbox</p></div>
    <div><p>Stay in touch with the team's latest research and writing.</p></div>
    <div><p>Docs</p><p>Careers</p><p>navigation</p><p>Socials</p></div>
    <div><p>Linkedin</p><p>X</p><p>Legal</p><p>Privacy Policy</p><p>Terms of Use</p></div>
    <div><p>Trajectory © 2026</p></div>
  `;
  const article = await articleFromHtml(
    `
      <html><body><main>
        <h1>Continual Learning</h1>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        <p>No.2Scaling SDPOScaling SDPO</p>
        <p>Field Notes</p>
        ${footer}${footer}${footer}
      </main></body></html>
    `,
    { sourceUrl: "https://trajectory.ai/field-notes/continual-learning" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(
    article.textContent,
    /No\.2Scaling|Field Notes|Straight Into Your Inbox|Privacy Policy|Trajectory ©/,
  );
});

test("trims Zoom blog subscription, related-resource, and cookie tails", async () => {
  const article = await articleFromHtml(
    `
      <html><body><article>
        <h1>Benchmark result</h1>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        <h2>Subscribe to the Zoom Blog</h2>
        <p>Get the latest Zoom posts directly in your email</p>
        <h2>Related Resources</h2>
        <p>Another promotional story. Read More</p>
        <h2>Cookie Preference Center</h2>
      </article></body></html>
    `,
    { sourceUrl: "https://www.zoom.com/en/blog/benchmark-result/" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(
    article.textContent,
    /Subscribe to the Zoom Blog|Related Resources|Cookie Preference/,
  );
});

test("removes cookie preference panels without truncating the article", async () => {
  const article = await articleFromHtml(
    `
      <html><body><article>
        <h1>Model release</h1>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        <div id="onetrust-pc-sdk">
          <h2>Privacy Preference Center</h2>
          <p>Strictly Necessary Cookies</p>
          <p>Performance Cookies</p>
          <p>Advertising Cookies</p>
          <p>Cookie List</p>
        </div>
      </article></body></html>
    `,
    { sourceUrl: "https://nvidianews.nvidia.com/news/model-release" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(article.textContent, /Cookies|Preference Center/);
});

test("prefers a focused article over a longer link-heavy page container", async () => {
  const relatedLinks = Array.from(
    { length: 35 },
    (_, index) =>
      `<a href="/related/${index}"><p>Related story ${index} with a long promotional headline and category label</p></a>`,
  ).join("");
  const article = await articleFromHtml(
    `
      <html><body><main>
        <article>
          <h1>Focused reporting</h1>
          ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        </article>
        <section>${relatedLinks}</section>
      </main></body></html>
    `,
    { sourceUrl: "https://example.com/focused-reporting" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(article.textContent, /Related story 34/);
});

test("deduplicates repeated responsive content on a landing page", async () => {
  const team = `
    <div><p>Ada Lovelace</p><p>Research lead</p><p>Bio</p></div>
    <div><p>Grace Hopper</p><p>Engineering lead</p><p>Bio</p></div>
  `;
  const article = await articleFromHtml(
    `
      <html><body><main>
        <p>Careers</p><p>Bits</p><p>Atoms</p>
        <h1>Accelerate science</h1>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        ${team}${team}
        <p>Academic Grant Program</p>
        <p>We support bold thinkers and pioneering research.</p>
        <p>follow on x</p><p>Careers</p><p>Bits</p><p>Atoms</p>
        <p>Periodic Labs © 2025</p>
      </main></body></html>
    `,
    { sourceUrl: "https://periodic.com/" },
  );

  assert.equal(article.textContent.match(/Ada Lovelace/g)?.length, 1);
  assert.equal(article.textContent.match(/Grace Hopper/g)?.length, 1);
  assert.doesNotMatch(article.textContent, /^Careers/);
  assert.match(article.textContent, /Academic Grant Program/);
  assert.doesNotMatch(article.textContent, /follow on x|Periodic Labs ©/);
});

test("uses the article boundary on 163.com and excludes related-news tails", async () => {
  const article = await articleFromHtml(
    `
      <html><body><main>
        <h1>一个产品经理的复盘</h1>
        <p>用微信扫码二维码</p>
        <p>分享至好友和朋友圈</p>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
        <p>全文完。</p>
        <h2>本地新闻</h2>
        <p>与正文无关的推荐新闻和广告内容。</p>
      </main></body></html>
    `,
    { sourceUrl: "https://www.163.com/dy/article/example.html" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.match(article.textContent, /全文完。$/);
  assert.doesNotMatch(article.textContent, /扫码|本地新闻|推荐新闻/);
});

test("rejects login and unsupported-browser shells as non-articles", async () => {
  await assert.rejects(
    articleFromHtml(
      `
        <main>
          <p>Log in or sign up for X</p>
          <p>See what’s happening and join the conversation</p>
          <p>Continue with phone</p>
          <p>Log in with username or email</p>
          <p>Trending now</p>
        </main>
      `,
      { sourceUrl: "https://x.com/example/status/1" },
    ),
    /verification|access-check/i,
  );

  await assert.rejects(
    articleFromHtml(
      `<main><p>Sorry, YouTube Music is not optimized for your browser. Check for updates or try Google Chrome.</p></main>`,
      { sourceUrl: "https://music.youtube.com/playlist?list=example" },
    ),
    /verification|access-check/i,
  );
});

test("ignores access-check phrases inside non-readable scripts", async () => {
  const article = await articleFromHtml(
    `
      <html><body><article>
        <h1>Browser security reporting</h1>
        <script>
          window.copy = "verify you are human checking your browser captcha";
        </script>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
      </article></body></html>
    `,
    { sourceUrl: "https://example.com/security-report" },
  );

  assert.match(article.textContent, /Article paragraph 6/);
  assert.doesNotMatch(article.textContent, /verify you are human/);
});

test("preserves mixed direct text, line breaks, nested lists, and absolute images", async () => {
  const article = await articleFromHtml(
    `
      <html><body><main>
        <h1>Structured article</h1>
        <div>
          Introductory direct text.
          <p>First line<br>Second line</p>
          Concluding direct text.
        </div>
        <ul>
          <li>Parent item<ul><li>Nested item</li></ul></li>
          <li>Second parent</li>
        </ul>
        <p><a href="/full-image"><img src="/images/chart.png" alt="Results chart"></a></p>
        ${articleParagraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
      </main></body></html>
    `,
    { sourceUrl: "https://example.com/reports/structured" },
  );

  assert.match(article.textContent, /Introductory direct text/);
  assert.match(article.textContent, /First line\nSecond line/);
  assert.match(article.textContent, /Concluding direct text/);
  assert.match(article.textContent, /Parent item/);
  assert.match(article.textContent, /Nested item/);
  assert.ok(
    article.blocks.some(
      (block) =>
        block.type === "image" &&
        block.src === "https://example.com/images/chart.png",
    ),
  );
});

test("decodes standalone HTML files using their declared charset", async () => {
  const body = articleParagraphs.join(" ");
  const html = Buffer.concat([
    Buffer.from(
      `<html><head><meta charset="windows-1252"></head><body><article><h1>Caf`,
      "ascii",
    ),
    Buffer.from([0xe9]),
    Buffer.from(` report</h1><p>${body}</p></article></body></html>`, "ascii"),
  ]);
  const file = new File([html], "report.html", { type: "text/html" });
  const article = await articleFromFile(file);

  assert.equal(article.title, "Café report");
  assert.match(article.textContent, /Café report/);
  assert.match(article.textContent, /Article paragraph 6/);
});

test("prefers the extracted article heading over an archived MHTML subject", async () => {
  const mhtml = [
    "MIME-Version: 1.0",
    "Subject: Corrupted archive title",
    'Content-Type: multipart/related; boundary="article"',
    "",
    "--article",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Location: https://example.com/correct",
    "",
    `<html><body><article><h1>Correct article title</h1>${articleParagraphs
      .map((paragraph) => `<p>${paragraph}</p>`)
      .join("")}</article></body></html>`,
    "--article--",
  ].join("\r\n");
  const article = await articleFromFile(
    new File([mhtml], "archive.mhtml", { type: "multipart/related" }),
  );

  assert.equal(article.title, "Correct article title");
});

test("uses archive metadata and then the filename when HTML has no title", async () => {
  const body = articleParagraphs
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("");
  const mhtml = [
    "MIME-Version: 1.0",
    "Subject: Saved archive title",
    'Content-Type: multipart/related; boundary="article"',
    "",
    "--article",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Location: https://example.com/untitled",
    "",
    `<html><body><article>${body}</article></body></html>`,
    "--article--",
  ].join("\r\n");
  const archived = await articleFromFile(
    new File([mhtml], "archive.mhtml", { type: "multipart/related" }),
  );
  const standalone = await articleFromFile(
    new File([`<html><body><article>${body}</article></body></html>`], "saved-page.html", {
      type: "text/html",
    }),
  );

  assert.equal(archived.title, "Saved archive title");
  assert.equal(standalone.title, "saved-page");
});

test("rejects empty documents instead of saving placeholder text", async () => {
  await assert.rejects(
    articleFromFile(new File(["   \n\n"], "empty.txt", { type: "text/plain" })),
    /No readable text|OCR/i,
  );
});
