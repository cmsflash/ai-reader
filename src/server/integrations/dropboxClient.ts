export const DROPBOX_ATVOICE_FOLDER = "/Apps/@Voice";

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_LIST_FOLDER_URL =
  "https://api.dropboxapi.com/2/files/list_folder";
const DROPBOX_LIST_FOLDER_CONTINUE_URL =
  "https://api.dropboxapi.com/2/files/list_folder/continue";
const DROPBOX_DOWNLOAD_URL =
  "https://content.dropboxapi.com/2/files/download";
const TOKEN_REFRESH_SAFETY_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 4 * 60 * 60 * 1_000;

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
  now?: () => number;
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
  const now = options.now ?? Date.now;
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
    const response = await authorizedRequest(DROPBOX_DOWNLOAD_URL, {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": encodeDropboxApiArgument({ path: reference }),
      },
    });

    return new Uint8Array(await response.arrayBuffer());
  }

  async function authorizedJsonRequest<T>(
    url: string,
    body: Record<string, unknown>,
  ) {
    const response = await authorizedRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();

    if (!isListFolderPage(payload)) {
      throw new DropboxClientError(
        "Dropbox returned an invalid list-folder response.",
      );
    }

    return payload as T;
  }

  async function authorizedRequest(url: string, init: RequestInit) {
    let accessToken = await getAccessToken();
    let response = await performRequest(url, init, accessToken);

    if (response.status === 401) {
      cachedToken = null;
      accessToken = await getAccessToken();
      response = await performRequest(url, init, accessToken);
    }

    if (!response.ok) {
      throw await dropboxResponseError(response, url);
    }

    return response;
  }

  async function performRequest(
    url: string,
    init: RequestInit,
    accessToken: string,
  ) {
    try {
      return await requireFetch(fetchImpl)(url, {
        ...init,
        headers: {
          ...headersToObject(init.headers),
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (error) {
      throw new DropboxClientError("Could not reach the Dropbox API.", {
        cause: error,
      });
    }
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
    let response: Response;

    try {
      response = await requireFetch(fetchImpl)(DROPBOX_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
    } catch (error) {
      throw new DropboxClientError(
        "Could not exchange the Dropbox refresh token.",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw await dropboxResponseError(response, DROPBOX_TOKEN_URL);
    }

    const payload: unknown = await response.json();

    if (!isRecord(payload) || typeof payload.access_token !== "string") {
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
  }

  return {
    status,
    downloadFile,
    listAtVoiceFiles,
  };
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
