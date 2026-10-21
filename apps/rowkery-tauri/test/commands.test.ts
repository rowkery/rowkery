// The commands.ts registry: chords, ⌘K availability and the generated menu.
import { describe, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  MENU_BAR,
  MENU_IDS,
  PREDEFINED_MAC_CHORDS,
  acceleratorFor,
  availableCommands,
  formatChord,
  menuSpec,
  menuState,
  type CommandState,
} from "../src/commands";
import { menuDiff } from "../src/menuSync";

const MENU_JSON = fileURLToPath(new URL("../src-tauri/menu.json", import.meta.url));

const base: CommandState = {
  connected: true,
  busy: false,
  running: false,
  tableTab: false,
  tabCount: 1,
  hasSchema: true,
  sidebarHidden: false,
  hasConnectionId: true,
  connection: { postgres: true, environment: null, safeMode: "off" },
  windowCount: 1,
  hasResult: false,
  hasRows: false,
  hasActiveTable: false,
  resultsView: "data",
};
const ids = (s: Partial<CommandState>) => availableCommands({ ...base, ...s }, true).map((c) => c.id);

describe("chords", () => {
  test("no chord is a predefined macOS menu accelerator unless app_menu replaces that item", () => {
    for (const c of COMMANDS) {
      if (!c.chord) continue;
      const mac = formatChord(c.chord, true);
      if (PREDEFINED_MAC_CHORDS.includes(mac)) {
        // A zone's own Copy keeps Edit > Copy: the zone's keydown sees ⌘C first.
        if (c.sharesPredefined) {
          expect(c.palette, `${c.id} acts in its zone only`).toBe(false);
          expect(["⌘C", "⌘A"], `${c.id} may share only an Edit item`).toContain(mac);
          continue;
        }
        expect(c.replacesPredefined, `${c.id} uses ${mac}`).toBeTruthy();
        // Replacing means owning it in the menu bar, so the predefined item can't fire.
        expect(MENU_IDS, `${c.id} must be the menu item that owns ${mac}`).toContain(c.id);
      }
    }
  });

  // Pairs that share a chord because they can never run at once: ⌘R
  // refreshes a connected window's schema and retries a failed one; ⌘F
  // filters a table tab and finds in a query tab's rows; ⌘↵ runs the
  // editor's statement on a query tab and will follow a key in the grid; ⌘E
  // explains a query tab's statement and edits a table tab's SQL; ⌘I formats a
  // query tab's SQL and inserts a row in a table tab.
  const SHARED_CHORDS: Record<string, string> = {
    "retry-connect": "refresh-schema",
    "find-results": "filter-rows",
    "follow-key": "run",
    "edit-failed-connection": "open-in-query",
    "delete-row": "remove-filter",
    "connection-save": "run",
    explain: "open-in-query",
    "format-sql": "insert-row",
  };

  test("shared chords are never runnable together", () => {
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    for (const [a, b] of Object.entries(SHARED_CHORDS)) {
      for (const s of [
        { ...base, connected: true, failed: false },
        { ...base, connected: true, failed: false, connectionForm: true },
        { ...base, connected: false, failed: true },
        { ...base, connected: false, failed: false },
        { ...base, failed: false, tableTab: true, hasRows: true },
        { ...base, failed: false, tableTab: false, hasRows: true },
        { ...base, failed: false, tableTab: true, hasRows: true, cellFollowable: true },
        { ...base, failed: false, tableTab: false, hasRows: true, cellFollowable: true },
        { ...base, failed: false, tableTab: true, hasRows: true, rowsEditable: true, cellEditable: true },
        { ...base, failed: false, tableTab: true, hasRows: true, rowsEditable: true, cellEditable: true, rowsSelected: true },
      ]) {
        expect(byId.get(a)!.canRun(s) && byId.get(b)!.canRun(s), `${a} and ${b}`).toBe(false);
      }
    }
  });

  test("no chord is bound twice", () => {
    // Every command on a chord pairs (SHARED_CHORDS) with one of those already on it.
    const seen = new Map<string, string[]>();
    for (const c of COMMANDS) {
      if (!c.chord) continue;
      for (const mac of [true, false]) {
        const k = `${mac}:${formatChord(c.chord, mac)}`;
        const others = seen.get(k) ?? [];
        const paired = others.some((other) => SHARED_CHORDS[c.id] === other || SHARED_CHORDS[other] === c.id);
        if (others.length && !paired) expect(others[0], `${c.id} and ${others[0]} share ${k}`).toBeUndefined();
        seen.set(k, [...others, c.id]);
      }
    }
  });

  test("ids are unique", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });

  test("keycaps read as before on both platforms", () => {
    const keys = (mac: boolean) =>
      Object.fromEntries(availableCommands({ ...base, hasActiveTable: true }, mac).map((c) => [c.id, c.keys]));
    expect(keys(true)).toMatchObject({
      run: "⌘↵",
      "close-tab": "⌘W",
      "filter-schema": "/",
      "toggle-sidebar": "⌘B",
      "switch-connection": "⇧⌘O",
      "switch-database": "⇧⌘D",
      "new-window": "⌘T",
      "refresh-schema": "⌘R",
      "show-structure": "⌥⌘2",
    });
    expect(keys(false)).toMatchObject({
      run: "Ctrl+↵",
      "close-tab": "Ctrl+W",
      "toggle-sidebar": "Ctrl+B",
      "switch-connection": "Ctrl+Shift+O",
      "show-structure": "Ctrl+Alt+2",
    });
    expect(availableCommands({ ...base, running: true }, false).find((c) => c.id === "cancel")?.keys).toBe("Ctrl+.");
  });
});

describe("availableCommands", () => {
  test("a query tab runs SQL; a table tab refreshes and filters", () => {
    expect(ids({})).toEqual(expect.arrayContaining(["run", "run-all"]));
    expect(ids({})).not.toContain("refresh-rows");
    expect(ids({ tableTab: true })).toEqual(expect.arrayContaining(["refresh-rows", "open-in-query", "filter-rows"]));
    expect(ids({ tableTab: true })).not.toContain("run");
  });

  test("⌘K lists each title once (one Refresh rows on a table tab)", () => {
    for (const s of [{}, { tableTab: true }, { tableTab: true, hasRows: true, moreRows: true, loadedRows: 500 }]) {
      const titles = availableCommands({ ...base, ...s }, true).map((c) => c.title);
      expect(titles.filter((t) => t === "Refresh rows").length).toBeLessThanOrEqual(1);
      expect(new Set(titles).size, titles.join(", ")).toBe(titles.length);
    }
    expect(availableCommands({ ...base, tableTab: true }, true).filter((c) => c.title === "Refresh rows")).toEqual([
      expect.objectContaining({ id: "refresh-rows", keys: "⇧⌘R" }),
    ]);
  });

  test("Quick Look is in ⌘K once there are rows to look at; Follow never is", () => {
    expect(ids({ hasRows: true })).toContain("quick-look");
    expect(ids({ hasRows: false })).not.toContain("quick-look");
    expect(ids({ hasRows: true, resultsView: "structure" })).not.toContain("quick-look");
    expect(ids({ hasRows: true, tableTab: true, cellFollowable: true })).not.toContain("follow-key");
  });

  test("nothing runs while disconnected or busy", () => {
    expect(ids({ connected: false })).not.toContain("run");
    expect(ids({ busy: true })).not.toContain("run");
    expect(ids({ busy: true })).not.toContain("reconnect");
  });

  test("Cancel only while running; window and tab cycling only with more than one", () => {
    expect(ids({})).not.toContain("cancel");
    expect(ids({ running: true })).toContain("cancel");
    expect(ids({})).not.toContain("next-tab");
    expect(ids({ tabCount: 2 })).toContain("next-tab");
    expect(ids({ windowCount: 2 })).toEqual(expect.arrayContaining(["close-window", "next-window"]));
  });

  test("switch database is Postgres only", () => {
    expect(ids({ connection: { postgres: false, environment: null, safeMode: "off" } })).not.toContain(
      "switch-database",
    );
  });

  test("environment and safe mode list every value except the current one", () => {
    const got = ids({ connection: { postgres: true, environment: "prd", safeMode: "confirm" } });
    expect(got).toEqual(expect.arrayContaining(["env:local", "env:dev", "env:stg", "env:none", "safe:off", "safe:read_only"]));
    expect(got).not.toContain("env:prd");
    expect(got).not.toContain("safe:confirm");
    expect(ids({})).not.toContain("env:none");
    expect(ids({ connection: null })).not.toContain("edit-connection");
  });

  test("sidebar title follows its state", () => {
    const title = (sidebarHidden: boolean) =>
      availableCommands({ ...base, sidebarHidden }, true).find((c) => c.id === "toggle-sidebar")?.title;
    expect(title(false)).toBe("Hide sidebar");
    expect(title(true)).toBe("Show sidebar");
  });

  test("Data | Structure offers the other view", () => {
    expect(ids({ hasActiveTable: true })).toContain("show-structure");
    expect(ids({ hasActiveTable: true, resultsView: "structure" })).toContain("show-data");
  });
});

describe("menu bar", () => {
  test("src-tauri/menu.json is generated from commands.ts", () => {
    const want = `${JSON.stringify(menuSpec(), null, 2)}\n`;
    if (process.env.UPDATE_MENU) writeFileSync(MENU_JSON, want);
    expect(readFileSync(MENU_JSON, "utf8"), "run UPDATE_MENU=1 npm test").toBe(want);
  });

  test("the app menu's items, then File, Edit, Connection, Query, View, Go, Window and Help", () => {
    expect(MENU_BAR.map((m) => m.submenu)).toEqual(["Rowkery", "File", "Edit", "Connection", "Query", "View", "Go", "Window", "Help"]);
  });

  test("Check for Updates… and Settings… are in the app menu, not Help", () => {
    const ids = (sub: string) => MENU_BAR.find((m) => m.submenu === sub)!.items;
    expect(ids("Rowkery")).toEqual(["check-updates", null, "settings"]);
    expect(ids("Help")).not.toContain("check-updates");
  });

  test("File > Close Tab owns ⌘W", () => {
    const file = menuSpec().find((m) => m.submenu === "File")!;
    expect(file.items).toContainEqual({ id: "close-tab", title: "Close Tab", accelerator: "CmdOrCtrl+W" });
  });

  test("every item is a known command, once, with a menu title", () => {
    expect(new Set(MENU_IDS).size).toBe(MENU_IDS.length);
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    for (const id of MENU_IDS) {
      expect(byId.get(id), id).toBeTruthy();
      expect(byId.get(id)!.menuTitle, id).toBeTruthy();
    }
  });

  test("every item prints the chord commands.ts gives it", () => {
    const byId = new Map(COMMANDS.map((c) => [c.id, c]));
    for (const sub of menuSpec()) {
      for (const item of sub.items) {
        if ("separator" in item) continue;
        const c = byId.get(item.id)!;
        expect(item.accelerator, item.id).toBe(c.chord ? acceleratorFor(c.chord) : null);
      }
    }
  });

  test("no item carries a bare key (it would eat that key in text fields)", () => {
    for (const id of MENU_IDS) {
      const chord = COMMANDS.find((c) => c.id === id)!.chord;
      if (chord) expect(chord.mac, id).toMatch(/^(Mod|Ctrl|Alt|Shift)\+/);
    }
  });

  test("accelerators use key names Tauri parses", () => {
    for (const sub of menuSpec()) {
      for (const item of sub.items) {
        if ("separator" in item || !item.accelerator) continue;
        expect(item.accelerator, item.id).toMatch(/^(CmdOrCtrl\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|Enter|Left|Right|[.,/[\]])$/);
      }
    }
  });

  test("no separator leads, trails or doubles", () => {
    for (const { submenu, items } of MENU_BAR) {
      expect(items[0], submenu).not.toBeNull();
      expect(items[items.length - 1], submenu).not.toBeNull();
      items.forEach((i, n) => {
        if (i === null) expect(items[n + 1], submenu).not.toBeNull();
      });
    }
  });

  test("items are disabled, not hidden, when they can't run", () => {
    const state = menuState({ ...base, connected: false, running: false });
    expect(Object.keys(state).sort()).toEqual([...MENU_IDS].sort());
    expect(state.run.enabled).toBe(false);
    expect(state.cancel.enabled).toBe(false);
    expect(state["new-connection"].enabled).toBe(true);
    expect(menuState({ ...base, running: true }).cancel.enabled).toBe(true);
  });

  test("Show / Hide Sidebar follows the state", () => {
    expect(menuState({ ...base, sidebarHidden: true })["toggle-sidebar"].title).toBe("Show Sidebar");
    expect(menuState(base)["toggle-sidebar"].title).toBe("Hide Sidebar");
    expect(menuState(base).run.title).toBeUndefined();
  });

  test("only changed items are pushed", () => {
    const a = menuState(base);
    const b = menuState({ ...base, running: true });
    expect(menuDiff(a, {})).toHaveLength(MENU_IDS.length);
    expect(menuDiff(a, a)).toEqual([]);
    expect(menuDiff(b, a)).toEqual([{ id: "cancel", enabled: true, title: null, accelerator: "CmdOrCtrl+." }]);
  });
});
