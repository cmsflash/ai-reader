import assert from "node:assert/strict";
import test from "node:test";
import {
  importTokenConfigured,
  requireImportToken,
} from "../src/server/auth/importToken.ts";

test("an empty explicit import owner falls back to the first allowed email", () => {
  withEnvironment(
    {
      AI_READER_ALLOWED_EMAILS: "reader@example.com",
      AI_READER_IMPORT_OWNER_EMAIL: "",
      AI_READER_IMPORT_TOKEN: "test-secret",
    },
    () => {
      assert.equal(importTokenConfigured(), true);
      assert.deepEqual(
        requireImportToken(
          new Request("https://reader.example/api/import", {
            headers: {
              authorization: "Bearer test-secret",
            },
          }),
        ),
        { email: "reader@example.com" },
      );
    },
  );
});

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
