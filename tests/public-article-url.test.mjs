import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPublicImageResource,
  fetchPublicResource,
  readResponseBodyWithLimit,
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

test("validates archived image URLs and redirects before fetching private networks", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        location: "http://169.254.169.254/latest/meta-data/",
      },
    });
  };

  try {
    await assert.rejects(
      () =>
        fetchPublicImageResource(
          "https://93.184.216.34/image.png",
          {},
          1024,
        ),
      /private-network article URLs/i,
    );
    assert.deepEqual(requestedUrls, ["https://93.184.216.34/image.png"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an oversized declared body before acquiring a stream reader", async () => {
  let cancelCalls = 0;
  let getReaderCalls = 0;
  const response = {
    headers: new Headers({
      "content-length": "6",
    }),
    body: {
      async cancel() {
        cancelCalls += 1;
      },
      getReader() {
        getReaderCalls += 1;
        throw new Error("The stream reader must not be acquired.");
      },
    },
  };

  await assert.rejects(
    () => readResponseBodyWithLimit(response, 5),
    /exceeds the 5-byte archive limit/i,
  );
  assert.equal(getReaderCalls, 0);
  assert.equal(cancelCalls, 1);
});

test("cancels a streamed body as soon as it crosses the archive limit", async () => {
  let cancelCalls = 0;
  let releaseCalls = 0;
  let readCalls = 0;
  const chunks = [
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([4, 5, 6]),
  ];
  const response = {
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks[readCalls];
            readCalls += 1;
            return value ? { done: false, value } : { done: true };
          },
          async cancel() {
            cancelCalls += 1;
          },
          releaseLock() {
            releaseCalls += 1;
          },
        };
      },
    },
  };

  await assert.rejects(
    () => readResponseBodyWithLimit(response, 5),
    /exceeds the 5-byte archive limit/i,
  );
  assert.equal(readCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("returns a validated image body when it remains within the archive limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: {
        "content-length": "4",
        "content-type": "image/png",
      },
    });
  };

  try {
    const resource = await fetchPublicImageResource(
      "https://93.184.216.34/image.png",
      {},
      4,
    );

    assert.equal(resource?.contentType, "image/png");
    assert.equal(resource?.url.href, "https://93.184.216.34/image.png");
    assert.deepEqual(resource?.body, Buffer.from([1, 2, 3, 4]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buffers an image body when it remains within the archive limit", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3, 4]), {
    headers: {
      "content-length": "4",
    },
  });

  const body = await readResponseBodyWithLimit(response, 4);
  assert.deepEqual(body, Buffer.from([1, 2, 3, 4]));
});
