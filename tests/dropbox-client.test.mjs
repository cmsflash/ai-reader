import assert from "node:assert/strict";
import test from "node:test";
import {
  createDropboxReadClient,
  DropboxClientError,
  getDropboxConfiguredStatus,
} from "../src/server/integrations/dropboxClient.ts";

const configuredEnv = {
  DROPBOX_APP_KEY: "app-key",
  DROPBOX_APP_SECRET: "app-secret",
  DROPBOX_REFRESH_TOKEN: "refresh-token",
};

test("reports configuration without exposing credential values", () => {
  assert.deepEqual(getDropboxConfiguredStatus({}), {
    configured: false,
    missingVariables: [
      "DROPBOX_APP_KEY",
      "DROPBOX_APP_SECRET",
      "DROPBOX_REFRESH_TOKEN",
    ],
  });
  assert.deepEqual(getDropboxConfiguredStatus(configuredEnv), {
    configured: true,
    missingVariables: [],
  });
});

test("refreshes an access token, lists every page recursively, and downloads by id", async () => {
  const requests = [];
  const fakeFetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });

    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({
        access_token: "short-lived-token",
        expires_in: 3600,
        token_type: "bearer",
      });
    }

    if (url.endsWith("/files/list_folder")) {
      return jsonResponse({
        entries: [
          fileEntry("id:first", "First.mhtml.zip"),
          {
            ".tag": "folder",
            id: "id:folder",
            name: "instantOpen",
            path_display: "/Apps/@Voice/instantOpen",
          },
        ],
        cursor: "cursor-1",
        has_more: true,
      });
    }

    if (url.endsWith("/files/list_folder/continue")) {
      return jsonResponse({
        entries: [fileEntry("id:second", "Second.txt")],
        cursor: "cursor-2",
        has_more: false,
      });
    }

    if (url.endsWith("/files/download")) {
      return new Response(Uint8Array.from([1, 2, 3, 255]));
    }

    throw new Error(`Unexpected request: ${url}`);
  };
  const client = createDropboxReadClient({
    env: configuredEnv,
    fetch: fakeFetch,
    now: () => 10_000,
  });

  const files = await client.listAtVoiceFiles();
  const bytes = await client.downloadFile(files[0].id);

  assert.deepEqual(
    files.map(({ id, name }) => ({ id, name })),
    [
      { id: "id:first", name: "First.mhtml.zip" },
      { id: "id:second", name: "Second.txt" },
    ],
  );
  assert.deepEqual([...bytes], [1, 2, 3, 255]);
  assert.equal(
    requests.filter(({ url }) => url.endsWith("/oauth2/token")).length,
    1,
  );

  const tokenRequest = requests[0];
  const tokenForm = new URLSearchParams(tokenRequest.init.body);
  assert.equal(tokenRequest.init.method, "POST");
  assert.equal(tokenForm.get("grant_type"), "refresh_token");
  assert.equal(tokenForm.get("refresh_token"), "refresh-token");
  assert.equal(tokenForm.get("client_id"), "app-key");
  assert.equal(tokenForm.get("client_secret"), "app-secret");

  const initialListRequest = requests[1];
  assert.deepEqual(JSON.parse(initialListRequest.init.body), {
    path: "/Apps/@Voice",
    recursive: true,
    include_deleted: false,
    include_non_downloadable_files: false,
  });
  assert.equal(
    new Headers(initialListRequest.init.headers).get("authorization"),
    "Bearer short-lived-token",
  );

  const continuationRequest = requests[2];
  assert.deepEqual(JSON.parse(continuationRequest.init.body), {
    cursor: "cursor-1",
  });

  const downloadRequest = requests[3];
  assert.deepEqual(
    JSON.parse(
      new Headers(downloadRequest.init.headers).get("dropbox-api-arg"),
    ),
    { path: "id:first" },
  );
  assert.equal(downloadRequest.init.body, undefined);
});

test("refreshes cached tokens before expiry according to the injected clock", async () => {
  let now = 0;
  let tokenNumber = 0;
  const authorizations = [];
  const fakeFetch = async (url, init = {}) => {
    if (url.endsWith("/oauth2/token")) {
      tokenNumber += 1;
      return jsonResponse({
        access_token: `token-${tokenNumber}`,
        expires_in: 120,
      });
    }

    authorizations.push(new Headers(init.headers).get("authorization"));
    return new Response(Uint8Array.from([tokenNumber]));
  };
  const client = createDropboxReadClient({
    env: configuredEnv,
    fetch: fakeFetch,
    now: () => now,
  });

  assert.deepEqual([...await client.downloadFile("/Apps/@Voice/one.txt")], [1]);
  now = 59_000;
  assert.deepEqual([...await client.downloadFile("id:two")], [1]);
  now = 61_000;
  assert.deepEqual([...await client.downloadFile("id:three")], [2]);

  assert.equal(tokenNumber, 2);
  assert.deepEqual(authorizations, [
    "Bearer token-1",
    "Bearer token-1",
    "Bearer token-2",
  ]);
});

test("refreshes once and retries an API request after an unexpected 401", async () => {
  let tokenNumber = 0;
  let listRequests = 0;
  const fakeFetch = async (url, init = {}) => {
    if (url.endsWith("/oauth2/token")) {
      tokenNumber += 1;
      return jsonResponse({
        access_token: `token-${tokenNumber}`,
        expires_in: 3600,
      });
    }

    listRequests += 1;
    const authorization = new Headers(init.headers).get("authorization");

    if (listRequests === 1) {
      assert.equal(authorization, "Bearer token-1");
      return jsonResponse({ error_summary: "expired_access_token/" }, 401);
    }

    assert.equal(authorization, "Bearer token-2");
    return jsonResponse({
      entries: [],
      cursor: "cursor",
      has_more: false,
    });
  };
  const client = createDropboxReadClient({
    env: configuredEnv,
    fetch: fakeFetch,
    now: () => 0,
  });

  assert.deepEqual(await client.listAtVoiceFiles(), []);
  assert.equal(tokenNumber, 2);
  assert.equal(listRequests, 2);
});

test("fails safely when configuration or download references are invalid", async () => {
  let fetchCalled = false;
  const client = createDropboxReadClient({
    env: {},
    fetch: async () => {
      fetchCalled = true;
      return new Response();
    },
  });

  await assert.rejects(
    () => client.listAtVoiceFiles(),
    (error) =>
      error instanceof DropboxClientError &&
      /DROPBOX_APP_KEY/.test(error.message),
  );
  await assert.rejects(
    () => client.downloadFile("relative/path.txt"),
    /absolute path or an id:/i,
  );
  assert.equal(fetchCalled, false);
});

function fileEntry(id, name) {
  return {
    ".tag": "file",
    id,
    name,
    path_display: `/Apps/@Voice/${name}`,
    path_lower: `/apps/@voice/${name.toLowerCase()}`,
    rev: `rev-${id}`,
    size: 100,
    is_downloadable: true,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
