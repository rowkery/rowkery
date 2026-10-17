// What an update check says (`updates.ts`): the quiet launch check speaks only
// when an update is ready; Rowkery > Check for Updates… always answers; Restart
// waits while a query runs. The update preference (Settings > Updates) decides
// what the foot's orange button shows and when Automatic restarts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { resetPersistForTests } from "../src/persist";
import {
  IDLE_MS,
  idleEnough,
  restartBlocker,
  setUpdatePref,
  updatePref,
  updateToast,
  updateWaiting,
} from "../src/updates";

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

test("Notify only: a found release shows as the button, and a menu pick says so", () => {
  const found = { status: "available", version: "0.1.2", notes: null } as const;
  assert.deepEqual(updateToast(found, false, "notify"), { kind: "none" });
  assert.deepEqual(updateToast(found, true, "notify"), { kind: "available", version: "0.1.2" });
});

test("Automatic restarts on its own, so a quiet ready says nothing", () => {
  const ready = { status: "ready", version: "0.1.2", notes: null } as const;
  assert.deepEqual(updateToast(ready, false, "auto"), { kind: "none" });
  assert.deepEqual(updateToast(ready, true, "auto"), { kind: "offer", version: "0.1.2" });
});

test("the foot's button shows while a release waits for the user", () => {
  const v = { version: "0.1.2", notes: null };
  assert.equal(updateWaiting({ phase: "available", ...v }, "notify"), true);
  assert.equal(updateWaiting({ phase: "downloading", ...v }, "notify"), true);
  assert.equal(updateWaiting({ phase: "ready", ...v }, "download"), true);
  assert.equal(updateWaiting({ phase: "ready", ...v }, "auto"), false);
  assert.equal(updateWaiting({ phase: "up-to-date", version: "0.1.1" }, "download"), false);
  assert.equal(updateWaiting({ phase: "idle" }, "notify"), false);
});

test("the preference defaults to Download only and saves only a change from it", () => {
  resetPersistForTests();
  assert.equal(updatePref(), "download");
  setUpdatePref("notify");
  assert.equal(updatePref(), "notify");
  setUpdatePref("download");
  assert.equal(updatePref(), "download");
  resetPersistForTests({ "rowkery.updates": "bogus" });
  assert.equal(updatePref(), "download");
});

test("Automatic waits for an unfocused, untouched, quiet app", () => {
  const now = 1_000_000_000;
  const quiet = { now, lastInput: now - IDLE_MS, focused: false, running: 0 };
  assert.equal(idleEnough(quiet), true);
  assert.equal(idleEnough({ ...quiet, focused: true }), false);
  assert.equal(idleEnough({ ...quiet, running: 1 }), false);
  assert.equal(idleEnough({ ...quiet, lastInput: now - IDLE_MS + 1 }), false);
});
