import { inflateRawSync } from "node:zlib";

export type VoiceDocument = {
  html: string;
  title?: string;
  sourceUrl?: string;
};

type BinaryInput = ArrayBuffer | Uint8Array;

type MimeEntity = {
  headers: Map<string, string>;
  body: string;
};

type ZipEntry = {
  compressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
};

const MAX_HTML_BYTES = 32 * 1024 * 1024;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

export function decodeVoiceDocument(
  input: BinaryInput,
  fileName: string,
): VoiceDocument {
  const normalizedName = fileName.toLowerCase();

  if (normalizedName.endsWith(".mhtml.zip")) {
    return decodeVoiceMhtmlZip(input);
  }

  if (normalizedName.endsWith(".mhtml") || normalizedName.endsWith(".mht")) {
    return decodeVoiceMhtml(input);
  }

  throw new Error("Unsupported @Voice document. Import an MHTML or MHTML.ZIP file.");
}

export function decodeVoiceMhtml(input: BinaryInput): VoiceDocument {
  const raw = toBuffer(input).toString("latin1");
  const topLevel = parseMimeEntity(raw);
  const contentType = topLevel.headers.get("content-type") ?? "";
  const boundary = readMimeParameter(contentType, "boundary");

  if (!boundary) {
    throw new Error("Invalid MHTML document: multipart boundary is missing.");
  }

  const startContentId = normalizeContentId(
    readMimeParameter(contentType, "start"),
  );
  const htmlParts = collectMimeLeafParts(topLevel).filter((part) =>
    isHtmlContentType(part.headers.get("content-type")),
  );
  const htmlPart =
    htmlParts.find(
      (part) =>
        startContentId &&
        normalizeContentId(part.headers.get("content-id")) === startContentId,
    ) ?? htmlParts[0];

  if (!htmlPart) {
    throw new Error("Invalid MHTML document: no HTML MIME part was found.");
  }

  const html = decodeMimeBody(htmlPart);
  const title = optionalText(
    decodeMimeWords(topLevel.headers.get("subject") ?? ""),
  );
  const sourceUrl =
    readHyperionicsOrigin(html) ??
    optionalHttpUrl(topLevel.headers.get("snapshot-content-location")) ??
    optionalHttpUrl(htmlPart.headers.get("content-location"));

  return withOptionalMetadata({ html }, title, sourceUrl);
}

export function decodeVoiceMhtmlZip(input: BinaryInput): VoiceDocument {
  const archive = toBuffer(input);
  const endOffset = findEndOfCentralDirectory(archive);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  const commentStart = endOffset + 22;
  const commentEnd = commentStart + commentLength;

  if (commentEnd > archive.length) {
    throw new Error("Invalid MHTML.ZIP document: ZIP comment is truncated.");
  }

  const comment = decodeBytes(archive.subarray(commentStart, commentEnd), "utf-8");
  const entries = readZipEntries(archive, endOffset);
  const indexEntry = selectIndexHtml(entries);

  if (!indexEntry) {
    throw new Error(
      "Invalid MHTML.ZIP document: index.html was not found (index.htm was also checked).",
    );
  }

  const html = decodeHtmlBytes(readZipEntry(archive, indexEntry));
  const title = optionalText(readAvarCommentValue(comment, "avarTitle"));
  const sourceUrl =
    readHyperionicsOrigin(html) ??
    optionalHttpUrl(readAvarCommentValue(comment, "avarUrl"));

  return withOptionalMetadata({ html }, title, sourceUrl);
}

function parseMimeEntity(raw: string): MimeEntity {
  const separator = /\r?\n\r?\n|\r\r/.exec(raw);

  if (!separator || separator.index === undefined) {
    return {
      headers: parseHeaders(raw),
      body: "",
    };
  }

  return {
    headers: parseHeaders(raw.slice(0, separator.index)),
    body: raw.slice(separator.index + separator[0].length),
  };
}

function parseHeaders(rawHeaders: string) {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+|\r[ \t]+/g, " ");
  const headers = new Map<string, string>();

  for (const line of unfolded.split(/\r?\n|\r/)) {
    const separator = line.indexOf(":");

    if (separator <= 0) {
      continue;
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const previous = headers.get(name);
    headers.set(name, previous ? `${previous}, ${value}` : value);
  }

  return headers;
}

function readMimeParameter(header: string, parameter: string) {
  const escapedParameter = escapeRegExp(parameter);
  const match = new RegExp(
    `(?:^|;)\\s*${escapedParameter}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`,
    "i",
  ).exec(header);

  return optionalText(match?.[1] ?? match?.[2]);
}

function splitMultipartBody(body: string, boundary: string) {
  const marker = `--${boundary}`;
  const closingMarker = `${marker}--`;
  const parts: string[] = [];
  let current: string[] | null = null;

  for (const line of body.split(/\r\n|\n|\r/)) {
    const comparableLine = line.replace(/[ \t]+$/, "");

    if (comparableLine === marker || comparableLine === closingMarker) {
      if (current) {
        parts.push(current.join("\n"));
      }

      if (comparableLine === closingMarker) {
        break;
      }

      current = [];
      continue;
    }

    if (current) {
      current.push(line);
    }
  }

  return parts;
}

function collectMimeLeafParts(entity: MimeEntity): MimeEntity[] {
  const contentType = entity.headers.get("content-type") ?? "";
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const boundary = readMimeParameter(contentType, "boundary");

  if (!mimeType.startsWith("multipart/") || !boundary) {
    return [entity];
  }

  return splitMultipartBody(entity.body, boundary)
    .map(parseMimeEntity)
    .flatMap(collectMimeLeafParts);
}

function isHtmlContentType(contentType?: string) {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}

function decodeMimeBody(entity: MimeEntity) {
  const contentType = entity.headers.get("content-type") ?? "";
  const charset = readMimeParameter(contentType, "charset") ?? "utf-8";
  const transferEncoding = (
    entity.headers.get("content-transfer-encoding") ?? "8bit"
  )
    .trim()
    .toLowerCase();

  let bytes: Buffer;

  if (transferEncoding === "base64") {
    bytes = Buffer.from(entity.body.replace(/\s+/g, ""), "base64");
  } else if (transferEncoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(entity.body);
  } else {
    bytes = Buffer.from(entity.body, "latin1");
  }

  if (bytes.length > MAX_HTML_BYTES) {
    throw new Error("Invalid MHTML document: HTML part is too large.");
  }

  return decodeBytes(bytes, charset);
}

function decodeQuotedPrintable(value: string) {
  const withoutSoftBreaks = value.replace(/=\r?\n|=\r/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const character = withoutSoftBreaks[index];

    if (
      character === "=" &&
      /^[0-9a-f]{2}$/i.test(withoutSoftBreaks.slice(index + 1, index + 3))
    ) {
      bytes.push(Number.parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(withoutSoftBreaks.charCodeAt(index) & 0xff);
  }

  return Buffer.from(bytes);
}

function decodeMimeWords(value: string) {
  const joinedWords = value.replace(/\?=\s+(?==\?)/g, "?=");

  return joinedWords.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (encodedWord, charset: string, encoding: string, encodedText: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(encodedText, "base64")
            : decodeQuotedPrintable(encodedText.replace(/_/g, " "));

        return decodeBytes(bytes, charset);
      } catch {
        return encodedWord;
      }
    },
  );
}

function readHyperionicsOrigin(html: string) {
  const match =
    /<!--\s*Hyperionics-(?:OriginHtml|LdAsIsHtml)\s+([\s\S]*?)\s*-->/i.exec(
      html,
    );
  return optionalHttpUrl(match?.[1]);
}

function readAvarCommentValue(comment: string, key: string) {
  const match = new RegExp(`^${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "im").exec(
    comment,
  );
  return match?.[1];
}

function findEndOfCentralDirectory(archive: Buffer) {
  const minimumOffset = Math.max(0, archive.length - 65_535 - 22);

  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }

  throw new Error("Invalid MHTML.ZIP document: end of ZIP directory was not found.");
}

function readZipEntries(archive: Buffer, endOffset: number) {
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entryCount === 0xffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectorySize === 0xffffffff
  ) {
    throw new Error("Unsupported MHTML.ZIP document: multi-disk and ZIP64 archives are not supported.");
  }

  const directoryEnd = centralDirectoryOffset + centralDirectorySize;

  if (directoryEnd > archive.length || directoryEnd > endOffset) {
    throw new Error("Invalid MHTML.ZIP document: central directory is truncated.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > directoryEnd ||
      archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("Invalid MHTML.ZIP document: central directory entry is invalid.");
    }

    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const fileCommentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const entryEnd =
      offset + 46 + fileNameLength + extraLength + fileCommentLength;

    if (entryEnd > directoryEnd) {
      throw new Error("Invalid MHTML.ZIP document: central directory entry is truncated.");
    }

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("Unsupported MHTML.ZIP document: ZIP64 entries are not supported.");
    }

    const fileNameBytes = archive.subarray(offset + 46, offset + 46 + fileNameLength);
    const name = decodeBytes(
      fileNameBytes,
      flags & 0x0800 ? "utf-8" : "windows-1252",
    );

    entries.push({
      compressedSize,
      compressionMethod,
      flags,
      localHeaderOffset,
      name,
      uncompressedSize,
    });

    offset = entryEnd;
  }

  return entries;
}

function selectIndexHtml(entries: ZipEntry[]) {
  const normalized = entries.map((entry) => ({
    entry,
    name: entry.name.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(),
  }));

  return (
    normalized.find(({ name }) => name === "index.html")?.entry ??
    normalized.find(({ name }) => name === "index.htm")?.entry ??
    normalized.find(({ name }) => name.endsWith("/index.html"))?.entry ??
    normalized.find(({ name }) => name.endsWith("/index.htm"))?.entry
  );
}

function readZipEntry(archive: Buffer, entry: ZipEntry) {
  if (entry.flags & 0x0001) {
    throw new Error("Unsupported MHTML.ZIP document: encrypted entries are not supported.");
  }

  const offset = entry.localHeaderOffset;

  if (
    offset + 30 > archive.length ||
    archive.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw new Error("Invalid MHTML.ZIP document: local file header is invalid.");
  }

  const fileNameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const contentStart = offset + 30 + fileNameLength + extraLength;
  const contentEnd = contentStart + entry.compressedSize;

  if (contentEnd > archive.length) {
    throw new Error("Invalid MHTML.ZIP document: file content is truncated.");
  }

  if (entry.uncompressedSize > MAX_HTML_BYTES) {
    throw new Error("Invalid MHTML.ZIP document: index.html is too large.");
  }

  const compressed = archive.subarray(contentStart, contentEnd);
  let content: Buffer;

  if (entry.compressionMethod === 0) {
    content = Buffer.from(compressed);
  } else if (entry.compressionMethod === 8) {
    content = inflateRawSync(compressed, { maxOutputLength: MAX_HTML_BYTES });
  } else {
    throw new Error(
      `Unsupported MHTML.ZIP document: compression method ${entry.compressionMethod} is not supported.`,
    );
  }

  if (content.length !== entry.uncompressedSize) {
    throw new Error("Invalid MHTML.ZIP document: index.html size does not match its directory entry.");
  }

  return content;
}

function decodeBytes(bytes: Uint8Array, charset: string) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeHtmlBytes(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const bomEncoding =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? "utf-8"
      : buffer[0] === 0xff && buffer[1] === 0xfe
        ? "utf-16le"
        : buffer[0] === 0xfe && buffer[1] === 0xff
          ? "utf-16be"
          : undefined;
  const prefix = buffer.subarray(0, 8_192).toString("latin1");
  const declaredEncoding =
    /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^"'\s/>]+)/i.exec(prefix)?.[1] ||
    /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*\bcharset\s*=\s*([^;"'\s]+)/i.exec(
      prefix,
    )?.[1];

  return decodeBytes(buffer, bomEncoding ?? declaredEncoding ?? "utf-8");
}

function normalizeContentId(value?: string | null) {
  return optionalText(value)?.replace(/^<|>$/g, "").toLowerCase();
}

function toBuffer(input: BinaryInput) {
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }

  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function optionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function optionalHttpUrl(value?: string | null) {
  const normalized = optionalText(value);

  if (!normalized) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function withOptionalMetadata(
  document: Pick<VoiceDocument, "html">,
  title?: string,
  sourceUrl?: string,
): VoiceDocument {
  return {
    ...document,
    ...(title ? { title } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
