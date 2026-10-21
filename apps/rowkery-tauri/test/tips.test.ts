// Tips.ts: counted triggers, one at a time, one a day, retired on use, never while a query runs.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setKeymap } from "../src/keymaps";
import { readKey, resetPersistForTests } from "../src/persist";
import {
  TIPS,
  currentTip,
  dismissTip,
  hideTips,
  noteTrigger,
  resetTipsForTests,
  retireTip,
  setQueryRunning,
  tipsHidden,
} from "../src/Tips";

const DAY = 24 * 60 * 60 * 1000;
const nextDay = () => vi.setSystemTime(Date.now() + DAY);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 5, 10));
  resetPersistForTests();
  resetTipsForTests();
});
afterEach(() => vi.useRealTimers());

describe("tips", () => {
  test("five tips, with the spec's copy and the registry's keys", () => {
    expect(Object.keys(TIPS)).toHaveLength(5);
    const text = (mac: boolean) => Object.fromEntries(Object.entries(TIPS).map(([id, t]) => [id, t.text(mac)]));
    expect(text(true)).toEqual({
      "preview-reused": "Preview tab reused · ⌘-click a table to keep it",
      "type-to-filter": "Type on a column to filter",
      "view-keys": "⌥⌘1 / ⌥⌘2 / ⌥⌘3 switch Data, Structure and Map",
      "widths-remembered": "Widths are remembered for this table",
      "db-new-window": "⌘↵ opens a database in a new window",
    });
    expect(text(false)["view-keys"]).toBe("Ctrl+Alt+1 / Ctrl+Alt+2 / Ctrl+Alt+3 switch Data, Structure and Map");
    // Under a keymap the tip teaches the keys that keymap uses.
    setKeymap("tableplus");
    expect(text(true)["view-keys"]).toBe("⌃⌘[ / ⌃⌘] / ⌥⌘3 switch Data, Structure and Map");
    expect(text(false)["view-keys"]).toBe("Ctrl+Alt+[ / Ctrl+Alt+] / Ctrl+Alt+3 switch Data, Structure and Map");
    setKeymap("rowkery");
    expect(text(false)["preview-reused"]).toBe("Preview tab reused · Ctrl-click a table to keep it");
  });

  test("a tip shows when its trigger reaches its count, under its control", () => {
    expect(noteTrigger("view-keys", { mac: true })).toBe(false);
    expect(noteTrigger("view-keys", { mac: true })).toBe(false);
    expect(noteTrigger("view-keys", { mac: true })).toBe(true);
    expect(currentTip()).toMatchObject({ id: "view-keys", where: "view-switch" });
    // The count is saved with the config, across sessions.
    expect(readKey("rowkery.tips")).toMatchObject({ counts: { "view-keys": 3 } });
  });

  test("install counts survive a new session; session counts don't", () => {
    noteTrigger("view-keys");
    noteTrigger("preview-reused");
    resetTipsForTests(); // a relaunch: memory goes, config.json stays
    noteTrigger("view-keys");
    expect(noteTrigger("view-keys")).toBe(true);
    retireTip("view-keys");
    nextDay();
    // One retarget this session so far: the second earns it.
    expect(noteTrigger("preview-reused")).toBe(false);
    expect(noteTrigger("preview-reused")).toBe(true);
  });

  test("one at a time, and one a day", () => {
    expect(noteTrigger("type-to-filter")).toBe(true);
    for (let i = 0; i < 3; i++) expect(noteTrigger("db-new-window")).toBe(false);
    expect(currentTip()?.id).toBe("type-to-filter");
    vi.advanceTimersByTime(10_000); // it fades
    expect(currentTip()).toBeNull();
    // Same day: still nothing new.
    expect(noteTrigger("db-new-window")).toBe(false);
    nextDay();
    expect(noteTrigger("db-new-window")).toBe(true);
  });

  test("retired on use: gone now and never again", () => {
    noteTrigger("type-to-filter");
    retireTip("type-to-filter");
    expect(currentTip()).toBeNull();
    nextDay();
    expect(noteTrigger("type-to-filter")).toBe(false);
    expect(readKey("rowkery.tips")).toMatchObject({ retired: ["type-to-filter"] });
  });

  test("never while a query runs: one earned meanwhile waits for the rows", () => {
    setQueryRunning(true);
    expect(noteTrigger("type-to-filter")).toBe(true);
    expect(currentTip()).toBeNull();
    setQueryRunning(false);
    expect(currentTip()?.id).toBe("type-to-filter");
    // A query starting hides it; it comes back when the query ends.
    setQueryRunning(true);
    expect(currentTip()).toBeNull();
    setQueryRunning(false);
    expect(currentTip()?.id).toBe("type-to-filter");
  });

  test("widths: the second drag of the same column in one shape, retired once shown", () => {
    expect(noteTrigger("widths-remembered", { key: "a\0id", anchor: "id" })).toBe(false);
    expect(noteTrigger("widths-remembered", { key: "a\0name", anchor: "name" })).toBe(false);
    expect(noteTrigger("widths-remembered", { key: "b\0id", anchor: "id" })).toBe(false);
    expect(noteTrigger("widths-remembered", { key: "a\0id", anchor: "id" })).toBe(true);
    expect(currentTip()).toMatchObject({ id: "widths-remembered", anchor: "id", where: "grid-header" });
    nextDay();
    expect(noteTrigger("widths-remembered", { key: "a\0id" })).toBe(false);
  });

  test("closing its control dismisses a tip without retiring it", () => {
    for (let i = 0; i < 3; i++) noteTrigger("db-new-window");
    dismissTip("db-new-window");
    expect(currentTip()).toBeNull();
    nextDay();
    expect(noteTrigger("db-new-window")).toBe(true);
  });

  test("⌘K Hide tips turns them all off", () => {
    noteTrigger("type-to-filter");
    hideTips();
    expect(currentTip()).toBeNull();
    expect(tipsHidden()).toBe(true);
    nextDay();
    for (let i = 0; i < 3; i++) expect(noteTrigger("view-keys")).toBe(false);
  });
});
