import type { ArtifactBody } from "@/server/ports/artifactStorage";

type ByteRange = {
  start: number;
  end: number;
};

export function articleNarrationResponse(
  artifact: ArtifactBody,
  rangeHeader: string | null,
) {
  if (!artifact.contentType.toLowerCase().startsWith("audio/")) {
    throw new Error("Article narration artifact must be audio.");
  }

  const totalBytes = artifact.body.byteLength;
  const range = parseByteRange(rangeHeader, totalBytes);
  const commonHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, must-revalidate",
    "content-type": artifact.contentType,
    "x-content-type-options": "nosniff",
  };

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        ...commonHeaders,
        "content-range": `bytes */${totalBytes}`,
      },
    });
  }

  if (range) {
    const body = artifact.body.subarray(range.start, range.end + 1);

    return new Response(new Uint8Array(body), {
      status: 206,
      headers: {
        ...commonHeaders,
        "content-length": body.byteLength.toString(),
        "content-range": `bytes ${range.start}-${range.end}/${totalBytes}`,
      },
    });
  }

  return new Response(new Uint8Array(artifact.body), {
    headers: {
      ...commonHeaders,
      "content-length": totalBytes.toString(),
    },
  });
}

function parseByteRange(
  rangeHeader: string | null,
  totalBytes: number,
): ByteRange | null | "invalid" {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());

  if (!match || totalBytes <= 0 || (!match[1] && !match[2])) {
    return "invalid";
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }

    return {
      start: Math.max(totalBytes - suffixLength, 0),
      end: totalBytes - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= totalBytes ||
    requestedEnd < start
  ) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(requestedEnd, totalBytes - 1),
  };
}
