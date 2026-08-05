import { isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

type PublicAddress = {
  address: string;
  family: 4 | 6;
};

type ResolveAddresses = (hostname: string) => Promise<PublicAddress[]>;

type PublicFetch = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

type PublicResourceDependencies = {
  dispatcher?: Dispatcher;
  request?: PublicFetch;
  resolveAddresses?: ResolveAddresses;
};

const defaultPublicFetch = undiciFetch as unknown as PublicFetch;
const publicResourceDispatcher = createPublicResourceDispatcher();

export async function validatePublicArticleUrl(
  rawUrl: string,
  resolveAddresses: ResolveAddresses = resolveHostnameAddresses,
) {
  const { url } = await resolvePublicArticleTarget(rawUrl, resolveAddresses);
  return url;
}

async function resolvePublicArticleTarget(
  rawUrl: string,
  resolveAddresses: ResolveAddresses,
) {
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

  const literalFamily = isIP(hostname);

  if (literalFamily && isPrivateAddress(hostname)) {
    throw new Error("Private-network article URLs are not allowed.");
  }

  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily } as PublicAddress]
    : validatedPublicAddresses(await resolveAddresses(hostname));

  return { addresses, url };
}

export async function fetchPublicResource(
  rawUrl: string,
  init: Omit<RequestInit, "redirect"> = {},
  maxRedirects = 5,
  dependencies: PublicResourceDependencies = {},
) {
  const request = dependencies.request ?? defaultPublicFetch;
  const dispatcher = dependencies.dispatcher ?? publicResourceDispatcher;
  const resolveAddresses = dependencies.resolveAddresses ?? resolveHostnameAddresses;
  let { url } = await resolvePublicArticleTarget(rawUrl, resolveAddresses);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const headers = new Headers(init.headers);
    headers.delete("host");

    const response = await request(url, {
      ...init,
      dispatcher,
      headers,
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
      await cancelResponseBody(response);
      throw new Error("The article URL redirected too many times.");
    }

    await cancelResponseBody(response);
    ({ url } = await resolvePublicArticleTarget(
      new URL(location, url).href,
      resolveAddresses,
    ));
  }

  throw new Error("The article URL redirected too many times.");
}

export async function fetchPublicImageResource(
  rawUrl: string,
  init: Omit<RequestInit, "redirect">,
  maxBytes: number,
  dependencies: PublicResourceDependencies = {},
) {
  const { response, url } = await fetchPublicResource(
    rawUrl,
    init,
    5,
    dependencies,
  );

  if (!response.ok) {
    await cancelResponseBody(response);
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";

  if (!contentType.toLowerCase().startsWith("image/")) {
    await cancelResponseBody(response);
    return null;
  }

  const body = await readResponseBodyWithLimit(response, maxBytes);

  if (body.byteLength === 0) {
    return null;
  }

  return {
    body,
    contentType,
    url,
  };
}

export async function readResponseBodyWithLimit(response: Response, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Response body limit must be a positive safe integer.");
  }

  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength?.trim() ? Number(declaredLength) : Number.NaN;

  if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
    await cancelResponseBody(response);
    throw responseBodyTooLargeError(maxBytes);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      byteLength += value.byteLength;

      if (byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size-limit error below is the actionable failure.
        }

        throw responseBodyTooLargeError(maxBytes);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, byteLength);
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // A response that is already closed or locked needs no further cleanup.
  }
}

function responseBodyTooLargeError(maxBytes: number) {
  return new Error(`Remote resource exceeds the ${maxBytes}-byte archive limit.`);
}

export function createPublicResourceDispatcher(
  resolveAddresses: ResolveAddresses = resolveHostnameAddresses,
) {
  return new Agent({
    connect: {
      lookup: createPublicAddressLookup(resolveAddresses),
    },
  });
}

export function createPublicAddressLookup(
  resolveAddresses: ResolveAddresses = resolveHostnameAddresses,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAddresses(normalizeHostname(hostname))
      .then(validatedPublicAddresses)
      .then((addresses) => {
        const requestedFamily = normalizedLookupFamily(options.family);
        const matchingAddresses = requestedFamily
          ? addresses.filter((address) => address.family === requestedFamily)
          : addresses;

        if (matchingAddresses.length === 0) {
          throw lookupFailure(
            `The article hostname has no public IPv${requestedFamily} address.`,
            "EAI_ADDRFAMILY",
          );
        }

        if (options.all) {
          callback(null, matchingAddresses);
          return;
        }

        const [address] = matchingAddresses;
        callback(null, address.address, address.family);
      })
      .catch((error: unknown) => {
        callback(asLookupError(error), "", 0);
      });
  };
}

async function resolveHostnameAddresses(hostname: string): Promise<PublicAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });

  return addresses.map((address) => ({
    address: address.address,
    family: address.family === 6 ? 6 : 4,
  }));
}

function validatedPublicAddresses(addresses: PublicAddress[]) {
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family || isPrivateAddress(address),
    )
  ) {
    throw lookupFailure("The article hostname resolves to a private network.");
  }

  return addresses;
}

function normalizedLookupFamily(family: number | string | undefined) {
  if (family === 4 || family === "IPv4") {
    return 4;
  }

  if (family === 6 || family === "IPv6") {
    return 6;
  }

  return undefined;
}

function normalizeHostname(hostname: string) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function lookupFailure(message: string, code = "ENOTFOUND") {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function asLookupError(error: unknown) {
  if (error instanceof Error) {
    return error as NodeJS.ErrnoException;
  }

  return lookupFailure("The article hostname could not be resolved.");
}

function isPrivateAddress(address: string) {
  try {
    return ipaddr.process(address).range() !== "unicast";
  } catch {
    return true;
  }
}
