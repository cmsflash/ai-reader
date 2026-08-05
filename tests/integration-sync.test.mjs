import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return {
        url: pathToFileURL(
          path.join(projectRoot, "src", `${specifier.slice(2)}.ts`),
        ).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

const {
  integrationSyncMaxRequests,
  integrationSyncRequestBatchSize,
  mergeIntegrationSyncResponses,
  shouldContinueIntegrationSync,
} = await import("../src/lib/integrationSync.ts");

test("provider sync keeps each server request to one item", () => {
  assert.equal(integrationSyncRequestBatchSize, 1);
});

test("provider sync aggregates sequential request outcomes without double-counting skipped records", () => {
  const first = {
    imported: 1,
    deduplicated: 0,
    reconciled: 0,
    failed: 0,
    skipped: 40,
    remaining: 3,
    failures: [],
    message: "first request",
  };
  const second = {
    imported: 0,
    deduplicated: 1,
    reconciled: 0,
    failed: 1,
    skipped: 41,
    remaining: 1,
    failures: [
      { externalId: "failed-1", title: "Failed article", error: "No article" },
    ],
    possiblyTruncated: true,
    message: "second request",
  };

  const merged = mergeIntegrationSyncResponses(
    mergeIntegrationSyncResponses(null, first),
    second,
  );

  assert.deepEqual(merged, {
    imported: 1,
    deduplicated: 1,
    reconciled: 0,
    failed: 1,
    skipped: 41,
    remaining: 1,
    failures: second.failures,
    possiblyTruncated: true,
  });
});

test("provider sync continuation is bounded and stops when no item was attempted", () => {
  const progress = {
    imported: 1,
    deduplicated: 0,
    reconciled: 0,
    failed: 0,
    skipped: 0,
    remaining: 10,
  };
  const noProgress = { ...progress, imported: 0 };

  assert.equal(shouldContinueIntegrationSync(progress, 1), true);
  assert.equal(
    shouldContinueIntegrationSync(progress, integrationSyncMaxRequests),
    false,
  );
  assert.equal(shouldContinueIntegrationSync(noProgress, 1), false);
  assert.equal(
    shouldContinueIntegrationSync({ ...progress, remaining: 0 }, 1),
    false,
  );
});
