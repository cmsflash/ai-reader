import { createHmac, randomBytes } from "node:crypto";

const instapaperApiBaseUrl = "https://www.instapaper.com/api/1";

const credentialEnvironmentNames = {
  consumerKey: "INSTAPAPER_CONSUMER_KEY",
  consumerSecret: "INSTAPAPER_CONSUMER_SECRET",
  accessToken: "INSTAPAPER_ACCESS_TOKEN",
  accessTokenSecret: "INSTAPAPER_ACCESS_TOKEN_SECRET",
} as const;

const retryableApiCodes = new Set([1040, 1047, 1500]);

export type InstapaperConfigurationStatus = {
  configured: boolean;
  missing: string[];
};

export type InstapaperCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export type InstapaperUser = {
  type: "user";
  user_id: number;
  username: string;
  subscription_is_active?: string;
};

export type InstapaperFolder = {
  type: "folder";
  folder_id: number;
  title: string;
  display_title: string;
  slug: string;
  sync_to_mobile: number;
  position: number;
  public: number;
  count: number;
};

export type InstapaperTag = {
  id: number;
  name: string;
};

export type InstapaperBookmark = {
  type: "bookmark";
  bookmark_id: number;
  url: string;
  title: string;
  description: string;
  time: number;
  starred: string;
  private_source: string;
  hash: string;
  progress: number;
  progress_timestamp: number;
  tags: InstapaperTag[];
};

export type InstapaperHighlight = {
  type: "highlight";
  highlight_id: number;
  bookmark_id: number;
  text: string;
  position: number;
  time: number;
  note: string | null;
};

export type InstapaperBookmarkList = {
  user: InstapaperUser;
  bookmarks: InstapaperBookmark[];
  highlights: InstapaperHighlight[];
  delete_ids: Array<number | string>;
};

export type InstapaperBookmarkListInput = {
  limit?: number;
  folderId?: "unread" | "starred" | "archive" | number | string;
  tag?: string;
  have?: string | ReadonlyArray<number | string>;
  highlights?: string | ReadonlyArray<number | string>;
};

export type InstapaperErrorKind =
  | "configuration"
  | "network"
  | "http"
  | "api"
  | "invalid-response";

export class InstapaperApiError extends Error {
  kind: InstapaperErrorKind;
  endpoint: string;
  status?: number;
  apiCode?: number;
  apiMessage?: string;
  retryable: boolean;
  retryAfterMs?: number;
  attempts: number;
  missingConfiguration: string[];

  constructor(input: {
    message: string;
    kind: InstapaperErrorKind;
    endpoint: string;
    status?: number;
    apiCode?: number;
    apiMessage?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    attempts?: number;
    missingConfiguration?: string[];
  }) {
    super(input.message);
    this.name = "InstapaperApiError";
    this.kind = input.kind;
    this.endpoint = input.endpoint;
    this.status = input.status;
    this.apiCode = input.apiCode;
    this.apiMessage = input.apiMessage;
    this.retryable = input.retryable ?? false;
    this.retryAfterMs = input.retryAfterMs;
    this.attempts = input.attempts ?? 1;
    this.missingConfiguration = input.missingConfiguration ?? [];
  }
}

export type InstapaperClient = {
  verifyCredentials(): Promise<InstapaperUser>;
  listFolders(): Promise<InstapaperFolder[]>;
  listBookmarks(input?: InstapaperBookmarkListInput): Promise<InstapaperBookmarkList>;
  getText(bookmarkId: number | string): Promise<string>;
};

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type InstapaperClientOptions = {
  environment?: NodeJS.ProcessEnv;
  credentials?: InstapaperCredentials;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  nonce?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  retry?: RetryOptions;
};

type RequiredRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type RequestResponseKind = "json" | "text";

export function getInstapaperConfigurationStatus(
  environment: NodeJS.ProcessEnv = process.env,
): InstapaperConfigurationStatus {
  const missing = Object.values(credentialEnvironmentNames).filter(
    (name) => !environment[name]?.trim(),
  );

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function isInstapaperConfigured(environment: NodeJS.ProcessEnv = process.env) {
  return getInstapaperConfigurationStatus(environment).configured;
}

export function createInstapaperClient(options: InstapaperClientOptions = {}): InstapaperClient {
  const environment = options.environment ?? process.env;
  const credentials = options.credentials ?? credentialsFromEnvironment(environment);
  const fetcher = options.fetch ?? globalThis.fetch;

  if (typeof fetcher !== "function") {
    throw new InstapaperApiError({
      message: "A server-side fetch implementation is required for Instapaper.",
      kind: "configuration",
      endpoint: "",
    });
  }

  const dependencies = {
    credentials,
    fetcher,
    now: options.now ?? Date.now,
    nonce: options.nonce ?? (() => randomBytes(16).toString("hex")),
    sleep: options.sleep ?? sleep,
    random: options.random ?? Math.random,
    retry: normalizeRetryOptions(options.retry),
  };

  return {
    async verifyCredentials() {
      const endpoint = `${instapaperApiBaseUrl}/account/verify_credentials`;
      const payload = await requestWithRetry(dependencies, endpoint, [], "json");
      const items = standardArray(payload, endpoint);
      const user = items.find(isObjectWithType("user"));

      if (!user) {
        throw invalidResponseError(endpoint, "The response did not contain an Instapaper user.");
      }

      return parseUser(user, endpoint);
    },

    async listFolders() {
      const endpoint = `${instapaperApiBaseUrl}/folders/list`;
      const payload = await requestWithRetry(dependencies, endpoint, [], "json");

      return standardArray(payload, endpoint)
        .filter(isObjectWithType("folder"))
        .map((folder) => parseFolder(folder, endpoint));
    },

    async listBookmarks(input = {}) {
      const endpoint = `${instapaperApiBaseUrl}/bookmarks/list`;
      const parameters = bookmarkListParameters(input, endpoint);
      const payload = await requestWithRetry(dependencies, endpoint, parameters, "json");
      const object = asRecord(payload);

      if (!object || !Array.isArray(object.bookmarks)) {
        throw invalidResponseError(endpoint, "The response did not contain a bookmarks list.");
      }

      return {
        user: parseUser(object.user, endpoint),
        bookmarks: object.bookmarks.map((bookmark) => parseBookmark(bookmark, endpoint)),
        highlights: arrayValue(object.highlights).map((highlight) =>
          parseHighlight(highlight, endpoint),
        ),
        delete_ids: arrayValue(object.delete_ids).map((id) => parseDeleteId(id, endpoint)),
      };
    },

    async getText(bookmarkId) {
      const endpoint = `${instapaperApiBaseUrl}/bookmarks/get_text`;
      const normalizedBookmarkId = requiredPositiveInteger(bookmarkId, "bookmarkId", endpoint);

      return requestWithRetry(
        dependencies,
        endpoint,
        [["bookmark_id", normalizedBookmarkId]],
        "text",
      );
    },
  };
}

type ClientDependencies = {
  credentials: InstapaperCredentials;
  fetcher: typeof globalThis.fetch;
  now: () => number;
  nonce: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  retry: RequiredRetryOptions;
};

async function requestWithRetry(
  dependencies: ClientDependencies,
  endpoint: string,
  parameters: Array<[string, string]>,
  responseKind: "text",
): Promise<string>;
async function requestWithRetry(
  dependencies: ClientDependencies,
  endpoint: string,
  parameters: Array<[string, string]>,
  responseKind: "json",
): Promise<unknown>;
async function requestWithRetry(
  dependencies: ClientDependencies,
  endpoint: string,
  parameters: Array<[string, string]>,
  responseKind: RequestResponseKind,
) {
  for (let attempt = 1; attempt <= dependencies.retry.maxAttempts; attempt += 1) {
    try {
      return await requestOnce(dependencies, endpoint, parameters, responseKind);
    } catch (caught) {
      const error =
        caught instanceof InstapaperApiError
          ? caught
          : new InstapaperApiError({
              message: "The Instapaper request failed before receiving a response.",
              kind: "network",
              endpoint,
              retryable: true,
            });

      error.attempts = attempt;

      if (!error.retryable || attempt >= dependencies.retry.maxAttempts) {
        throw error;
      }

      await dependencies.sleep(retryDelay(dependencies, error, attempt));
    }
  }

  throw new InstapaperApiError({
    message: "The Instapaper request exhausted its retry attempts.",
    kind: "network",
    endpoint,
    retryable: true,
    attempts: dependencies.retry.maxAttempts,
  });
}

async function requestOnce(
  dependencies: ClientDependencies,
  endpoint: string,
  parameters: Array<[string, string]>,
  responseKind: RequestResponseKind,
) {
  const authorization = oauthAuthorizationHeader(
    "POST",
    endpoint,
    parameters,
    dependencies.credentials,
    dependencies.now,
    dependencies.nonce,
  );
  const body = new URLSearchParams(parameters).toString();
  const response = await dependencies.fetcher(endpoint, {
    method: "POST",
    headers: {
      accept: responseKind === "text" ? "text/html,application/json" : "application/json",
      authorization,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body,
    cache: "no-store",
  });
  const responseBody = await response.text();
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), dependencies.now);

  if (!response.ok) {
    const apiError = apiErrorFromText(responseBody);

    if (apiError) {
      throw apiResponseError(endpoint, response.status, apiError, retryAfterMs);
    }

    throw new InstapaperApiError({
      message: `Instapaper returned HTTP ${response.status}.`,
      kind: "http",
      endpoint,
      status: response.status,
      retryable: retryableHttpStatus(response.status),
      retryAfterMs,
    });
  }

  if (responseKind === "text") {
    return responseBody;
  }

  const payload = parseJson(responseBody);

  if (payload === undefined) {
    throw new InstapaperApiError({
      message: "Instapaper returned a non-JSON response where JSON was required.",
      kind: "invalid-response",
      endpoint,
      status: response.status,
      retryable: true,
    });
  }

  const apiError = apiErrorFromPayload(payload);

  if (apiError) {
    throw apiResponseError(endpoint, response.status, apiError, retryAfterMs);
  }

  return payload;
}

function oauthAuthorizationHeader(
  method: string,
  endpoint: string,
  requestParameters: Array<[string, string]>,
  credentials: InstapaperCredentials,
  now: () => number,
  nonce: () => string,
) {
  const oauthParameters: Array<[string, string]> = [
    ["oauth_consumer_key", credentials.consumerKey],
    ["oauth_nonce", nonce()],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(Math.floor(now() / 1000))],
    ["oauth_token", credentials.accessToken],
    ["oauth_version", "1.0"],
  ];
  const normalizedParameters = [...requestParameters, ...oauthParameters]
    .map(([key, value]) => [oauthPercentEncode(key), oauthPercentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = compareEncodedValues(leftKey, rightKey);
      return keyOrder === 0 ? compareEncodedValues(leftValue, rightValue) : keyOrder;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signatureBase = [
    method.toUpperCase(),
    oauthPercentEncode(endpoint),
    oauthPercentEncode(normalizedParameters),
  ].join("&");
  const signingKey = [
    oauthPercentEncode(credentials.consumerSecret),
    oauthPercentEncode(credentials.accessTokenSecret),
  ].join("&");
  const signature = createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  return `OAuth ${[...oauthParameters, ["oauth_signature", signature] as [string, string]]
    .sort(([left], [right]) => compareEncodedValues(left, right))
    .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(", ")}`;
}

function oauthPercentEncode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compareEncodedValues(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function credentialsFromEnvironment(environment: NodeJS.ProcessEnv): InstapaperCredentials {
  const status = getInstapaperConfigurationStatus(environment);

  if (!status.configured) {
    throw new InstapaperApiError({
      message: `Instapaper is not configured. Missing: ${status.missing.join(", ")}.`,
      kind: "configuration",
      endpoint: "",
      missingConfiguration: status.missing,
    });
  }

  return {
    consumerKey: environment[credentialEnvironmentNames.consumerKey]!.trim(),
    consumerSecret: environment[credentialEnvironmentNames.consumerSecret]!.trim(),
    accessToken: environment[credentialEnvironmentNames.accessToken]!.trim(),
    accessTokenSecret: environment[credentialEnvironmentNames.accessTokenSecret]!.trim(),
  };
}

function bookmarkListParameters(
  input: InstapaperBookmarkListInput,
  endpoint: string,
): Array<[string, string]> {
  const parameters: Array<[string, string]> = [];

  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new InstapaperApiError({
        message: "Instapaper bookmark limit must be an integer between 1 and 500.",
        kind: "configuration",
        endpoint,
      });
    }

    parameters.push(["limit", String(input.limit)]);
  }

  if (input.folderId !== undefined) {
    const folderId = String(input.folderId).trim();

    if (
      !["unread", "starred", "archive"].includes(folderId) &&
      !/^[1-9]\d*$/.test(folderId)
    ) {
      throw new InstapaperApiError({
        message: "Instapaper folderId must be unread, starred, archive, or a positive folder ID.",
        kind: "configuration",
        endpoint,
      });
    }

    parameters.push(["folder_id", folderId]);
  } else if (input.tag?.trim()) {
    parameters.push(["tag", input.tag.trim()]);
  }

  const have = joinedParameter(input.have, ",");
  const highlights = joinedParameter(input.highlights, "-");

  if (have) {
    parameters.push(["have", have]);
  }

  if (highlights) {
    parameters.push(["highlights", highlights]);
  }

  return parameters;
}

function joinedParameter(value: string | ReadonlyArray<number | string> | undefined, separator: string) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean).join(separator);
  }

  return typeof value === "string" ? value.trim() : "";
}

function standardArray(payload: unknown, endpoint: string) {
  if (!Array.isArray(payload)) {
    throw invalidResponseError(endpoint, "Instapaper did not return its standard response array.");
  }

  return payload;
}

function parseUser(value: unknown, endpoint: string): InstapaperUser {
  const record = requiredTypedRecord(value, "user", endpoint);

  return {
    type: "user",
    user_id: requiredNumber(record.user_id, "user_id", endpoint),
    username: requiredString(record.username, "username", endpoint),
    ...(typeof record.subscription_is_active === "string"
      ? { subscription_is_active: record.subscription_is_active }
      : {}),
  };
}

function parseFolder(value: unknown, endpoint: string): InstapaperFolder {
  const record = requiredTypedRecord(value, "folder", endpoint);

  return {
    type: "folder",
    folder_id: requiredNumber(record.folder_id, "folder_id", endpoint),
    title: requiredString(record.title, "title", endpoint),
    display_title: stringValue(record.display_title),
    slug: stringValue(record.slug),
    sync_to_mobile: numberValue(record.sync_to_mobile),
    position: numberValue(record.position),
    public: numberValue(record.public),
    count: numberValue(record.count),
  };
}

function parseBookmark(value: unknown, endpoint: string): InstapaperBookmark {
  const record = requiredTypedRecord(value, "bookmark", endpoint);

  return {
    type: "bookmark",
    bookmark_id: requiredNumber(record.bookmark_id, "bookmark_id", endpoint),
    url: requiredString(record.url, "url", endpoint),
    title: stringValue(record.title),
    description: stringValue(record.description),
    time: numberValue(record.time),
    starred: stringValue(record.starred),
    private_source: stringValue(record.private_source),
    hash: stringValue(record.hash),
    progress: numberValue(record.progress),
    progress_timestamp: numberValue(record.progress_timestamp),
    tags: arrayValue(record.tags).map((tag) => parseTag(tag, endpoint)),
  };
}

function parseTag(value: unknown, endpoint: string): InstapaperTag {
  const record = asRecord(value);

  if (!record) {
    throw invalidResponseError(endpoint, "Instapaper returned an invalid tag.");
  }

  return {
    id: requiredNumber(record.id, "tag.id", endpoint),
    name: requiredString(record.name, "tag.name", endpoint),
  };
}

function parseHighlight(value: unknown, endpoint: string): InstapaperHighlight {
  const record = requiredTypedRecord(value, "highlight", endpoint);

  return {
    type: "highlight",
    highlight_id: requiredNumber(record.highlight_id, "highlight_id", endpoint),
    bookmark_id: requiredNumber(record.bookmark_id, "bookmark_id", endpoint),
    text: stringValue(record.text),
    position: numberValue(record.position),
    time: numberValue(record.time),
    note: typeof record.note === "string" ? record.note : null,
  };
}

function parseDeleteId(value: unknown, endpoint: string) {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  throw invalidResponseError(endpoint, "Instapaper returned an invalid deleted bookmark ID.");
}

function requiredTypedRecord(value: unknown, type: string, endpoint: string) {
  const record = asRecord(value);

  if (!record || record.type !== type) {
    throw invalidResponseError(endpoint, `Instapaper returned an invalid ${type} object.`);
  }

  return record;
}

function isObjectWithType(type: string) {
  return (value: unknown) => asRecord(value)?.type === type;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredNumber(value: unknown, field: string, endpoint: string) {
  const parsed = parsedNumber(value);

  if (parsed === undefined) {
    throw invalidResponseError(endpoint, `Instapaper returned an invalid ${field}.`);
  }

  return parsed;
}

function requiredString(value: unknown, field: string, endpoint: string) {
  if (typeof value !== "string") {
    throw invalidResponseError(endpoint, `Instapaper returned an invalid ${field}.`);
  }

  return value;
}

function numberValue(value: unknown) {
  return parsedNumber(value) ?? 0;
}

function parsedNumber(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requiredPositiveInteger(value: number | string, field: string, endpoint: string) {
  const normalized = String(value).trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new InstapaperApiError({
      message: `${field} must be a positive integer.`,
      kind: "configuration",
      endpoint,
    });
  }

  return normalized;
}

function invalidResponseError(endpoint: string, apiMessage: string) {
  return new InstapaperApiError({
    message: "Instapaper returned an unexpected response.",
    kind: "invalid-response",
    endpoint,
    apiMessage,
  });
}

function apiResponseError(
  endpoint: string,
  status: number,
  apiError: { code?: number; message?: string },
  retryAfterMs?: number,
) {
  return new InstapaperApiError({
    message: apiError.code
      ? `Instapaper returned API error ${apiError.code}.`
      : "Instapaper returned an API error.",
    kind: "api",
    endpoint,
    status,
    apiCode: apiError.code,
    apiMessage: apiError.message,
    retryable:
      (apiError.code !== undefined && retryableApiCodes.has(apiError.code)) ||
      (apiError.code === undefined && retryableHttpStatus(status)),
    retryAfterMs,
  });
}

function apiErrorFromText(text: string) {
  const payload = parseJson(text);
  return payload === undefined ? null : apiErrorFromPayload(payload);
}

function apiErrorFromPayload(payload: unknown): { code?: number; message?: string } | null {
  const candidates = Array.isArray(payload) ? payload : [payload];

  for (const candidate of candidates) {
    const record = asRecord(candidate);

    if (!record || (record.type !== "error" && record.error_code === undefined)) {
      continue;
    }

    const code = parsedNumber(record.error_code);

    return {
      ...(code !== undefined && code > 0 ? { code } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    };
  }

  return null;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryableHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null, now: () => number) {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : undefined;
}

function retryDelay(
  dependencies: ClientDependencies,
  error: InstapaperApiError,
  attempt: number,
) {
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, dependencies.retry.maxDelayMs);
  }

  const exponential = Math.min(
    dependencies.retry.maxDelayMs,
    dependencies.retry.baseDelayMs * 2 ** (attempt - 1),
  );
  const random = Math.min(1, Math.max(0, dependencies.random()));
  return Math.round(exponential * (0.5 + random));
}

function normalizeRetryOptions(options: RetryOptions | undefined): RequiredRetryOptions {
  const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? 4));
  const baseDelayMs = Math.max(0, Math.floor(options?.baseDelayMs ?? 500));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options?.maxDelayMs ?? 8_000));

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
  };
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
