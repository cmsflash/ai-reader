import assert from "node:assert/strict";
import test from "node:test";
import {
  beginShareHandoff,
  SHARE_RETURN_FALLBACK_DELAY_MS,
  shouldAutoReturnFromShare,
} from "../src/lib/shareHandoff.ts";

test("share handoff requests close and falls back to the library on a timer", () => {
  const events = [];
  let fallback;
  const target = {
    clearTimeout(handle) {
      events.push(["clear", handle]);
    },
    close() {
      events.push(["close"]);
    },
    location: {
      replace(url) {
        events.push(["replace", url]);
      },
    },
    setTimeout(handler, delay) {
      fallback = handler;
      events.push(["schedule", delay]);
      return 42;
    },
  };

  const cleanup = beginShareHandoff(target);

  assert.deepEqual(events, [
    ["schedule", SHARE_RETURN_FALLBACK_DELAY_MS],
    ["close"],
  ]);

  fallback();
  assert.deepEqual(events.at(-1), ["replace", "/"]);

  cleanup();
  assert.deepEqual(events.at(-1), ["clear", 42]);
});

test("share handoff uses the library immediately if close throws", () => {
  const events = [];
  const target = {
    clearTimeout(handle) {
      events.push(["clear", handle]);
    },
    close() {
      throw new Error("close unavailable");
    },
    location: {
      replace(url) {
        events.push(["replace", url]);
      },
    },
    setTimeout() {
      return 7;
    },
  };

  beginShareHandoff(target, { fallbackUrl: "/library" });

  assert.deepEqual(events, [
    ["clear", 7],
    ["replace", "/library"],
  ]);
});

test("only an Android share-target handoff opts into automatic return", () => {
  assert.equal(shouldAutoReturnFromShare("android-share", "1"), true);
  assert.equal(shouldAutoReturnFromShare("android-share", undefined), false);
  assert.equal(shouldAutoReturnFromShare("ios-shortcut", "1"), false);
  assert.equal(shouldAutoReturnFromShare("web-share", "1"), false);
});
