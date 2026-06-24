import { randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import mammoth from "mammoth";
import { marked } from "marked";
import pdfParse from "pdf-parse";
import sanitizeHtml from "sanitize-html";
import { annotateBlocks } from "./sentences";
import type { Article, ArticleBlock, SourceType } from "./types";

type ExtractedArticle = {
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
  processingCostUsd?: number;
  contentHtml: string;
  blocks: ArticleBlock[];
};

type HtmlCandidate = {
  title: string;
  contentHtml: string;
  blocks: ArticleBlock[];
  textContent: string;
  score: number;
};

type JsxTreeNode = {
  type: string;
  props: Record<string, unknown>;
  children: JsxChild[];
};

type JsxChild = JsxTreeNode | string;

type AstNode = {
  type: string;
  [key: string]: unknown;
};

const articleRequestHeaders = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.7,*/*;q=0.5",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const titleSelectors = [
  "#activity-name",
  ".rich_media_title",
  "h1",
  '[itemprop="headline"]',
  ".article-title",
  ".post-title",
  ".entry-title",
  ".headline",
];

const articleContentSelectors = [
  "article",
  "main",
  '[role="main"]',
  '[itemprop="articleBody"]',
  ".article-content",
  ".post-content",
  ".entry-content",
  ".story-content",
  ".article-body",
  ".post-body",
  ".content-body",
];

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  "article",
  "section",
  "main",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
  "pre",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
];

const allowedAttributes = {
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title", "data-src", "data-original", "data-url"],
  code: ["class"],
  pre: ["class"],
};

export async function articleFromUrl(rawUrl: string): Promise<Article> {
  const url = normalizeUrl(rawUrl);
  const response = await fetch(url.href, {
    headers: articleRequestHeaders,
  });

  if (!response.ok) {
    throw new Error(`Could not fetch URL: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (contentType.includes("application/pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
    return buildArticle(await extractPdf(buffer, titleFromUrl(url), url.href));
  }

  const raw = buffer.toString("utf8");

  if (contentType.includes("text/plain")) {
    return buildArticle(extractPlainText(raw, titleFromUrl(url), "text", url.href));
  }

  return buildArticle(await extractReadableHtml(raw, url.href));
}

export async function articleFromFile(file: File): Promise<Article> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileName = file.name || "Untitled";
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (extension === "pdf" || file.type === "application/pdf") {
    return buildArticle(await extractPdf(buffer, stripExtension(fileName)));
  }

  if (
    extension === "docx" ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return buildArticle(await extractDocx(buffer, stripExtension(fileName)));
  }

  if (["md", "markdown", "mdown"].includes(extension) || file.type === "text/markdown") {
    return buildArticle(await extractMarkdown(buffer.toString("utf8"), stripExtension(fileName)));
  }

  if (extension === "txt" || file.type.startsWith("text/")) {
    return buildArticle(extractPlainText(buffer.toString("utf8"), stripExtension(fileName), "text"));
  }

  throw new Error("Unsupported file type. Import PDF, DOCX, Markdown, or text files.");
}

function buildArticle(extracted: ExtractedArticle): Article {
  const now = new Date().toISOString();
  const textContent = blocksToText(extracted.blocks);
  const wordCount = countWords(textContent);
  const sentenceCount = annotateBlocks(extracted.blocks).sentences.length;

  return {
    id: randomUUID(),
    title: extracted.title || "Untitled",
    sourceType: extracted.sourceType,
    sourceUrl: extracted.sourceUrl,
    createdAt: now,
    updatedAt: now,
    wordCount,
    estimatedMinutes: Math.max(1, Math.ceil(wordCount / 230)),
    sentenceCount,
    processingCostUsd: extracted.processingCostUsd ?? 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: now,
    },
    contentHtml: extracted.contentHtml,
    textContent,
    blocks: extracted.blocks,
  };
}

async function extractReadableHtml(rawHtml: string, sourceUrl: string): Promise<ExtractedArticle> {
  const dom = new JSDOM(rawHtml, { url: sourceUrl });
  const document = dom.window.document;
  const source = new URL(sourceUrl);
  const pageText = normalizeText(document.body?.textContent ?? "");

  if (looksLikeBlockedPage(pageText)) {
    throw new Error("The site returned a verification or access-check page instead of article content.");
  }

  const title = extractHtmlTitle(document, source);
  removeNonReadableNodes(document);

  const candidates = [
    ...collectSelectorCandidates(document, platformContentSelectors(source), title, 800),
    readabilityCandidate(rawHtml, sourceUrl, title),
    ...collectSelectorCandidates(document, articleContentSelectors, title, 120),
    ...collectLargeElementCandidates(document, title),
    bodyCandidate(document, title),
  ].filter((candidate): candidate is HtmlCandidate => candidate !== null);

  const candidate = bestHtmlCandidate(candidates);

  if (!candidate) {
    const staticBundleArticle = await extractStaticBundleArticle(rawHtml, sourceUrl, title);

    if (staticBundleArticle) {
      return staticBundleArticle;
    }

    throw new Error("No readable article content was found on this page.");
  }

  if (looksLikeBlockedPage(candidate.textContent)) {
    throw new Error("The extracted page looks like a verification or access-check page.");
  }

  return {
    title: candidate.title,
    sourceType: "url",
    sourceUrl,
    contentHtml: candidate.contentHtml,
    blocks: candidate.blocks,
  };
}

function readabilityCandidate(
  rawHtml: string,
  sourceUrl: string,
  fallbackTitle: string,
): HtmlCandidate | null {
  const dom = new JSDOM(rawHtml, { url: sourceUrl });
  removeNonReadableNodes(dom.window.document);
  const parsed = new Readability(dom.window.document).parse();

  if (!parsed?.content) {
    return null;
  }

  return buildHtmlCandidate(
    parsed.title || fallbackTitle,
    parsed.content,
    parsed.textContent || "",
    520,
  );
}

function collectSelectorCandidates(
  document: Document,
  selectors: string[],
  fallbackTitle: string,
  baseScore: number,
) {
  const seen = new Set<Element>();
  const candidates: HtmlCandidate[] = [];

  selectors.forEach((selector, index) => {
    document.querySelectorAll(selector).forEach((element) => {
      if (seen.has(element)) {
        return;
      }

      seen.add(element);
      const candidate = candidateFromElement(element, fallbackTitle, baseScore - index * 3);

      if (candidate) {
        candidates.push(candidate);
      }
    });
  });

  return candidates;
}

function collectLargeElementCandidates(document: Document, fallbackTitle: string) {
  return Array.from(document.querySelectorAll("article, main, section, div"))
    .map((element) => candidateFromElement(element, fallbackTitle, 0))
    .filter((candidate): candidate is HtmlCandidate => candidate !== null)
    .filter((candidate) => candidate.textContent.length >= 300)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function bodyCandidate(document: Document, fallbackTitle: string) {
  if (!document.body) {
    return null;
  }

  return candidateFromElement(document.body, fallbackTitle, -160);
}

function candidateFromElement(
  element: Element,
  fallbackTitle: string,
  baseScore: number,
): HtmlCandidate | null {
  const textContent = elementReadableText(element);

  if (textContent.length < 80) {
    return null;
  }

  const title = titleFromElement(element) || fallbackTitle;
  return buildHtmlCandidate(title, element.innerHTML, textContent, baseScore);
}

function buildHtmlCandidate(
  title: string,
  html: string,
  fallbackText: string,
  baseScore: number,
): HtmlCandidate | null {
  const contentHtml = cleanHtml(html);
  const blocks = htmlToBlocks(contentHtml);
  const usableBlocks = blocks.length > 0 ? blocks : blocksFromPlainText(fallbackText);
  const textContent = blocksToText(usableBlocks) || normalizeText(fallbackText);

  if (usableBlocks.length === 0 || textContent.length < 80) {
    return null;
  }

  return {
    title: normalizeText(title).slice(0, 180) || "Untitled",
    contentHtml: usableBlocks.length > 0 ? blocksToHtml(usableBlocks) : contentHtml,
    blocks: usableBlocks,
    textContent,
    score: baseScore + scoreArticleCandidate(usableBlocks, textContent),
  };
}

function bestHtmlCandidate(candidates: HtmlCandidate[]) {
  return candidates
    .filter((candidate) => !looksLikeBlockedPage(candidate.textContent))
    .filter((candidate) => candidate.blocks.length > 0)
    .sort((a, b) => b.score - a.score)[0] ?? null;
}

function scoreArticleCandidate(blocks: ArticleBlock[], textContent: string) {
  const paragraphs = blocks.filter((block) => block.type === "paragraph" || block.type === "quote");
  const headings = blocks.filter((block) => block.type === "heading");
  const lists = blocks.filter((block) => block.type === "list");
  const tables = blocks.filter((block) => block.type === "table");
  const images = blocks.filter((block) => block.type === "image");
  const textLength = Math.min(textContent.length, 20000);
  const averageParagraphLength =
    paragraphs.length === 0
      ? 0
      : paragraphs.reduce((total, block) => total + blockTextLength(block), 0) / paragraphs.length;
  const shortBlockPenalty = blocks.filter((block) => blockTextLength(block) < 20).length * 10;

  return (
    textLength / 18 +
    paragraphs.length * 28 +
    headings.length * 10 +
    lists.length * 12 +
    tables.length * 30 +
    images.length * 8 +
    Math.min(averageParagraphLength, 280) -
    shortBlockPenalty
  );
}

function blockTextLength(block: ArticleBlock) {
  return blockToText(block).length;
}

function elementReadableText(element: Element) {
  const imageText = Array.from(element.querySelectorAll("img"))
    .map((image) =>
      [image.getAttribute("alt"), image.getAttribute("title")]
        .map((value) => normalizeText(value ?? ""))
        .find(Boolean),
    )
    .filter(Boolean);

  return normalizeText([element.textContent ?? "", ...imageText].join(" "));
}

function extractHtmlTitle(document: Document, source: URL) {
  const selectorTitle = titleSelectors
    .map((selector) => normalizeText(document.querySelector(selector)?.textContent ?? ""))
    .find(Boolean);

  if (selectorTitle) {
    return selectorTitle;
  }

  const metaTitle =
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[name="title"]')?.content;

  return normalizeText(metaTitle || document.title || titleFromUrl(source));
}

function titleFromElement(element: Element) {
  const heading = Array.from(element.querySelectorAll("h1, h2, h3"))
    .map((candidate) => normalizeText(candidate.textContent ?? ""))
    .find((text) => text.length > 0 && text.length <= 180);

  return heading ?? "";
}

function platformContentSelectors(source: URL) {
  const host = source.hostname.toLowerCase();

  if (host === "mp.weixin.qq.com" || host.endsWith(".mp.weixin.qq.com")) {
    return ["#js_content", ".rich_media_content"];
  }

  return [];
}

function removeNonReadableNodes(document: Document) {
  document
    .querySelectorAll(
      [
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "form",
        "input",
        "button",
        "select",
        "textarea",
        "nav",
        "header",
        "footer",
        '[aria-hidden="true"]',
      ].join(","),
    )
    .forEach((element) => element.remove());
}

function looksLikeBlockedPage(text: string) {
  const normalized = normalizeText(text).toLowerCase();

  if (!normalized) {
    return false;
  }

  const markers = [
    "当前环境异常",
    "完成验证后即可继续访问",
    "去验证",
    "verify you are human",
    "checking your browser",
    "access denied",
    "captcha",
    "enable javascript and cookies",
    "unusual traffic",
  ];

  const markerCount = markers.filter((marker) => normalized.includes(marker)).length;
  const isVeryShort = normalized.length < 600;

  return markerCount >= 2 || (markerCount >= 1 && isVeryShort);
}

async function extractStaticBundleArticle(
  rawHtml: string,
  sourceUrl: string,
  fallbackTitle: string,
): Promise<ExtractedArticle | null> {
  const assetUrls = scriptAssetUrls(rawHtml, sourceUrl);

  for (const assetUrl of assetUrls) {
    try {
      const response = await fetch(assetUrl.href, {
        headers: {
          accept: "application/javascript,text/javascript,*/*;q=0.8",
          "user-agent": articleRequestHeaders["user-agent"],
        },
      });

      if (!response.ok) {
        continue;
      }

      const source = await response.text();
      const article = extractCompiledMdxBundle(source, assetUrl.href, sourceUrl, fallbackTitle);

      if (article) {
        return article;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function scriptAssetUrls(rawHtml: string, sourceUrl: string) {
  const dom = new JSDOM(rawHtml, { url: sourceUrl });

  return Array.from(dom.window.document.querySelectorAll<HTMLScriptElement>("script[src]"))
    .map((script) => script.getAttribute("src"))
    .filter((src): src is string => Boolean(src))
    .map((src) => new URL(src, sourceUrl))
    .filter((url) => url.protocol === "http:" || url.protocol === "https:");
}

function extractCompiledMdxBundle(
  source: string,
  assetUrl: string,
  articleUrl: string,
  fallbackTitle: string,
): ExtractedArticle | null {
  let ast: AstNode;

  try {
    ast = parse(source, {
      errorRecovery: true,
      sourceType: "module",
    }) as unknown as AstNode;
  } catch {
    return null;
  }

  const metadata = compiledBundleMetadata(source);
  const blocks = compiledMdxBlocks(ast, assetUrl);
  const textContent = blocksToText(blocks);

  if (blocks.length === 0 || textContent.length < 400) {
    return null;
  }

  return {
    title: metadata.title || fallbackTitle,
    sourceType: "url",
    sourceUrl: articleUrl,
    contentHtml: blocksToHtml(blocks),
    blocks,
  };
}

function compiledBundleMetadata(source: string) {
  return {
    title: templatePropertyFromSource(source, "title"),
    date: templatePropertyFromSource(source, "date"),
  };
}

function templatePropertyFromSource(source: string, key: string) {
  const prefix = `${key}:\``;
  const start = source.indexOf(prefix);

  if (start === -1) {
    return "";
  }

  const valueStart = start + prefix.length;
  let value = "";
  let slashCount = 0;

  for (let index = valueStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "`" && slashCount % 2 === 0) {
      return normalizeText(unescapeTemplateText(value));
    }

    value += char;
    slashCount = char === "\\" ? slashCount + 1 : 0;
  }

  return "";
}

function compiledMdxBlocks(ast: AstNode, assetUrl: string) {
  let bestBlocks: ArticleBlock[] = [];
  let bestLength = 0;

  walkAst(ast, (node) => {
    if (node.type !== "FunctionDeclaration") {
      return;
    }

    const returnArgument = functionReturnArgument(node);

    if (!returnArgument) {
      return;
    }

    const tree = jsxTreeFromExpression(returnArgument);
    const blocks = blocksFromJsxChild(tree, assetUrl);
    const length = blocksToText(blocks).length;

    if (length > bestLength) {
      bestBlocks = blocks;
      bestLength = length;
    }
  });

  return compactBlocks(bestBlocks);
}

function functionReturnArgument(node: AstNode) {
  const body = asAstNode(node.body);
  const statements = asAstArray(body?.body);
  const returnStatement = statements.find((statement) => statement.type === "ReturnStatement");
  return asAstNode(returnStatement?.argument);
}

function blocksFromJsxChild(child: JsxChild | JsxChild[] | null, assetUrl: string) {
  const blocks: ArticleBlock[] = [];
  appendJsxBlocks(child, blocks, assetUrl);
  return compactBlocks(blocks);
}

function appendJsxBlocks(
  child: JsxChild | JsxChild[] | null,
  blocks: ArticleBlock[],
  assetUrl: string,
) {
  if (child === null) {
    return;
  }

  if (Array.isArray(child)) {
    child.forEach((item) => appendJsxBlocks(item, blocks, assetUrl));
    return;
  }

  if (typeof child === "string") {
    const text = normalizeText(child);

    if (text) {
      blocks.push({
        id: blockId("paragraph", blocks.length),
        type: "paragraph",
        text,
      });
    }
    return;
  }

  if (child.type === "Fragment") {
    appendJsxBlocks(child.children, blocks, assetUrl);
    return;
  }

  if (/^h[1-6]$/.test(child.type)) {
    const text = jsxText(child);

    if (text) {
      blocks.push({
        id: blockId("heading", blocks.length),
        type: "heading",
        level: Number(child.type.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
        text,
      });
    }
    return;
  }

  if (child.type === "p") {
    const meaningfulChildren = child.children.filter(
      (item) => typeof item !== "string" || normalizeText(item).length > 0,
    );

    if (
      meaningfulChildren.length === 1 &&
      typeof meaningfulChildren[0] !== "string" &&
      meaningfulChildren[0].type === "img"
    ) {
      appendJsxBlocks(meaningfulChildren[0], blocks, assetUrl);
      return;
    }

    const text = jsxText(child);

    if (text) {
      blocks.push({
        id: blockId("paragraph", blocks.length),
        type: "paragraph",
        text,
      });
    }
    return;
  }

  if (child.type === "blockquote") {
    const text = jsxText(child);

    if (text) {
      blocks.push({
        id: blockId("quote", blocks.length),
        type: "quote",
        text,
      });
    }
    return;
  }

  if (child.type === "pre") {
    const text = normalizeCode(jsxText(child));

    if (text) {
      blocks.push({
        id: blockId("code", blocks.length),
        type: "code",
        text,
      });
    }
    return;
  }

  if (child.type === "ul" || child.type === "ol") {
    const items = child.children
      .filter((item): item is JsxTreeNode => typeof item !== "string" && item.type === "li")
      .map((item) => jsxText(item))
      .filter(Boolean);

    if (items.length > 0) {
      blocks.push({
        id: blockId("list", blocks.length),
        type: "list",
        ordered: child.type === "ol",
        items,
      });
    }
    return;
  }

  if (child.type === "img") {
    const image = imageBlockFromJsxNode(child, blocks.length, assetUrl);

    if (image) {
      blocks.push(image);
    }
    return;
  }

  if (child.type === "table") {
    const table = tableBlockFromJsxNode(child, blocks.length);

    if (table) {
      blocks.push(table);
    }
    return;
  }

  if (child.type === "BenchmarkTable") {
    const table = benchmarkTableBlockFromJsxNode(child, blocks.length);

    if (table) {
      blocks.push(table);
    }
    return;
  }

  appendJsxBlocks(child.children, blocks, assetUrl);
}

function imageBlockFromJsxNode(node: JsxTreeNode, index: number, assetUrl: string): ArticleBlock | null {
  const src = stringValue(node.props.src);
  const alt = normalizeText(stringValue(node.props.alt) || stringValue(node.props.title));

  if (!src && !alt) {
    return null;
  }

  return {
    id: blockId("image", index),
    type: "image",
    alt,
    src: src ? new URL(src, assetUrl).href : undefined,
  };
}

function tableBlockFromJsxNode(node: JsxTreeNode, index: number): ArticleBlock | null {
  const rows = jsxDescendants(node, "tr")
    .map((row) => {
      const cells = row.children.filter(
        (cell): cell is JsxTreeNode =>
          typeof cell !== "string" && (cell.type === "td" || cell.type === "th"),
      );

      return {
        isHeader: cells.length > 0 && cells.every((cell) => cell.type === "th"),
        cells: cells.map((cell) => jsxText(cell)),
      };
    })
    .filter((row) => row.cells.some(Boolean));

  if (rows.length === 0) {
    return null;
  }

  const firstBodyRow = rows.findIndex((row) => !row.isHeader);

  return {
    id: blockId("table", index),
    type: "table",
    headerRows: firstBodyRow === -1 ? rows.length : firstBodyRow || undefined,
    rows: rows.map((row) => row.cells),
  };
}

function benchmarkTableBlockFromJsxNode(node: JsxTreeNode, index: number): ArticleBlock | null {
  const models = stringArray(node.props.models);
  const groups = objectArray(node.props.groups);

  if (models.length === 0 || groups.length === 0) {
    return null;
  }

  const rows = [["Group", "Benchmark", ...models]];

  groups.forEach((group) => {
    const groupName = stringValue(group.name);
    const benchmarks = objectArray(group.benchmarks);

    benchmarks.forEach((benchmark) => {
      rows.push([
        groupName,
        stringValue(benchmark.name),
        ...arrayValue(benchmark.scores).map((score) => scoreToText(score)),
      ]);
    });
  });

  return {
    id: blockId("table", index),
    type: "table",
    caption: "Full Benchmark Table",
    headerRows: 1,
    rows,
  };
}

function jsxDescendants(node: JsxTreeNode, type: string): JsxTreeNode[] {
  const matches: JsxTreeNode[] = [];

  node.children.forEach((child) => {
    if (typeof child === "string") {
      return;
    }

    if (child.type === type) {
      matches.push(child);
    }

    matches.push(...jsxDescendants(child, type));
  });

  return matches;
}

function jsxText(child: JsxChild | JsxChild[] | null): string {
  if (child === null) {
    return "";
  }

  if (Array.isArray(child)) {
    return normalizeText(child.map((item) => jsxText(item)).join(" "));
  }

  if (typeof child === "string") {
    return normalizeText(child);
  }

  if (child.props["aria-hidden"] === true) {
    return "";
  }

  if (child.type === "img") {
    return normalizeText(stringValue(child.props.alt) || stringValue(child.props.title));
  }

  return normalizeText(child.children.map((item) => jsxText(item)).join(" "));
}

function jsxTreeFromExpression(expression: AstNode | null): JsxChild | JsxChild[] | null {
  if (!expression) {
    return null;
  }

  if (expression.type === "StringLiteral") {
    return stringValue(expression.value);
  }

  if (expression.type === "NumericLiteral") {
    return String(expression.value);
  }

  if (expression.type === "TemplateLiteral") {
    return templateLiteralText(expression);
  }

  if (expression.type === "ArrayExpression") {
    return asAstArray(expression.elements)
      .map((element) => jsxTreeFromExpression(element))
      .flatMap((child) => (Array.isArray(child) ? child : child === null ? [] : [child]));
  }

  if (expression.type !== "CallExpression") {
    return "";
  }

  const args = asAstArray(expression.arguments);
  const props = propsFromObjectExpression(asAstNode(args[1]));
  const node: JsxTreeNode = {
    type: jsxElementType(asAstNode(args[0]), props),
    props,
    children: childrenFromValue(props.children),
  };

  return node;
}

function childrenFromValue(value: unknown): JsxChild[] {
  if (value === null || value === undefined || value === false) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => childrenFromValue(item));
  }

  if (isJsxTreeNode(value)) {
    return [value];
  }

  return [String(value)];
}

function propsFromObjectExpression(expression: AstNode | null): Record<string, unknown> {
  if (!expression || expression.type !== "ObjectExpression") {
    return {};
  }

  const props: Record<string, unknown> = {};

  asAstArray(expression.properties).forEach((property) => {
    if (property.type !== "ObjectProperty") {
      return;
    }

    const key = propertyKey(property.key);

    if (!key) {
      return;
    }

    props[key] = expressionValue(asAstNode(property.value));
  });

  return props;
}

function expressionValue(expression: AstNode | null): unknown {
  if (!expression) {
    return null;
  }

  if (expression.type === "StringLiteral") {
    return stringValue(expression.value);
  }

  if (expression.type === "NumericLiteral" || expression.type === "BooleanLiteral") {
    return expression.value;
  }

  if (expression.type === "NullLiteral") {
    return null;
  }

  if (expression.type === "TemplateLiteral") {
    return templateLiteralText(expression);
  }

  if (expression.type === "ArrayExpression") {
    return asAstArray(expression.elements).map((element) => expressionValue(element));
  }

  if (expression.type === "ObjectExpression") {
    return propsFromObjectExpression(expression);
  }

  if (expression.type === "CallExpression") {
    return jsxTreeFromExpression(expression);
  }

  if (expression.type === "UnaryExpression" && expression.operator === "-") {
    const argument = expressionValue(asAstNode(expression.argument));
    return typeof argument === "number" ? -argument : null;
  }

  if (expression.type === "Identifier" && expression.name === "undefined") {
    return undefined;
  }

  return "";
}

function jsxElementType(expression: AstNode | null, props: Record<string, unknown>) {
  if (!expression) {
    return "span";
  }

  if (expression.type === "MemberExpression") {
    const property = asAstNode(expression.property);
    const name = propertyName(property);
    return name || "span";
  }

  if (expression.type === "Identifier") {
    if (Array.isArray(props.models) && Array.isArray(props.groups)) {
      return "BenchmarkTable";
    }

    return stringValue(expression.name) || "span";
  }

  return "span";
}

function templateLiteralText(expression: AstNode) {
  return asAstArray(expression.quasis)
    .map((quasi) => {
      const value = asRecord(quasi.value);
      return stringValue(value.cooked ?? value.raw);
    })
    .join("");
}

function propertyKey(key: unknown) {
  const node = asAstNode(key);

  if (!node) {
    return "";
  }

  if (node.type === "Identifier") {
    return stringValue(node.name);
  }

  if (node.type === "StringLiteral") {
    return stringValue(node.value);
  }

  return "";
}

function propertyName(node: AstNode | null) {
  if (!node) {
    return "";
  }

  if (node.type === "Identifier") {
    return stringValue(node.name);
  }

  if (node.type === "StringLiteral") {
    return stringValue(node.value);
  }

  return "";
}

function walkAst(node: AstNode, visitor: (node: AstNode) => void) {
  visitor(node);

  Object.values(node).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const child = asAstNode(item);

        if (child) {
          walkAst(child, visitor);
        }
      });
      return;
    }

    const child = asAstNode(value);

    if (child) {
      walkAst(child, visitor);
    }
  });
}

function asAstNode(value: unknown): AstNode | null {
  if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
    return value as AstNode;
  }

  return null;
}

function asAstArray(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.map(asAstNode).filter((node): node is AstNode => Boolean(node)) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isJsxTreeNode(value: unknown): value is JsxTreeNode {
  return Boolean(value && typeof value === "object" && typeof (value as JsxTreeNode).type === "string");
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map((item) => stringValue(item));
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return arrayValue(value).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function scoreToText(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return stringValue(value);
}

function unescapeTemplateText(value: string) {
  return value.replace(/\\`/g, "`").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

async function extractDocx(buffer: Buffer, fallbackTitle: string): Promise<ExtractedArticle> {
  const result = await mammoth.convertToHtml({ buffer });
  const contentHtml = cleanHtml(result.value);
  const blocks = htmlToBlocks(contentHtml);

  return {
    title: titleFromBlocks(blocks, fallbackTitle),
    sourceType: "docx",
    contentHtml,
    blocks: ensureBlocks(blocks, ""),
  };
}

async function extractMarkdown(markdown: string, fallbackTitle: string): Promise<ExtractedArticle> {
  const html = await marked.parse(markdown, {
    async: true,
    gfm: true,
  });
  const contentHtml = cleanHtml(html);
  const blocks = htmlToBlocks(contentHtml);

  return {
    title: titleFromBlocks(blocks, fallbackTitle),
    sourceType: "markdown",
    contentHtml,
    blocks: ensureBlocks(blocks, markdown),
  };
}

async function extractPdf(
  buffer: Buffer,
  fallbackTitle: string,
  sourceUrl?: string,
): Promise<ExtractedArticle> {
  const result = await pdfParse(buffer);
  const blocks = blocksFromPlainText(result.text);
  const contentHtml = blocksToHtml(blocks);

  return {
    title: titleFromBlocks(blocks, fallbackTitle),
    sourceType: "pdf",
    sourceUrl,
    contentHtml,
    blocks: ensureBlocks(blocks, result.text),
  };
}

function extractPlainText(
  text: string,
  fallbackTitle: string,
  sourceType: SourceType,
  sourceUrl?: string,
): ExtractedArticle {
  const blocks = blocksFromPlainText(text);

  return {
    title: titleFromBlocks(blocks, fallbackTitle),
    sourceType,
    sourceUrl,
    contentHtml: blocksToHtml(blocks),
    blocks: ensureBlocks(blocks, text),
  };
}

function htmlToBlocks(html: string): ArticleBlock[] {
  const dom = new JSDOM(`<main>${html}</main>`);
  const root = dom.window.document.querySelector("main");
  const blocks: ArticleBlock[] = [];

  if (!root) {
    return blocks;
  }

  Array.from(root.children).forEach((element) => visitElement(element, blocks));

  return compactBlocks(blocks);
}

function visitElement(element: Element, blocks: ArticleBlock[]) {
  const tag = element.tagName.toLowerCase();
  const text = normalizeText(element.textContent ?? "");

  if (tag === "figure") {
    const image = imageBlockFromElement(element.querySelector("img"), blocks.length, figureCaption(element));

    if (image) {
      blocks.push(image);
      return;
    }
  }

  if (tag === "img") {
    const image = imageBlockFromElement(element, blocks.length);

    if (image) {
      blocks.push(image);
    }
    return;
  }

  if (tag === "table") {
    const table = tableBlockFromElement(element, blocks.length);

    if (table) {
      blocks.push(table);
    }
    return;
  }

  if (!text && !element.querySelector("img, table")) {
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    blocks.push({
      id: blockId("heading", blocks.length),
      type: "heading",
      level: Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
      text,
    });
    return;
  }

  if (tag === "p") {
    if (text) {
      blocks.push({
        id: blockId("paragraph", blocks.length),
        type: "paragraph",
        text,
      });
    }

    Array.from(element.querySelectorAll(":scope > img")).forEach((imageElement) => {
      const image = imageBlockFromElement(imageElement, blocks.length);

      if (image) {
        blocks.push(image);
      }
    });
    return;
  }

  if (tag === "blockquote") {
    blocks.push({
      id: blockId("quote", blocks.length),
      type: "quote",
      text,
    });
    return;
  }

  if (tag === "pre") {
    blocks.push({
      id: blockId("code", blocks.length),
      type: "code",
      text: normalizeCode(element.textContent ?? ""),
    });
    return;
  }

  if (tag === "ul" || tag === "ol") {
    const items = Array.from(element.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((child) => normalizeText(child.textContent ?? ""))
      .filter(Boolean);

    if (items.length > 0) {
      blocks.push({
        id: blockId("list", blocks.length),
        type: "list",
        ordered: tag === "ol",
        items,
      });
    }
    return;
  }

  const blockChildren = Array.from(element.children).filter((child) => isBlockElement(child.tagName));

  if (blockChildren.length > 0) {
    blockChildren.forEach((child) => visitElement(child, blocks));
    return;
  }

  blocks.push({
    id: blockId("paragraph", blocks.length),
    type: "paragraph",
    text,
  });
}

function imageBlockFromElement(
  element: Element | null,
  index: number,
  caption = "",
): ArticleBlock | null {
  if (!element) {
    return null;
  }

  const alt = normalizeText(element.getAttribute("alt") ?? "");
  const title = normalizeText(element.getAttribute("title") ?? "");
  const normalizedCaption = normalizeText(caption);
  const src = imageSourceFromElement(element);
  const readableAlt = alt || title;

  if (!readableAlt && !normalizedCaption && !src) {
    return null;
  }

  return {
    id: blockId("image", index),
    type: "image",
    alt: readableAlt,
    src,
    caption: normalizedCaption && normalizedCaption !== readableAlt ? normalizedCaption : undefined,
  };
}

function imageSourceFromElement(element: Element) {
  const rawSource =
    element.getAttribute("src") ||
    element.getAttribute("data-src") ||
    element.getAttribute("data-original") ||
    element.getAttribute("data-url") ||
    "";

  const source = normalizeText(rawSource);

  if (!source) {
    return undefined;
  }

  try {
    return new URL(source, element.ownerDocument.baseURI).href;
  } catch {
    return source;
  }
}

function figureCaption(element: Element) {
  return normalizeText(element.querySelector("figcaption")?.textContent ?? "");
}

function tableBlockFromElement(element: Element, index: number): ArticleBlock | null {
  const tableRows = Array.from(element.querySelectorAll("tr"))
    .map((row) => {
      const cells = Array.from(row.children).filter((cell) =>
        /^(td|th)$/i.test(cell.tagName),
      );

      return {
        isHeader: cells.length > 0 && cells.every((cell) => cell.tagName.toLowerCase() === "th"),
        cells: cells.map((cell) => normalizeText(cell.textContent ?? "")),
      };
    })
    .filter((row) => row.cells.some(Boolean));

  if (tableRows.length === 0) {
    return null;
  }

  const headerRows = tableRows.findIndex((row) => !row.isHeader);
  const normalizedHeaderRows =
    headerRows === -1 ? tableRows.length : Math.max(headerRows, 0);

  return {
    id: blockId("table", index),
    type: "table",
    caption: normalizeText(element.querySelector("caption")?.textContent ?? "") || undefined,
    headerRows: normalizedHeaderRows || undefined,
    rows: tableRows.map((row) => row.cells),
  };
}

function blocksFromPlainText(text: string): ArticleBlock[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
    .map((paragraph, index) => ({
      id: blockId("paragraph", index),
      type: "paragraph" as const,
      text: paragraph,
    }));
}

function ensureBlocks(blocks: ArticleBlock[], fallbackText: string): ArticleBlock[] {
  if (blocks.length > 0) {
    return blocks;
  }

  const fallbackBlocks = blocksFromPlainText(fallbackText);

  if (fallbackBlocks.length > 0) {
    return fallbackBlocks;
  }

  return [
    {
      id: "paragraph-0",
      type: "paragraph",
      text: "No readable text was extracted.",
    },
  ];
}

function compactBlocks(blocks: ArticleBlock[]) {
  return blocks.filter((block, index, allBlocks) => {
    const previous = allBlocks[index - 1];

    if (!previous) {
      return true;
    }

    if (
      block.type === "list" ||
      previous.type === "list" ||
      block.type === "table" ||
      previous.type === "table" ||
      block.type === "image" ||
      previous.type === "image"
    ) {
      return true;
    }

    return blockToText(block) !== blockToText(previous);
  });
}

function blocksToText(blocks: ArticleBlock[]) {
  return blocks
    .map((block) => blockToText(block))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function blockToText(block: ArticleBlock) {
  if (block.type === "list") {
    return block.items.join("\n");
  }

  if (block.type === "image") {
    return [block.alt, block.caption].filter(Boolean).join("\n");
  }

  if (block.type === "table") {
    return [
      block.caption,
      ...block.rows.map((row) => row.filter(Boolean).join("\t")),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return block.text;
}

export function blocksToHtml(blocks: ArticleBlock[]) {
  const html = blocks
    .map((block) => {
      if (block.type === "heading") {
        return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
      }

      if (block.type === "quote") {
        return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      }

      if (block.type === "code") {
        return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
      }

      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
        return `<${tag}>${items}</${tag}>`;
      }

      if (block.type === "image") {
        const image = block.src
          ? `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}">`
          : `<p><strong>Image:</strong> ${escapeHtml(block.alt || "No alt text")}</p>`;
        const caption = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : "";
        return `<figure>${image}${caption}</figure>`;
      }

      if (block.type === "table") {
        const caption = block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : "";
        const rows = block.rows
          .map((row, rowIndex) => {
            const cellTag = rowIndex < (block.headerRows ?? 0) ? "th" : "td";
            const cells = row.map((cell) => `<${cellTag}>${escapeHtml(cell)}</${cellTag}>`).join("");
            return `<tr>${cells}</tr>`;
          })
          .join("");
        return `<table>${caption}<tbody>${rows}</tbody></table>`;
      }

      return `<p>${escapeHtml(block.text)}</p>`;
    })
    .join("");

  return cleanHtml(html);
}

function cleanHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ["http", "https", "mailto", "data"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
    },
  });
}

function titleFromBlocks(blocks: ArticleBlock[], fallbackTitle: string) {
  const heading = blocks.find((block) => block.type === "heading" && block.text.length > 0);

  if (heading && heading.type === "heading") {
    return heading.text.slice(0, 160);
  }

  return fallbackTitle || "Untitled";
}

function titleFromUrl(url: URL) {
  const lastPath = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  return stripExtension(lastPath) || url.hostname;
}

function normalizeUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl.trim());

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    return url;
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").trim() || "Untitled";
}

function normalizeText(text: string) {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeCode(text: string) {
  return text.replace(/\r\n?/g, "\n").trim();
}

function blockId(type: ArticleBlock["type"], index: number) {
  return `${type}-${index}`;
}

function isBlockElement(tagName: string) {
  return /^(article|aside|blockquote|div|figure|figcaption|h[1-6]|img|li|main|ol|p|pre|section|table|ul)$/i.test(
    tagName,
  );
}

function countWords(text: string) {
  const cjkCharacters =
    text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)
      ?.length ?? 0;
  const nonCjkText = text.replace(
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g,
    " ",
  );
  const words = nonCjkText.match(/[\p{L}\p{N}'-]+/gu)?.length ?? 0;
  return words + cjkCharacters;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
