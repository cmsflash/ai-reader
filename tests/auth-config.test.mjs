import assert from "node:assert/strict";
import test from "node:test";
import {
  getIntegrationOwnerEmail,
  isEmailAllowed,
  isIntegrationOwner,
  resolvePreviewTestOwnerEmail,
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

test("an exact preview test user aliases to the shared canonical owner", () => {
  withEnvironment(
    previewDelegateEnvironment({
      AI_READER_ALLOWED_EMAILS: "owner@example.com, Test@Example.com",
      AI_READER_IMPORT_OWNER_EMAIL: " Owner@Example.com ",
      AI_READER_INTEGRATION_OWNER_EMAIL: "owner@example.com",
    }),
    () => {
      assert.deepEqual(
        resolvePreviewTestOwnerEmail("user_test", "TEST@example.com"),
        {
          isConfiguredDelegate: true,
          ownerEmail: "owner@example.com",
        },
      );
    },
  );
});

test("preview test delegation uses an exact case-sensitive Clerk user ID", () => {
  withEnvironment(previewDelegateEnvironment(), () => {
    assert.deepEqual(
      resolvePreviewTestOwnerEmail("USER_TEST", "test@example.com"),
      {
        isConfiguredDelegate: false,
        ownerEmail: null,
      },
    );
    assert.deepEqual(
      resolvePreviewTestOwnerEmail("user_test_extra", "test@example.com"),
      {
        isConfiguredDelegate: false,
        ownerEmail: null,
      },
    );
  });
});

test("partial or mismatched owner configuration fails closed for the delegate", () => {
  const invalidOwnerEnvironments = [
    {
      AI_READER_IMPORT_OWNER_EMAIL: undefined,
      AI_READER_INTEGRATION_OWNER_EMAIL: "owner@example.com",
    },
    {
      AI_READER_IMPORT_OWNER_EMAIL: "owner@example.com",
      AI_READER_INTEGRATION_OWNER_EMAIL: undefined,
    },
    {
      AI_READER_IMPORT_OWNER_EMAIL: "owner@example.com",
      AI_READER_INTEGRATION_OWNER_EMAIL: "other@example.com",
    },
  ];

  for (const ownerEnvironment of invalidOwnerEnvironments) {
    withEnvironment(
      previewDelegateEnvironment(ownerEnvironment),
      () => {
        assert.deepEqual(
          resolvePreviewTestOwnerEmail("user_test", "test@example.com"),
          {
            isConfiguredDelegate: true,
            ownerEmail: null,
          },
        );
      },
    );
  }
});

test("delegation requires both actor and canonical owner to be allowlisted", () => {
  withEnvironment(
    previewDelegateEnvironment({
      AI_READER_ALLOWED_EMAILS: "test@example.com",
    }),
    () => {
      assert.deepEqual(
        resolvePreviewTestOwnerEmail("user_test", "test@example.com"),
        {
          isConfiguredDelegate: true,
          ownerEmail: null,
        },
      );
    },
  );

  withEnvironment(
    previewDelegateEnvironment({
      AI_READER_ALLOWED_EMAILS: "owner@example.com",
    }),
    () => {
      assert.deepEqual(
        resolvePreviewTestOwnerEmail("user_test", "test@example.com"),
        {
          isConfiguredDelegate: true,
          ownerEmail: null,
        },
      );
    },
  );
});

test("delegation requires a verified actor email selected by Clerk", () => {
  withEnvironment(previewDelegateEnvironment(), () => {
    const selectedEmail = selectVerifiedAllowedEmail(
      [
        {
          id: "test-email",
          emailAddress: "test@example.com",
          verification: { status: "unverified" },
        },
      ],
      "test-email",
    );

    assert.equal(selectedEmail, undefined);
    assert.deepEqual(
      resolvePreviewTestOwnerEmail("user_test", selectedEmail),
      {
        isConfiguredDelegate: true,
        ownerEmail: null,
      },
    );
  });
});

test("the configured delegate cannot alias outside an exact Vercel Preview", () => {
  const nonPreviewEnvironments = [
    { VERCEL: undefined, VERCEL_ENV: undefined },
    { VERCEL: "1", VERCEL_ENV: "production" },
    { VERCEL: "1", VERCEL_ENV: "development" },
    { VERCEL: "0", VERCEL_ENV: "preview" },
  ];

  for (const environment of nonPreviewEnvironments) {
    withEnvironment(
      previewDelegateEnvironment(environment),
      () => {
        assert.deepEqual(
          resolvePreviewTestOwnerEmail("user_test", "test@example.com"),
          {
            isConfiguredDelegate: true,
            ownerEmail: null,
          },
        );
      },
    );
  }
});

test("invalid delegate configuration does not affect normal users", () => {
  withEnvironment(
    previewDelegateEnvironment({
      AI_READER_IMPORT_OWNER_EMAIL: "owner@example.com",
      AI_READER_INTEGRATION_OWNER_EMAIL: "other@example.com",
    }),
    () => {
      assert.equal(isEmailAllowed("normal@example.com"), true);
      assert.deepEqual(
        resolvePreviewTestOwnerEmail("user_normal", "normal@example.com"),
        {
          isConfiguredDelegate: false,
          ownerEmail: null,
        },
      );
    },
  );
});

function previewDelegateEnvironment(overrides = {}) {
  return {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    AI_READER_PREVIEW_TEST_USER_ID: "user_test",
    AI_READER_ALLOWED_EMAILS:
      "owner@example.com,test@example.com,normal@example.com",
    AI_READER_IMPORT_OWNER_EMAIL: "owner@example.com",
    AI_READER_INTEGRATION_OWNER_EMAIL: "owner@example.com",
    ...overrides,
  };
}

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
