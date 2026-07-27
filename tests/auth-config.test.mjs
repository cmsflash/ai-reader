import assert from "node:assert/strict";
import test from "node:test";
import {
  getIntegrationOwnerEmail,
  isEmailAllowed,
  isIntegrationOwner,
  selectVerifiedAllowedEmail,
} from "../src/server/auth/config.ts";

test("hosted authorization fails closed when the email allowlist is empty", () => {
  withEnvironment(
    {
      AI_READER_ALLOWED_EMAILS: "",
    },
    () => {
      assert.equal(isEmailAllowed("reader@example.com"), false);
    },
  );
});

test("allowed and integration-owner emails are normalized independently", () => {
  withEnvironment(
    {
      AI_READER_ALLOWED_EMAILS: " First@Example.com, second@example.com ",
      AI_READER_INTEGRATION_OWNER_EMAIL: " First@Example.com ",
    },
    () => {
      assert.equal(isEmailAllowed("first@example.com"), true);
      assert.equal(isEmailAllowed("SECOND@EXAMPLE.COM"), true);
      assert.equal(isEmailAllowed("other@example.com"), false);
      assert.equal(getIntegrationOwnerEmail(), "first@example.com");
      assert.equal(isIntegrationOwner("FIRST@example.com"), true);
      assert.equal(isIntegrationOwner("second@example.com"), false);
    },
  );
});

test("the personal import owner is a safe local fallback for provider ownership", () => {
  withEnvironment(
    {
      AI_READER_INTEGRATION_OWNER_EMAIL: "",
      AI_READER_IMPORT_OWNER_EMAIL: "Reader@Example.com",
    },
    () => {
      assert.equal(getIntegrationOwnerEmail(), "reader@example.com");
      assert.equal(isIntegrationOwner("reader@example.com"), true);
    },
  );
});

test("only verified allowlisted Clerk emails are eligible for authorization", () => {
  withEnvironment(
    {
      AI_READER_ALLOWED_EMAILS: "allowed@example.com",
    },
    () => {
      assert.equal(
        selectVerifiedAllowedEmail(
          [
            {
              id: "primary",
              emailAddress: "allowed@example.com",
              verification: { status: "unverified" },
            },
          ],
          "primary",
        ),
        undefined,
      );
      assert.equal(
        selectVerifiedAllowedEmail(
          [
            {
              id: "primary",
              emailAddress: "other@example.com",
              verification: { status: "verified" },
            },
            {
              id: "secondary",
              emailAddress: "allowed@example.com",
              verification: { status: "verified" },
            },
          ],
          "primary",
        ),
        "allowed@example.com",
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
