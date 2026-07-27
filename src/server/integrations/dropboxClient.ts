export const DROPBOX_ATVOICE_FOLDER = "/Apps/@Voice";
export const DEFAULT_DROPBOX_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_DROPBOX_REQUEST_TIMEOUT_MS = 15_000;

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_LIST_FOLDER_URL =
  "https://api.dropboxapi.com/2/files/list_folder";
const DROPBOX_LIST_FOLDER_CONTINUE_URL =
  "https://api.dropboxapi.com/2/files/list_folder/continue";
const DROPBOX_DOWNLOAD_URL =
  "https://content.dropboxapi.com/2/files/download";
const TOKEN_REFRESH_SAFETY_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const DROPBOX_ENVIRONMENT_VARIABLES = [
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
] as const;

type DropboxEnvironmentVariable =
  (typeof DROPBOX_ENVIRONMENT_VARIABLES)[number];

type DropboxCredentials = Record<DropboxEnvironmentVariable, string>;

type CachedAccessToken = {
  accessToken: string;
  refreshAt: number;
};

type DropboxRequestAttempt<T> =
  | {
      kind: "retry-with-fresh-token";
    }
  | {
      kind: "success";
      value: T;
    };

type DropboxListFolderPage = {
  cursor: string;
  entries: DropboxEntry[];
  has_more: boolean;
};

export type DropboxConfiguredStatus = {
  configured: boolean;
  missingVariables: DropboxEnvironmentVariable[];
};

export type DropboxFileMetadata = {
  ".tag": "file";
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  content_hash?: string;
  is_downloadable?: boolean;
};

export type DropboxFolderMetadata = {
  ".tag": "folder";
  id: string;
  name: string;
  path_display?: string;
  path_lower?: string;
};

export type DropboxDeletedMetadata = {
  ".tag": "deleted";
  name: string;
  path_display?: string;
  path_lower?: string;
};

export type DropboxEntry =
  | DropboxFileMetadata
  | DropboxFolderMetadata
  | DropboxDeletedMetadata;

export type DropboxReadClient = {
  readonly status: DropboxConfiguredStatus;
  downloadFile(pathOrId: string): Promise<Uint8Array>;
  listAtVoiceFiles(): Promise<DropboxFileMetadata[]>;
};

export type DropboxReadClientOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  maxDownloadBytes?: number;
  now?: () => number;
  requestTimeoutMs?: number;
};

export class DropboxClientError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DropboxClientError";
    this.status = options?.status;
  }
}

export function getDropboxConfiguredStatus(
  env: NodeJS.ProcessEnv = process.env,
): DropboxConfiguredStatus {
  const missingVariables = DROPBOX_ENVIRONMENT_VARIABLES.filter(
    (name) => !env[name]?.trim(),
  );

  return {
    configured: missingVariables.length === 0,
    missingVariables,
  };
}

export function createDropboxReadClient(
  options: DropboxReadClientOptions = {},
): DropboxReadClient {
  const env = options.env ?? process.env;
  const status = getDropboxConfiguredStatus(env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxDownloadBytes = positiveIntegerOption(
    options.maxDownloadBytes,
    DEFAULT_DROPBOX_MAX_DOWNLOAD_BYTES,
    "Dropbox maximum download size",
  );
  const now = options.now ?? Date.now;
  const requestTimeoutMs = positiveIntegerOption(
    options.requestTimeoutMs,
    DEFAULT_DROPBOX_REQUEST_TIMEOUT_MS,
    "Dropbox request timeout",
    MAX_TIMER_DELAY_MS,
  );
  let cachedToken: CachedAccessToken | null = null;
  let refreshInFlight: Promise<CachedAccessToken> | null = null;

  async function listAtVoiceFiles() {
    const entries: DropboxEntry[] = [];
    const seenCursors = new Set<string>();
    let page = await authorizedJsonRequest<DropboxListFolderPage>(
      DROPBOX_LIST_FOLDER_URL,
      {
        path: DROPBOX_ATVOICE_FOLDER,
        recursive: true,
        include_deleted: false,
        include_non_downloadable_files: false,
      },
    );

    entries.push(...page.entries);

    while (page.has_more) {
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new DropboxClientError(
          "Dropbox returned an invalid or repeated list-folder cursor.",
        );
      }

      seenCursors.add(page.cursor);
      page = await authorizedJsonRequest<DropboxListFolderPage>(
        DROPBOX_LIST_FOLDER_CONTINUE_URL,
        { cursor: page.cursor },
      );
      entries.push(...page.entries);
    }

    return entries.filter(isDropboxFile);
  }

  async function downloadFile(pathOrId: string) {
    const reference = normalizeDownloadReference(pathOrId);
    return authorizedRequest(
      DROPBOX_DOWNLOAD_URL,
      {
        method: "POST",
        headers: {
          "Dropbox-API-Arg": encodeDropboxApiArgument({ path: reference }),
        },
      },
      (response) => readDropboxDownload(response, maxDownloadBytes),
    );
  }

  async function authorizedJsonRequest<T>(
    url: string,
    body: Record<string, unknown>,
  ) {
    return authorizedRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      },
      async (response) => {
        const payload: unknown = await response.json();

        if (!isListFolderPage(payload)) {
          throw new DropboxClientError(
            "Dropbox returned an invalid list-folder response.",
          );
        }

        return payload as T;
      },
    );
  }

  async function authorizedRequest<T>(
    url: string,
    init: RequestInit,
    readResponse: (response: Response) => Promise<T>,
  ): Promise<T> {
    let accessToken = await getAccessToken();
    let attempt = await performRequest(
      url,
      init,
      accessToken,
      readResponse,
      true,
    );

    if (attempt.kind === "retry-with-fresh-token") {
      cachedToken = null;
      accessToken = await getAccessToken();
      attempt = await performRequest(
        url,
        init,
        accessToken,
        readResponse,
        false,
      );
    }

    if (attempt.kind === "retry-with-fresh-token") {
      throw new DropboxClientError(
        "Dropbox rejected a freshly refreshed access token.",
        { status: 401 },
      );
    }

    return attempt.value;
  }

  async function performRequest<T>(
    url: string,
    init: RequestInit,
    accessToken: string,
    readResponse: (response: Response) => Promise<T>,
    retryUnexpectedUnauthorized: boolean,
  ): Promise<DropboxRequestAttempt<T>> {
    return timedFetch<DropboxRequestAttempt<T>>(
      url,
      {
        ...init,
        headers: {
          ...headersToObject(init.headers),
          Authorization: `Bearer ${accessToken}`,
        },
      },
      async (response) => {
        if (response.status === 401 && retryUnexpectedUnauthorized) {
          await cancelResponseBody(response);
          return { kind: "retry-with-fresh-token" };
        }

        if (!response.ok) {
          throw await dropboxResponseError(response, url);
        }

        return {
          kind: "success",
          value: await readResponse(response),
        };
      },
      {
        networkMessage: "Could not reach the Dropbox API.",
        timeoutMessage: "Dropbox API request timed out.",
      },
    );
  }

  async function getAccessToken() {
    if (cachedToken && now() < cachedToken.refreshAt) {
      return cachedToken.accessToken;
    }

    if (!refreshInFlight) {
      refreshInFlight = refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }

    cachedToken = await refreshInFlight;
    return cachedToken.accessToken;
  }

  async function refreshAccessToken(): Promise<CachedAccessToken> {
    const credentials = readCredentials(env, status);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.DROPBOX_REFRESH_TOKEN,
      client_id: credentials.DROPBOX_APP_KEY,
      client_secret: credentials.DROPBOX_APP_SECRET,
    });
    return timedFetch(
      DROPBOX_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
      async (response) => {
        if (!response.ok) {
          throw await dropboxResponseError(response, DROPBOX_TOKEN_URL);
        }

        const payload: unknown = await response.json();

        if (
          !isRecord(payload) ||
          typeof payload.access_token !== "string" ||
          !payload.access_token.trim()
        ) {
          throw new DropboxClientError(
            "Dropbox returned an invalid access-token response.",
          );
        }

        const issuedAt = now();
        const lifetimeMs =
          typeof payload.expires_in === "number" && payload.expires_in > 0
            ? payload.expires_in * 1_000
            : DEFAULT_TOKEN_LIFETIME_MS;
        const safetyMs = Math.min(TOKEN_REFRESH_SAFETY_MS, lifetimeMs / 2);

        return {
          accessToken: payload.access_token,
          refreshAt: issuedAt + lifetimeMs - safetyMs,
        };
      },
      {
        networkMessage: "Could not exchange the Dropbox refresh token.",
        timeoutMessage: "Dropbox token exchange timed out.",
      },
    );
  }

  async function timedFetch<T>(
    url: string,
    init: RequestInit,
    readResponse: (response: Response) => Promise<T>,
    messages: {
      networkMessage: string;
      timeoutMessage: string;
    },
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      let response: Response;

      try {
        response = await requireFetch(fetchImpl)(url, {
          ...init,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DropboxClientError) {
          throw error;
        }

        if (controller.signal.aborted) {
          throw new DropboxClientError(
            `${messages.timeoutMessage} Limit: ${requestTimeoutMs} ms.`,
            { cause: error },
          );
        }

        throw new DropboxClientError(messages.networkMessage, {
          cause: error,
        });
      }

      try {
        return await readResponse(response);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new DropboxClientError(
            `${messages.timeoutMessage} Limit: ${requestTimeoutMs} ms.`,
            { cause: error },
          );
        }

        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    status,
    downloadFile,
    listAtVoiceFiles,
  };
}

async function readDropboxDownload(response: Response, maxBytes: number) {
  const declaredLength = response.headers.get("content-length")?.trim();

  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);

    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await cancelResponseBody(response);
      throw downloadTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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

        throw downloadTooLargeError(maxBytes);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // A response that is already closed or locked needs no further cleanup.
  }
}

function downloadTooLargeError(maxBytes: number) {
  return new DropboxClientError(
    `Dropbox file exceeds the configured ${maxBytes}-byte download limit.`,
  );
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const normalized = value ?? fallback;

  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > maximum
  ) {
    throw new DropboxClientError(
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }

  return normalized;
}

function readCredentials(
  env: NodeJS.ProcessEnv,
  status: DropboxConfiguredStatus,
): DropboxCredentials {
  if (!status.configured) {
    throw new DropboxClientError(
      `Dropbox is not configured. Missing: ${status.missingVariables.join(", ")}.`,
    );
  }

  return {
    DROPBOX_APP_KEY: env.DROPBOX_APP_KEY!.trim(),
    DROPBOX_APP_SECRET: env.DROPBOX_APP_SECRET!.trim(),
    DROPBOX_REFRESH_TOKEN: env.DROPBOX_REFRESH_TOKEN!.trim(),
  };
}

function requireFetch(fetchImpl?: typeof globalThis.fetch) {
  if (!fetchImpl) {
    throw new DropboxClientError(
      "Dropbox requires a runtime with the Fetch API.",
    );
  }

  return fetchImpl;
}

function headersToObject(headers?: HeadersInit) {
  return headers ? Object.fromEntries(new Headers(headers).entries()) : {};
}

function normalizeDownloadReference(pathOrId: string) {
  const reference = pathOrId.trim();

  if (
    !reference ||
    (!reference.startsWith("/") && !reference.startsWith("id:"))
  ) {
    throw new DropboxClientError(
      "Dropbox download reference must be an absolute path or an id: reference.",
    );
  }

  return reference;
}

function encodeDropboxApiArgument(argument: Record<string, unknown>) {
  return JSON.stringify(argument).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function isDropboxFile(entry: DropboxEntry): entry is DropboxFileMetadata {
  return entry[".tag"] === "file";
}

function isListFolderPage(value: unknown): value is DropboxListFolderPage {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isDropboxEntry) &&
    typeof value.cursor === "string" &&
    typeof value.has_more === "boolean"
  );
}

function isDropboxEntry(value: unknown): value is DropboxEntry {
  if (!isRecord(value) || typeof value[".tag"] !== "string") {
    return false;
  }

  if (value[".tag"] === "file" || value[".tag"] === "folder") {
    return (
      typeof value.id === "string" &&
      typeof value.name === "string"
    );
  }

  return value[".tag"] === "deleted" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function dropboxResponseError(response: Response, url: string) {
  const responseText = await response.text().catch(() => "");
  let detail = responseText.trim();

  if (detail) {
    try {
      const payload: unknown = JSON.parse(detail);

      if (isRecord(payload)) {
        detail =
          stringValue(payload.error_summary) ??
          stringValue(payload.error_description) ??
          stringValue(payload.error) ??
          detail;
      }
    } catch {
      // Keep the plain response text.
    }
  }

  const operation = url === DROPBOX_TOKEN_URL ? "token exchange" : "API request";
  const suffix = detail ? `: ${detail.slice(0, 500)}` : "";

  return new DropboxClientError(
    `Dropbox ${operation} failed with status ${response.status}${suffix}`,
    { status: response.status },
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
