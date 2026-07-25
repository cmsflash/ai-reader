import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import {
  decodeVoiceDocument,
  decodeVoiceMhtml,
  decodeVoiceMhtmlZip,
} from "../src/lib/voiceDocuments.ts";

test("decodes the first quoted-printable HTML MIME part", () => {
  const mhtml = [
    "MIME-Version: 1.0",
    "Subject: =?UTF-8?Q?A_quoted_=E2=9C=93_story?=",
    'Content-Type: multipart/related; boundary="voice-boundary"',
    "Snapshot-Content-Location: https://example.com/from-snapshot",
    "",
    "--voice-boundary",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This part is not HTML.",
    "--voice-boundary",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: https://example.com/from-part",
    "",
    "<!doctype html><html><body><p>caf=C3=A9 =E2=9C=93</p></body></html>",
    "--voice-boundary",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<html><body>This later HTML part must not win.</body></html>",
    "--voice-boundary--",
    "",
  ].join("\r\n");

  assert.deepEqual(decodeVoiceMhtml(Buffer.from(mhtml, "latin1")), {
    html: "<!doctype html><html><body><p>café ✓</p></body></html>",
    title: "A quoted ✓ story",
    sourceUrl: "https://example.com/from-snapshot",
  });
});

test("decodes base64 HTML and falls back to the part content location", () => {
  const html =
    '<!doctype html><html><body><h1 lang="zh">你好</h1></body></html>';
  const mhtml = [
    "MIME-Version: 1.0",
    `Subject: =?UTF-8?B?${Buffer.from("你好").toString("base64")}?=`,
    'Content-Type: multipart/related; boundary="base64-boundary"',
    "",
    "--base64-boundary",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.org/base64-article",
    "",
    Buffer.from(html).toString("base64"),
    "--base64-boundary--",
    "",
  ].join("\n");

  assert.deepEqual(decodeVoiceMhtml(Buffer.from(mhtml, "latin1")), {
    html,
    title: "你好",
    sourceUrl: "https://example.org/base64-article",
  });
});

test("decodes @Voice MHTML.ZIP metadata and deflated index.html", () => {
  const html = [
    "<!-- Hyperionics-OriginHtml https://example.net/article?id=7 -->",
    "<!doctype html><html><body><article>Zipped article</article></body></html>",
  ].join("\n");
  const archive = createZip(
    [
      { name: "f1.css", content: "body { color: black; }" },
      { name: "index.html", content: html, deflate: true },
    ],
    "avarUrl: https://comment.example/older\navarTitle: Zipped Story",
  );

  assert.deepEqual(decodeVoiceMhtmlZip(archive), {
    html,
    title: "Zipped Story",
    sourceUrl: "https://example.net/article?id=7",
  });
});

test("uses the ZIP avarUrl when index.html has no origin marker", () => {
  const html = "<!doctype html><html><body>Comment URL</body></html>";
  const archive = createZip(
    [{ name: "captured/index.html", content: html }],
    "avarUrl: https://example.com/from-comment\navarTitle: Comment metadata",
  );

  assert.deepEqual(decodeVoiceDocument(archive, "ARTICLE.MHTML.ZIP"), {
    html,
    title: "Comment metadata",
    sourceUrl: "https://example.com/from-comment",
  });
});

test("rejects MHTML without an HTML part and ZIPs without index.html", () => {
  const mhtml = [
    'Content-Type: multipart/related; boundary="no-html"',
    "",
    "--no-html",
    "Content-Type: text/plain",
    "",
    "Only text",
    "--no-html--",
  ].join("\r\n");
  const archive = createZip([{ name: "other.html", content: "Not index" }], "");

  assert.throws(
    () => decodeVoiceDocument(Buffer.from(mhtml), "missing.mhtml"),
    /no HTML MIME part/i,
  );
  assert.throws(() => decodeVoiceMhtmlZip(archive), /index\.html was not found/i);
});

function createZip(entries, comment) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const compressed = entry.deflate ? deflateRawSync(content) : content;
    const method = entry.deflate ? 8 : 0;
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const encodedComment = Buffer.from(comment, "utf8");
  const endRecord = Buffer.alloc(22);

  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(encodedComment.length, 20);

  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endRecord,
    encodedComment,
  ]);
}

function crc32(input) {
  let crc = 0xffffffff;

  for (const byte of input) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
