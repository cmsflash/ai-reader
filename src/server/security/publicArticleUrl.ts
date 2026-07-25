import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function validatePublicArticleUrl(rawUrl: string) {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid article URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Article URLs must use HTTP or HTTPS.");
  }

  if (url.username || url.password) {
    throw new Error("Article URLs cannot contain embedded credentials.");
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private-network article URLs are not allowed.");
  }

  if (isPrivateAddress(hostname)) {
    throw new Error("Private-network article URLs are not allowed.");
  }

  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });

    if (
      addresses.length === 0 ||
      addresses.some((address) => isPrivateAddress(address.address))
    ) {
      throw new Error("The article hostname resolves to a private network.");
    }
  }

  return url;
}

export async function fetchPublicResource(
  rawUrl: string,
  init: Omit<RequestInit, "redirect"> = {},
  maxRedirects = 5,
) {
  let url = await validatePublicArticleUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
    });

    if (!redirectStatuses.has(response.status)) {
      return { response, url };
    }

    const location = response.headers.get("location");

    if (!location) {
      throw new Error("The remote server returned a redirect without a destination.");
    }

    if (redirectCount === maxRedirects) {
      throw new Error("The article URL redirected too many times.");
    }

    url = await validatePublicArticleUrl(new URL(location, url).href);
  }

  throw new Error("The article URL redirected too many times.");
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  const version = isIP(normalized);

  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;

    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (version === 6) {
    const mappedIpv4 = mappedIpv4Address(normalized);

    if (mappedIpv4) {
      return isPrivateAddress(mappedIpv4);
    }

    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  return false;
}

function mappedIpv4Address(address: string) {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];

  if (dotted) {
    return dotted;
  }

  const hexadecimal = address.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );

  if (!hexadecimal) {
    return undefined;
  }

  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);

  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}
