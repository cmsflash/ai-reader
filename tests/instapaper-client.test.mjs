import assert from "node:assert/strict";
import test from "node:test";
import {
  InstapaperApiError,
  createInstapaperClient,
  getInstapaperConfigurationStatus,
} from "../src/server/integrations/instapaperClient.ts";

const credentials = {
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-token-secret",
};

const fixedClock = {
  now: () => 1_700_000_000_000,
  nonce: () => "fixed-nonce",
};

test("reports configuration without exposing configured secret values", () => {
  const status = getInstapaperConfigurationStatus({
    INSTAPAPER_CONSUMER_KEY: "present-consumer",
    INSTAPAPER_CONSUMER_SECRET: "present-secret",
    INSTAPAPER_ACCESS_TOKEN: "",
  });

  assert.deepEqual(status, {
    configured: false,
    missing: ["INSTAPAPER_ACCESS_TOKEN", "INSTAPAPER_ACCESS_TOKEN_SECRET"],
  });
  assert.equal(JSON.stringify(status).includes("present-secret"), false);
});

test("constructs the official OAuth 1 HMAC-SHA1 signature including POST fields", async () => {
  let capturedUrl;
  let capturedInit;
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(bookmarkListPayload);
    },
  });

  await client.listBookmarks({
    limit: 500,
    folderId: "archive",
    have: ["1:abc", "2:def"],
  });

  assert.equal(
    capturedUrl,
    "https://www.instapaper.com/api/1/bookmarks/list",
  );
  assert.equal(capturedInit.method, "POST");
  assert.equal(
    capturedInit.body,
    "limit=500&folder_id=archive&have=1%3Aabc%2C2%3Adef",
  );

  const headers = new Headers(capturedInit.headers);
  assert.equal(
    headers.get("authorization"),
    [
      "OAuth oauth_consumer_key=\"consumer-key\"",
      "oauth_nonce=\"fixed-nonce\"",
      "oauth_signature=\"KOh53y7sSY%2FznN08hxcVA0IoS5s%3D\"",
      "oauth_signature_method=\"HMAC-SHA1\"",
      "oauth_timestamp=\"1700000000\"",
      "oauth_token=\"access-token\"",
      "oauth_version=\"1.0\"",
    ].join(", "),
  );
  assert.equal(
    headers.get("content-type"),
    "application/x-www-form-urlencoded; charset=UTF-8",
  );
});

test("parses verify-credentials, folder, bookmark, highlight, and text responses", async () => {
  const responses = new Map([
    [
      "/account/verify_credentials",
      jsonResponse([
        {
          type: "user",
          user_id: 42,
          username: "reader@example.com",
          subscription_is_active: "1",
        },
      ]),
    ],
    [
      "/folders/list",
      jsonResponse([
        { type: "meta", count: 1 },
        {
          type: "folder",
          folder_id: 7,
          title: "Long reads",
          display_title: "Long reads",
          slug: "long-reads",
          sync_to_mobile: 1,
          position: 2,
          public: 0,
          count: 9,
        },
      ]),
    ],
    ["/bookmarks/list", jsonResponse(bookmarkListPayload)],
    [
      "/bookmarks/get_text",
      new Response("<article><p>Processed text</p></article>", {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
    ],
  ]);
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    fetch: async (url) => {
      const response = responses.get(new URL(url).pathname.replace("/api/1", ""));
      assert.ok(response, `Unexpected endpoint: ${url}`);
      return response.clone();
    },
  });

  assert.deepEqual(await client.verifyCredentials(), {
    type: "user",
    user_id: 42,
    username: "reader@example.com",
    subscription_is_active: "1",
  });
  assert.deepEqual(await client.listFolders(), [
    {
      type: "folder",
      folder_id: 7,
      title: "Long reads",
      display_title: "Long reads",
      slug: "long-reads",
      sync_to_mobile: 1,
      position: 2,
      public: 0,
      count: 9,
    },
  ]);

  const listed = await client.listBookmarks();
  assert.equal(listed.user.user_id, 42);
  assert.equal(listed.bookmarks[0].bookmark_id, 1234);
  assert.deepEqual(listed.bookmarks[0].tags, [{ id: 12, name: "research" }]);
  assert.equal(listed.highlights[0].text, "Important sentence");
  assert.deepEqual(listed.delete_ids, [91, "92"]);
  assert.equal(
    await client.getText(1234),
    "<article><p>Processed text</p></article>",
  );
});

test("backs off and retries a documented API rate-limit error", async () => {
  let attempts = 0;
  const delays = [];
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    retry: {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    },
    random: () => 0.5,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetch: async () => {
      attempts += 1;

      if (attempts === 1) {
        return jsonResponse(
          [{ type: "error", error_code: 1040, message: "Rate-limit exceeded." }],
          400,
        );
      }

      return jsonResponse([]);
    },
  });

  assert.deepEqual(await client.listFolders(), []);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [100]);
});

test("returns structured non-retryable get-text failures without leaking credentials", async () => {
  let attempts = 0;
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    fetch: async () => {
      attempts += 1;
      return jsonResponse(
        [{ type: "error", error_code: 1550, message: "Could not generate text." }],
        400,
      );
    },
  });

  await assert.rejects(
    () => client.getText(1234),
    (error) => {
      assert.ok(error instanceof InstapaperApiError);
      assert.equal(error.kind, "api");
      assert.equal(error.status, 400);
      assert.equal(error.apiCode, 1550);
      assert.equal(error.apiMessage, "Could not generate text.");
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.message.includes(credentials.consumerSecret), false);
      assert.equal(error.message.includes(credentials.accessTokenSecret), false);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("aborts fetches and response-body reads after the configured timeout", async () => {
  const observedSignals = [];
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    requestTimeoutMs: 10,
    retry: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    },
    sleep: async () => {},
    fetch: async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      observedSignals.push(signal);

      if (observedSignals.length === 2) {
        return new Response(
          new ReadableStream({
            start() {},
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Promise((_resolve, reject) => {
        const rejectForAbort = () => {
          reject(signal.reason ?? new Error("aborted"));
        };

        if (signal.aborted) {
          rejectForAbort();
        } else {
          signal.addEventListener("abort", rejectForAbort, { once: true });
        }
      });
    },
  });

  await assert.rejects(
    () => client.listFolders(),
    (error) => {
      assert.ok(error instanceof InstapaperApiError);
      assert.equal(error.kind, "network");
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 2);
      assert.equal(error.message, "The Instapaper request timed out.");
      assert.equal(error.message.includes(credentials.consumerSecret), false);
      assert.equal(error.message.includes(credentials.accessTokenSecret), false);
      return true;
    },
  );
  assert.equal(observedSignals.length, 2);
  assert.equal(observedSignals.every((signal) => signal.aborted), true);
});

test("stops reading response bodies at the configured byte limit", async () => {
  const encoder = new TextEncoder();
  const secretBody = `<article>${credentials.consumerSecret.repeat(8)}</article>`;
  const encodedBody = encoder.encode(secretBody);
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    maxResponseBytes: 32,
    retry: { maxAttempts: 1 },
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encodedBody.subarray(0, 24));
            controller.enqueue(encodedBody.subarray(24));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        },
      ),
  });

  await assert.rejects(
    () => client.getText(1234),
    (error) => {
      assert.ok(error instanceof InstapaperApiError);
      assert.equal(error.kind, "invalid-response");
      assert.equal(error.status, 200);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.message, "The Instapaper response exceeded the allowed size.");
      assert.equal(error.message.includes(credentials.consumerSecret), false);
      return true;
    },
  );
});

test("recognizes a JSON API error returned with HTTP 200 from get-text", async () => {
  const client = createInstapaperClient({
    credentials,
    ...fixedClock,
    retry: { maxAttempts: 1 },
    fetch: async () =>
      jsonResponse([
        {
          type: "error",
          error_code: 1550,
          message: "Could not generate text.",
        },
      ]),
  });

  await assert.rejects(
    () => client.getText(1234),
    (error) => {
      assert.ok(error instanceof InstapaperApiError);
      assert.equal(error.kind, "api");
      assert.equal(error.status, 200);
      assert.equal(error.apiCode, 1550);
      assert.equal(error.apiMessage, "Could not generate text.");
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.message.includes(credentials.consumerSecret), false);
      assert.equal(error.message.includes(credentials.accessTokenSecret), false);
      return true;
    },
  );
});

test("rejects empty and clearly non-HTML get-text responses", async () => {
  const cases = [
    new Response("   ", {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
    }),
    new Response("<article>Mislabelled HTML</article>", {
      status: 200,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    }),
    new Response(`plain text ${credentials.consumerSecret}`, {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
    }),
  ];

  for (const response of cases) {
    const client = createInstapaperClient({
      credentials,
      ...fixedClock,
      retry: { maxAttempts: 1 },
      fetch: async () => response.clone(),
    });

    await assert.rejects(
      () => client.getText(1234),
      (error) => {
        assert.ok(error instanceof InstapaperApiError);
        assert.equal(error.kind, "invalid-response");
        assert.equal(error.status, 200);
        assert.equal(error.retryable, false);
        assert.equal(error.attempts, 1);
        assert.equal(error.message, "Instapaper returned an unexpected get_text response.");
        assert.equal(error.message.includes(credentials.consumerSecret), false);
        assert.equal(error.apiMessage.includes(credentials.consumerSecret), false);
        return true;
      },
    );
  }
});

const bookmarkListPayload = {
  user: {
    type: "user",
    user_id: 42,
    username: "reader@example.com",
    subscription_is_active: "1",
  },
  bookmarks: [
    {
      type: "bookmark",
      bookmark_id: 1234,
      url: "https://example.com/article",
      title: "Example article",
      description: "A description.",
      time: 1_701_234_567,
      starred: "1",
      private_source: "",
      hash: "OjMuzFp6",
      progress: 0.5,
      progress_timestamp: 1_701_234_999,
      tags: [{ id: 12, name: "research" }],
    },
  ],
  highlights: [
    {
      type: "highlight",
      highlight_id: 55,
      bookmark_id: 1234,
      text: "Important sentence",
      position: 0,
      time: 1_701_234_888,
      note: null,
    },
  ],
  delete_ids: [91, "92"],
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
