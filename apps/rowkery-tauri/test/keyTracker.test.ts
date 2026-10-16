// keyTracker.ts: which command or gesture a keydown is a use of, zones included.
import { beforeEach, describe, expect, test } from "vitest";
import type { CommandState } from "../src/commands";
import { COMMAND_ZONE, keyUse, noteMenuCommand, type KeyPlace } from "../src/keyTracker";
import { setKeymap } from "../src/keymaps";
import { resetPersistForTests } from "../src/persist";
import { resetUsedKeysForTests, usedKeys } from "../src/usedKeys";

const base: CommandState = {
  connected: true,
  busy: false,
  running: false,
  tableTab: true,
  tabCount: 2,
  hasSchema: true,
  sidebarHidden: false,
  hasConnectionId: true,
  connection: { postgres: true, environment: null, safeMode: "off" },
  windowCount: 2,
  hasResult: true,
  hasRows: true,
  hasActiveTable: true,
  resultsView: "data",
  failed: false,
  loadedRows: 10,
  moreRows: false,
  closedTabs: 0,
  historyBack: false,
  historyForward: false,
  hasSample: false,
  hintsRetired: false,
  cellEditable: true,
  rowsEditable: true,
};

const GRID = ".results-grid-wrap";
const PANEL = ".sidebar";
const CHIP = ".sql-chip";

/** A target inside the elements matching these selectors. */
const at = (selectors: string[], textField = false): KeyPlace => ({
  within: (sel) => sel.split(",").some((one) => selectors.includes(one.trim())),
  textField,
});

const key = (code: string, k: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});
const enter = key("Enter", "Enter");

beforeEach(() => {
  resetPersistForTests();
  resetUsedKeysForTests();
});

describe("keyUse", () => {
  test("↵ in the grid is Edit cell; on a chip it is nobody's; on a panel row it opens the table", () => {
    expect(keyUse(enter, base, at([GRID]), true, "rowkery")).toEqual({ kind: "command", id: "edit-cell" });
    expect(keyUse(enter, base, at([CHIP]), true, "rowkery")).toBeNull();
    expect(keyUse(enter, base, at([PANEL]), true, "rowkery")).toEqual({ kind: "gesture", id: "panel-open" });
    // The panel's filter box types ↵ for itself.
    expect(keyUse(enter, base, at([PANEL], true), true, "rowkery")).toBeNull();
    // The cell editor's own ↵ is not Edit cell.
    expect(keyUse(enter, base, at([GRID], true), true, "rowkery")).toBeNull();
  });

  test("⌫ removes a filter on a chip and marks rows in the grid", () => {
    const back = key("Backspace", "Backspace");
    expect(keyUse(back, base, at([CHIP]), true, "rowkery")).toEqual({ kind: "command", id: "remove-filter" });
    expect(keyUse(back, { ...base, rowsSelected: true }, at([GRID]), true, "rowkery")).toEqual({ kind: "command", id: "delete-row" });
    expect(keyUse(back, base, at([]), true, "rowkery")).toBeNull();
  });

  test("⌥↵ inserts a name only from the panel; ⌘C copies only in the grid", () => {
    expect(keyUse(key("Enter", "Enter", { alt: true }), base, at([PANEL]), true, "rowkery")).toEqual({ kind: "command", id: "insert-name" });
    expect(keyUse(key("Enter", "Enter", { alt: true }), base, at([GRID]), true, "rowkery")).toBeNull();
    expect(keyUse(key("KeyC", "c", { meta: true }), base, at([GRID]), true, "rowkery")).toEqual({ kind: "command", id: "copy-cells" });
    expect(keyUse(key("KeyC", "c", { meta: true }), base, at([]), true, "rowkery")).toBeNull();
  });

  test("window-wide keys count anywhere", () => {
    expect(keyUse(key("KeyS", "s", { meta: true }), { ...base, pendingEdits: 1 }, at([]), true, "rowkery")).toEqual({
      kind: "command",
      id: "commit-edits",
    });
    expect(keyUse(key("KeyW", "w", { ctrl: true }), base, at([]), false, "rowkery")).toEqual({ kind: "command", id: "close-tab" });
  });

  test("a keymap's swapped chord is a swap; Rowkery's chord stays a command", () => {
    const t = key("KeyT", "t", { meta: true });
    expect(keyUse(t, base, at([]), true, "rowkery")).toEqual({ kind: "command", id: "new-window" });
    expect(keyUse(t, base, at([]), true, "tableplus")).toEqual({ kind: "swap", id: "new-tab" });
    expect(keyUse(key("KeyT", "t", { ctrl: true }), base, at([]), false, "tableplus")).toEqual({ kind: "swap", id: "new-tab" });
  });

  test("every zone-bound command names a zone the sheet knows", () => {
    for (const sel of Object.values(COMMAND_ZONE)) expect([GRID, PANEL, CHIP]).toContain(sel);
  });
});

describe("noteMenuCommand", () => {
  test("a menu pick with ⌘ held counts its key; a pointer pick or a command without a key doesn't", () => {
    noteMenuCommand("close-tab", false);
    expect(usedKeys()["close-tab"]).toBeUndefined();
    noteMenuCommand("close-tab", true);
    expect(usedKeys()["close-tab"]).toBe(1);
    noteMenuCommand("stop-all-queries", true);
    expect(usedKeys()["stop-all-queries"]).toBeUndefined();
  });

  test("under a keymap, the swapped accelerator counts", () => {
    setKeymap("tableplus");
    noteMenuCommand("new-tab", true);
    expect(usedKeys()["new-tab"]).toBe(1);
    setKeymap("rowkery");
  });
});
