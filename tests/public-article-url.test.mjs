import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPublicResource,
  validatePublicArticleUrl,
} from "../src/server/security/publicArticleUrl.ts";

test("rejects local, private, mapped IPv6, and non-HTTP URLs before HTTP fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("HTTP fetch must not run for a rejected URL.");
  };

  try {
    const rejectedUrls = [
      "http://localhost/article",
      "http://reader.local/article",
      "http://service.internal/article",
      "http://127.0.0.1/article",
      "http://10.0.0.1/article",
      "http://172.16.0.1/article",
      "http://192.168.1.1/article",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/article",
      "http://[::1]/article",
      "http://[fc00::1]/article",
      "http://[fe80::1]/article",
      "http://[::ffff:127.0.0.1]/article",
      "http://[::ffff:10.0.0.1]/article",
      "file:///etc/passwd",
      "ftp://example.com/article",
      "data:text/html,private",
    ];

    for (const url of rejectedUrls) {
      await assert.rejects(
        () => fetchPublicResource(url),
        Error,
        `Expected ${url} to be rejected`,
      );
    }

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects embedded URL credentials during validation", async () => {
  await assert.rejects(
    () => validatePublicArticleUrl("https://user:password@example.com/article"),
    /embedded credentials/i,
  );
});

test("validates a redirect destination before issuing the next HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        location: "http://127.0.0.1/private",
      },
    });
  };

  try {
    await assert.rejects(
      () => fetchPublicResource("https://93.184.216.34/article"),
      /private-network article URLs/i,
    );
    assert.deepEqual(requestedUrls, ["https://93.184.216.34/article"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
