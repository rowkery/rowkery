// Every context-menu row prints its chord from commands.ts, and only keys that can run.
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS, chordFor, commandById, formatChord, type CommandState } from "../src/commands";
import { KEYMAPS } from "../src/keymaps";
import {
  cellMenu,
  chipMenu,
  headerMenu,
  helpMenu,
  panelRowMenu,
  railTileMenu,
  rowKeys,
  tabMenu,
  type MenuRow,
} from "../src/contextMenus";

const base = {
  connected: true,
  busy: false,
  running: false,
  tableTab: false,
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
  closedTabs: 1,
  historyBack: false,
  historyForward: false,
  hasSample: false,
} satisfies CommandState;

const filter = { column: "kiosk_id", isNull: false, shown: "7" };

/** Every menu, in every shape its inputs give it. */
function allMenus(): [string, MenuRow[]][] {
  const out: [string, MenuRow[]][] = [];
  for (const state of [base, { ...base, tableTab: true }, { ...base, cellEditable: true, cellFollowable: true }]) {
    for (const f of [null, filter, { ...filter, isNull: true }]) {
      for (const openAsTable of [false, true]) {
        out.push([`cell`, cellMenu({ state, filter: f, followColumn: "kiosk_id", openAsTable })]);
      }
    }
  }
  for (const sortable of [false, true]) {
    for (const flag of [false, true]) {
      out.push([
        "header",
        headerMenu({ column: "id", sortable, hideable: flag, sort: [{ column: "x", desc: false }], filterable: flag, structure: flag }),
      ]);
    }
  }
  for (const mac of [false, true]) out.push(["panel-row", panelRowMenu({ pinned: mac, mac })]);
  for (const table of [false, true]) {
    out.push(["tab", tabMenu({ table, preview: table, tabCount: 3, closedTabs: 2 })]);
  }
  for (const postgres of [false, true]) {
    out.push(["rail-tile", railTileMenu({ hasConnection: true, connected: true, postgres })]);
  }
  out.push(["rail-tile", railTileMenu({ hasConnection: false, connected: false, postgres: false })]);
  out.push(["chip", chipMenu({ chipCount: 3 })], ["help", helpMenu()]);
  return out;
}

describe("context menus", () => {
  test("every row's keycap is its command's chord under each keymap, on both platforms", () => {
    for (const { id: keymap } of KEYMAPS) {
      for (const [menu, rows] of allMenus()) {
        for (const row of rows) {
          if (row.command === undefined) {
            expect(rowKeys(row, true, keymap), `${menu}/${row.id}`).toBeUndefined();
            continue;
          }
          const cmd = commandById(row.command);
          expect(cmd, `${menu}/${row.id} names ${row.command}`).toBeDefined();
          const chord = chordFor(cmd!, keymap);
          for (const mac of [true, false]) {
            expect(rowKeys(row, mac, keymap), `${keymap} ${menu}/${row.id}`).toBe(chord && formatChord(chord, mac));
          }
        }
      }
    }
  });

  test("a keymap's swapped chord is what the menus print", () => {
    const rail = (keymap: "rowkery" | "tableplus") =>
      Object.fromEntries(
        railTileMenu({ hasConnection: true, connected: true, postgres: true }).map((r) => [r.id, rowKeys(r, true, keymap)]),
      );
    expect(rail("rowkery")["new-window"]).toBe("⌘T");
    expect(rail("tableplus")["new-window"]).toBe("⌥⌘T");
    const tab = (keymap: "rowkery" | "tableplus" | "datagrip", mac: boolean) =>
      rowKeys({ id: "new-tab", label: "New query tab", command: "new-tab" }, mac, keymap);
    expect(tab("rowkery", true)).toBeUndefined();
    expect(tab("tableplus", true)).toBe("⌘T");
    expect(tab("tableplus", false)).toBe("Ctrl+T");
    expect(tab("datagrip", true)).toBe("⇧⌘L");
    const header = headerMenu({ column: "id", sortable: false, hideable: false, sort: [], filterable: false, structure: true });
    expect(rowKeys(header.find((r) => r.id === "structure")!, true, "tableplus")).toBe("⌃⌘]");
  });

  test("the panel row's Structure prints no chord: ⌥⌘2 acts on the shown tab, not the row", () => {
    for (const mac of [true, false]) {
      const structure = panelRowMenu({ pinned: false, mac }).find((r) => r.id === "structure")!;
      expect(structure.command).toBeUndefined();
      expect(rowKeys(structure, mac)).toBeUndefined();
    }
  });

  test("⇧-click is macOS's glyph; elsewhere the hint says Shift", () => {
    const hint = (mac: boolean) =>
      headerMenu({ column: "id", sortable: true, hideable: false, sort: [{ column: "x", desc: false }], filterable: false, structure: false, mac }).find(
        (r) => r.id === "secondary",
      )?.hint;
    expect(hint(true)).toBe("⇧-click");
    expect(hint(false)).toBe("Shift-click");
  });

  test("Delete row counts the rows it marks, and restores marked ones", () => {
    const label = (s: Partial<typeof base>) => cellMenu({ state: { ...base, ...s } }).find((r) => r.id === "delete-row")?.label;
    const editable = { tableTab: true, hasRows: true, rowsEditable: true, rowsSelected: true };
    expect(label({ ...editable, selectedRows: 1 })).toBe("Delete row");
    expect(label({ ...editable, selectedRows: 3 })).toBe("Delete 3 rows");
    expect(label({ ...editable, selectedRows: 3, rowsMarked: true })).toBe("Restore 3 rows");
    expect(label({ ...editable, rowsSelected: false })).toBeUndefined();
  });

  test("hints are pointer gestures, never keys", () => {
    for (const [menu, rows] of allMenus()) {
      for (const row of rows) {
        if (row.hint) expect(row.hint, `${menu}/${row.id}`).toMatch(/click$/);
      }
    }
  });

  test("the keys menus print read as the registry's", () => {
    const keys = (rows: MenuRow[]) => Object.fromEntries(rows.map((r) => [r.id, rowKeys(r, true)]));
    expect(keys(cellMenu({ state: base, filter }))).toMatchObject({ "quick-look": "Space", csv: "⌘C", "csv-header": "⇧⌘C" });
    expect(keys(headerMenu({ column: "id", sortable: true, hideable: true, sort: [], filterable: true, structure: true }))).toMatchObject({
      filter: "⌘F",
      structure: "⌥⌘2",
    });
    expect(keys(panelRowMenu({ pinned: false, mac: true }))).toMatchObject({ structure: undefined, insert: "⌥↵" });
    expect(keys(tabMenu({ table: true, preview: false, tabCount: 2, closedTabs: 1 }))).toMatchObject({
      "edit-sql": "⌘E",
      "refresh-rows": undefined,
      close: "⌘W",
      reopen: "⇧⌘T",
    });
    expect(keys(railTileMenu({ hasConnection: true, connected: true, postgres: true }))).toMatchObject({
      "switch-database": "⇧⌘D",
      "switch-connection": "⇧⌘O",
      "new-window": "⌘T",
      "close-window": "⇧⌘W",
    });
    expect(keys(chipMenu({ chipCount: 1 }))).toMatchObject({ remove: "⌫", add: "⌘F" });
    expect(rowKeys({ id: "r", label: "Remove filter", command: "remove-filter" }, false)).toBe("Backspace");
    expect(keys(helpMenu())).toMatchObject({ "keyboard-shortcuts": "⇧⌘/", palette: "⌘K" });
  });

  test("a NOT NULL column's cell offers no IS NULL filter", () => {
    const ids = (nullable: boolean | undefined) => cellMenu({ state: base, filter: { ...filter, nullable } }).map((r) => r.id);
    expect(ids(false)).not.toContain("f-null");
    expect(ids(false)).toEqual(expect.arrayContaining(["f-only", "f-hide"]));
    expect(ids(true)).toContain("f-null");
    expect(ids(undefined)).toContain("f-null");
  });

  test("↵ edit and ⌘↵ follow print only where their command can run", () => {
    const ids = (s: CommandState) => cellMenu({ state: s, filter, followColumn: "kiosk_id" }).map((r) => r.id);
    // Editing isn't built; following needs a key under the ring of a table tab's rows.
    expect(ids(base)).not.toContain("edit-cell");
    expect(ids({ ...base, tableTab: true })).not.toContain("follow-key");
    // A query tab's ⌘↵ runs its statement, so it never follows.
    expect(ids({ ...base, cellFollowable: true })).not.toContain("follow-key");
    // Once their predicate holds, the rows appear with the registry's keys.
    const on = cellMenu({ state: { ...base, tableTab: true, cellEditable: true, cellFollowable: true }, filter, followColumn: "kiosk_id" });
    expect(on.map((r) => [r.id, rowKeys(r, true)])).toEqual(
      expect.arrayContaining([
        ["edit-cell", "↵"],
        ["follow-key", "⌘↵"],
      ]),
    );
    // No foreign key under the ring: nothing to follow.
    expect(cellMenu({ state: { ...base, tableTab: true, cellFollowable: true }, followColumn: null }).map((r) => r.id)).not.toContain("follow-key");
  });

  test("planned and zone commands stay out of ⌘K", () => {
    for (const c of COMMANDS) if (c.planned) expect(c.palette, c.id).toBe(false);
  });

  test("no component types a keycap into a menu row", () => {
    // Rows print keys only through `command`; a `shortcut:` field would bypass the registry.
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
      expect(readFileSync(dir + file, "utf8"), file).not.toMatch(/\bshortcut:\s*["'`(]/);
    }
  });
});
