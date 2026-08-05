import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createPublicAddressLookup,
  createPublicResourceDispatcher,
  fetchPublicImageResource,
  fetchPublicResource,
  readResponseBodyWithLimit,
  validatePublicArticleUrl,
} from "../src/server/security/publicArticleUrl.ts";

test("rejects local, private, mapped IPv6, and non-HTTP URLs before HTTP fetch", async () => {
  let fetchCalls = 0;
  const request = async () => {
    fetchCalls += 1;
    throw new Error("HTTP fetch must not run for a rejected URL.");
  };

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
    "http://192.0.2.1/article",
    "http://[::1]/article",
    "http://[fc00::1]/article",
    "http://[fe80::1]/article",
    "http://[ff02::1]/article",
    "http://[2001:db8::1]/article",
    "http://[64:ff9b::7f00:1]/article",
    "http://[::ffff:127.0.0.1]/article",
    "http://[::ffff:10.0.0.1]/article",
    "file:///etc/passwd",
    "ftp://example.com/article",
    "data:text/html,private",
  ];

  for (const url of rejectedUrls) {
    await assert.rejects(
      () => fetchPublicResource(url, {}, 5, { request }),
      Error,
      `Expected ${url} to be rejected`,
    );
  }

  assert.equal(fetchCalls, 0);
});

test("rejects embedded URL credentials during validation", async () => {
  await assert.rejects(
    () => validatePublicArticleUrl("https://user:password@example.com/article"),
    /embedded credentials/i,
  );
});

test("validates a redirect destination before issuing the next HTTP request", async () => {
  const requestedUrls = [];
  const request = async (input, init) => {
    requestedUrls.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        location: "http://127.0.0.1/private",
      },
    });
  };

  await assert.rejects(
    () =>
      fetchPublicResource("https://93.184.216.34/article", {}, 5, {
        request,
      }),
    /private-network article URLs/i,
  );
  assert.deepEqual(requestedUrls, ["https://93.184.216.34/article"]);
});

test("validates archived image URLs and redirects before fetching private networks", async () => {
  const requestedUrls = [];
  const request = async (input, init) => {
    requestedUrls.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: {
        location: "http://169.254.169.254/latest/meta-data/",
      },
    });
  };

  await assert.rejects(
    () =>
      fetchPublicImageResource(
        "https://93.184.216.34/image.png",
        {},
        1024,
        { request },
      ),
    /private-network article URLs/i,
  );
  assert.deepEqual(requestedUrls, ["https://93.184.216.34/image.png"]);
});

test("blocks DNS rebinding at the connection lookup before reaching a private server", async (t) => {
  let serverHits = 0;
  const server = createServer((_request, response) => {
    serverHits += 1;
    response.end("private");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress === "object");

  let resolveCalls = 0;
  const resolveAddresses = async () => {
    resolveCalls += 1;
    return resolveCalls === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  const dispatcher = createPublicResourceDispatcher(resolveAddresses);

  t.after(() => dispatcher.close());

  await assert.rejects(
    () =>
      fetchPublicResource(
        `http://rebind.example:${serverAddress.port}/article`,
        {},
        0,
        {
          dispatcher,
          resolveAddresses,
        },
      ),
    (error) => {
      assert.match(
        String(error?.cause?.message ?? error?.message),
        /private network/i,
      );
      return true;
    },
  );

  assert.equal(resolveCalls, 2);
  assert.equal(serverHits, 0);
});

test("connection lookup rejects a mixed public and private DNS answer set", async () => {
  const publicLookup = createPublicAddressLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);

  const outcome = await runLookup(publicLookup, { all: true });
  assert.match(outcome.error?.message ?? "", /private network/i);
  assert.equal(outcome.address, "");
});

test("connection lookup returns only the validated public addresses", async () => {
  const addresses = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  const publicLookup = createPublicAddressLookup(async () => addresses);

  const all = await runLookup(publicLookup, { all: true });
  assert.equal(all.error, null);
  assert.deepEqual(all.address, addresses);

  const ipv6 = await runLookup(publicLookup, { family: 6 });
  assert.equal(ipv6.error, null);
  assert.equal(ipv6.address, addresses[1].address);
  assert.equal(ipv6.family, 6);
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
  const request = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: {
        "content-length": "4",
        "content-type": "image/png",
      },
    });
  };

  const resource = await fetchPublicImageResource(
    "https://93.184.216.34/image.png",
    {},
    4,
    { request },
  );

  assert.equal(resource?.contentType, "image/png");
  assert.equal(resource?.url.href, "https://93.184.216.34/image.png");
  assert.deepEqual(resource?.body, Buffer.from([1, 2, 3, 4]));
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

function runLookup(lookup, options) {
  return new Promise((resolve) => {
    lookup("example.com", options, (error, address, family) => {
      resolve({ address, error, family });
    });
  });
}
