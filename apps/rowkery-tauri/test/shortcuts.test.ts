// One chord per command everywhere: ⌘K rows, menu items, tooltips, the
// shortcut sheet and every keymap print what commands.ts gives it.
import { beforeEach, describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  GESTURES,
  MENU_IDS,
  PREDEFINED_MAC_CHORDS,
  SHEET_SECTIONS,
  acceleratorFor,
  availableCommands,
  chordFor,
  eventMatches,
  formatChord,
  keysFor,
  matchCommand,
  menuSpec,
  menuState,
  sheetSection,
  type CommandState,
} from "../src/commands";
import { KEYMAPS, KEYMAP_CHORDS, activeKeymap, setKeymap, type KeymapId } from "../src/keymaps";
import { readKey, resetPersistForTests } from "../src/persist";
import { noteUsed, resetUsedKeysForTests, usedKeys } from "../src/usedKeys";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const base: CommandState = {
  connected: true,
  busy: false,
  running: true,
  tableTab: false,
  tabCount: 3,
  hasSchema: true,
  sidebarHidden: false,
  hasConnectionId: true,
  connection: { postgres: true, environment: null, safeMode: "off" },
  windowCount: 3,
  hasResult: true,
  hasRows: true,
  hasActiveTable: true,
  resultsView: "data",
  failed: false,
  loadedRows: 10,
  moreRows: true,
  closedTabs: 1,
  historyBack: true,
  historyForward: true,
  hasSample: true,
  hintsRetired: false,
};
const keymapIds = KEYMAPS.map((k) => k.id);
const byId = new Map(COMMANDS.map((c) => [c.id, c]));

beforeEach(() => {
  resetPersistForTests();
  resetUsedKeysForTests();
});

describe("the registry against what the app prints", () => {
  test.each(keymapIds)("⌘K rows print the registry chord (%s keymap)", (keymap) => {
    setKeymap(keymap);
    for (const mac of [true, false]) {
      for (const tab of [false, true]) {
        for (const row of availableCommands({ ...base, tableTab: tab }, mac)) {
          const chord = chordFor(byId.get(row.id)!, keymap);
          expect(row.keys, `${keymap} ${row.id}`).toBe(chord ? formatChord(chord, mac) : undefined);
        }
      }
    }
  });

  test.each(keymapIds)("menu items carry the registry accelerator (%s keymap)", (keymap) => {
    const state = menuState(base, keymap);
    for (const id of MENU_IDS) {
      const chord = chordFor(byId.get(id)!, keymap);
      expect(state[id].accelerator, `${keymap} ${id}`).toBe(chord ? acceleratorFor(chord) : null);
    }
    // menu.json is the Rowkery keymap; the page pushes the others.
    if (keymap === "rowkery") {
      for (const sub of menuSpec())
        for (const item of sub.items) if (!("separator" in item)) expect(item.accelerator).toBe(state[item.id].accelerator);
    }
  });

  test("keysFor (tooltips, keycaps) follows the keymap", () => {
    expect(keysFor("new-window", true)).toBe("⌘T");
    expect(keysFor("new-tab", true)).toBe("");
    setKeymap("tableplus");
    expect(keysFor("new-tab", true)).toBe("⌘T");
    expect(keysFor("new-window", true)).toBe("⌥⌘T");
    expect(keysFor("show-structure", false)).toBe("Ctrl+Alt+]");
    setKeymap("rowkery");
    expect(keysFor("show-structure", false)).toBe("Ctrl+Alt+2");
  });

  // Keys these files print that equal a registry chord but mean something
  // local: the picker's ⌘E edit, the database
  // picker's ⌘↵ opens in a new window.
  const LOCAL: Record<string, string[]> = {
    "ConnectionSwitcher.tsx": ["⌘E", "Ctrl+E"],
    "DatabaseSwitcher.tsx": ["⌘↵", "Ctrl+↵"],
  };

  test("no component hard-codes a registry chord (tooltips read keysFor)", () => {
    const chords = new Set<string>();
    for (const c of COMMANDS) {
      for (const keymap of keymapIds) {
        const chord = chordFor(c, keymap);
        if (!chord) continue;
        for (const mac of [true, false]) {
          const k = formatChord(chord, mac);
          // Bare keys (/, ↵) are too common to tell apart.
          if (/[⌘⌃⌥⇧]|Ctrl\+|Alt\+/.test(k)) chords.add(k);
        }
      }
    }
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".tsx"))) {
      const text = readFileSync(SRC + file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
        .join("\n");
      const literals = [...text.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2]);
      for (const lit of literals) {
        for (const k of chords) {
          if (LOCAL[file]?.includes(k)) continue;
          const at = lit.indexOf(k);
          // A whole chord, not the tail of a longer one (⇧⌘R holds ⌘R).
          if (at < 0 || /[⌘⌃⌥⇧+]/.test(lit[at - 1] ?? "") || /[A-Z0-9]/.test(lit[at + k.length] ?? "")) continue;
          expect.fail(`${file} prints "${k}" in ${JSON.stringify(lit)}; use keysFor`);
        }
      }
    }
  });
});

describe("keymaps", () => {
  const SHARED = ["refresh-schema,retry-connect", "filter-rows,find-results", "follow-key,run", "edit-failed-connection,open-in-query", "explain,open-in-query", "edit-failed-connection,explain", "delete-row,remove-filter", "connection-save,run", "format-sql,insert-row"];
  test.each(keymapIds)("%s: no chord is a predefined macOS accelerator or bound twice", (keymap) => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS) {
      const chord = chordFor(c, keymap);
      if (!chord) continue;
      const mac = formatChord(chord, true);
      if (PREDEFINED_MAC_CHORDS.includes(mac)) expect(c.replacesPredefined ?? c.sharesPredefined, `${keymap} ${c.id} ${mac}`).toBeTruthy();
      for (const m of [true, false]) {
        const k = `${m}:${formatChord(chord, m)}`;
        const other = seen.get(k);
        // ⌘R: Refresh schema and Retry; ⌘F: Filter rows and Find; ⌘↵: Run in
        // the editor, Follow in the grid, Save in the connection form; ⌘E: Explain
        // on a query tab, Edit SQL on a table tab, Edit a failed connection.
        // Never runnable together.
        if (other && SHARED.includes([other, c.id].sort().join())) continue;
        expect(other, `${keymap}: ${c.id} and ${other} share ${k}`).toBeUndefined();
        seen.set(k, c.id);
      }
    }
  });

  test("keymaps only move existing commands, and only a handful", () => {
    for (const [keymap, chords] of Object.entries(KEYMAP_CHORDS)) {
      for (const id of Object.keys(chords)) expect(byId.has(id), `${keymap} ${id}`).toBe(true);
      expect(Object.keys(chords).length).toBeLessThanOrEqual(6);
    }
  });

  test("the keymap persists in config.json", () => {
    expect(activeKeymap()).toBe("rowkery");
    setKeymap("datagrip");
    expect(readKey("rowkery.keymap")).toBe("datagrip");
    expect(activeKeymap()).toBe("datagrip");
    setKeymap("rowkery");
    expect(readKey("rowkery.keymap")).toBeUndefined();
  });
});

describe("matching a keydown", () => {
  const key = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });

  test("by code, with exact modifiers", () => {
    expect(eventMatches(key("KeyT", { meta: true }), { mac: "Mod+T" }, true)).toBe(true);
    expect(eventMatches(key("KeyT", { ctrl: true }), { mac: "Mod+T" }, false)).toBe(true);
    expect(eventMatches(key("KeyT", { meta: true, shift: true }), { mac: "Mod+T" }, true)).toBe(false);
    expect(eventMatches(key("Slash", { meta: true, shift: true }), { mac: "Mod+Shift+/" }, true)).toBe(true);
    expect(eventMatches(key("Digit2", { meta: true, alt: true }), { mac: "Alt+Mod+2" }, true)).toBe(true);
    expect(eventMatches(key("ArrowLeft", { alt: true }), { mac: "Mod+[", other: "Alt+Left" }, false)).toBe(true);
    expect(eventMatches(key("Space", { ctrl: true }), { mac: "Ctrl+Space" }, true)).toBe(true);
    expect(eventMatches(key("Period", { meta: true }), { mac: "Mod+." }, true)).toBe(true);
  });

  test("a shared chord picks the command that can run (⌘R)", () => {
    const r = key("KeyR", { meta: true });
    expect(matchCommand(r, base, true)?.id).toBe("refresh-schema");
    expect(matchCommand(r, { ...base, connected: false, failed: true }, true)?.id).toBe("retry-connect");
    expect(matchCommand(key("KeyT", { meta: true }), base, true)?.id).toBe("new-window");
    setKeymap("tableplus");
    expect(matchCommand(key("KeyT", { meta: true }), base, true)?.id).toBe("new-tab");
    setKeymap("rowkery");
  });
});

describe("the shortcut sheet's rows", () => {
  test("every command with a chord has a section; gestures too", () => {
    for (const c of COMMANDS) if (c.chord) expect(SHEET_SECTIONS).toContain(sheetSection(c));
    for (const g of GESTURES) {
      expect(SHEET_SECTIONS).toContain(g.section);
      expect(g.chord || g.keys, g.id).toBeTruthy();
      // A gesture row may stand for a zone key (out of ⌘K), never a ⌘K command.
      expect(byId.get(g.id)?.palette ?? (byId.has(g.id) ? true : false), `${g.id} is also a ⌘K command`).toBe(false);
    }
  });

  test("used keys count per id and persist", () => {
    expect(usedKeys()).toEqual({});
    noteUsed("run");
    noteUsed("run");
    noteUsed("copy-cells");
    expect(usedKeys()).toEqual({ run: 2, "copy-cells": 1 });
    expect(readKey("rowkery.usedKeys")).toEqual({ run: 2, "copy-cells": 1 });
  });

  test("only commands count toward Used n of m", () => {
    const total = COMMANDS.filter((c) => chordFor(c)).length;
    expect(total).toBeGreaterThan(20);
    expect(GESTURES.some((g) => byId.has(g.id) && byId.get(g.id)!.palette !== false)).toBe(false);
  });
});

// Keeps KeymapId exhaustive in the picker.
const _all: Record<KeymapId, true> = { rowkery: true, tableplus: true, datagrip: true };
void _all;
