// What an update check says (`updates.ts`): the quiet launch check speaks only
// when an update is ready; Help > Check for Updates… always answers; Restart
// waits while a query runs.
import { test } from "vitest";
import assert from "node:assert/strict";
import { restartBlocker, updateToast } from "../src/updates";

test("a ready update is offered, quiet or not", () => {
  const ready = { status: "ready", version: "0.1.1", notes: null } as const;
  assert.deepEqual(updateToast(ready, false), { kind: "offer", version: "0.1.1" });
  assert.deepEqual(updateToast(ready, true), { kind: "offer", version: "0.1.1" });
});

test("the quiet check says nothing when up to date, off or failing", () => {
  assert.deepEqual(updateToast({ status: "up-to-date", version: "0.1.0" }, false), { kind: "none" });
  assert.deepEqual(updateToast({ status: "off" }, false), { kind: "none" });
  assert.deepEqual(updateToast({ error: "offline" }, false), { kind: "none" });
});

test("a menu pick always answers", () => {
  assert.deepEqual(updateToast({ status: "up-to-date", version: "0.1.0" }, true), {
    kind: "say",
    message: "Rowkery is up to date",
    detail: "0.1.0",
  });
  assert.deepEqual(updateToast({ status: "off" }, true), { kind: "say", message: "This build doesn't update itself" });
  assert.deepEqual(updateToast({ error: "offline" }, true), {
    kind: "say",
    message: "Couldn't check for updates",
    detail: "offline",
    tone: "error",
  });
});

test("restart waits for running queries", () => {
  assert.equal(restartBlocker(0), null);
  assert.equal(restartBlocker(1), "A query is running");
  assert.equal(restartBlocker(3), "3 queries are running");
});
