import { commandById, keysFor, type CommandState } from "./commands";
import { activeKeymap, type KeymapId } from "./keymaps";
import { isMacPlatform } from "./platform";
import type { SortKey } from "./tableSort";

/**
 * The rows of every right-click menu (grid cells and headers, schema panel
 * rows, tabs, window pills, filter chips, the Help menu). A row prints a
 * key only through `command`, so the chord is the registry's (commands.ts)
 * and can't drift; pointer gestures go in `hint`. Rendered by `GridMenu`.
 */
export interface MenuRow {
  id: string;
  label: string;
  /** The registry command whose chord the row prints on the right. */
  command?: string;
  /** A pointer gesture printed where the key would be ("click", "⇧-click"); never a key. */
  hint?: string;
  /** A choice among the menu's rows: the current one carries a check. */
  checked?: boolean;
  /** A dim word after the label ("= equals"). */
  gloss?: string;
  /** A thin rule above the row. */
  separated?: boolean;
}

/** The keycap a row prints: its command's chord under the keymap (the active one), else nothing. */
export function rowKeys(row: MenuRow, mac: boolean, keymap: KeymapId = activeKeymap()): string | undefined {
  return (row.command && keysFor(row.command, mac, keymap)) || undefined;
}

/** The modifier a click is held with to keep a table in its own tab. */
const modClick = (mac: boolean) => (mac ? "⌘-click" : "Ctrl-click");

/** Rows whose command can run now (`canRun`), so nothing is advertised that can't. */
const runnable = (id: string, s: CommandState) => !!commandById(id)?.canRun(s);

export interface CellFilter {
  column: string;
  isNull: boolean;
  /** False for a NOT NULL column: no "IS NULL" row (it would always be empty). */
  nullable?: boolean;
  /** The value as the chip would read it (`7`, `'KL'`), shortened. */
  shown: string;
}

/**
 * Right-click a cell (or a block, or a row number). ↵ edit and ⌘↵ follow
 * print only where their command can run; a table tab adds the filter rows
 * for the cell under the ring; a query result that reads one table offers it
 * as a table tab.
 */
export function cellMenu(o: {
  state: CommandState;
  filter?: CellFilter | null;
  followColumn?: string | null;
  openAsTable?: boolean;
}): MenuRow[] {
  const rows: MenuRow[] = [{ id: "quick-look", label: "Quick Look", command: "quick-look" }];
  if (runnable("edit-cell", o.state)) rows.push({ id: "edit-cell", label: "Edit cell", command: "edit-cell" });
  // Staging only: nothing is written until the tray's Commit.
  if (runnable("set-null", o.state)) rows.push({ id: "set-null", label: "Set NULL", command: "set-null" });
  if (runnable("insert-row", o.state)) rows.push({ id: "insert-row", label: "Insert row", command: "insert-row" });
  if (runnable("duplicate-row", o.state)) rows.push({ id: "duplicate-row", label: "Duplicate row", command: "duplicate-row" });
  if (runnable("delete-row", o.state)) rows.push({ id: "delete-row", label: "Delete row", command: "delete-row" });
  if (o.followColumn && runnable("follow-key", o.state))
    rows.push({ id: "follow-key", label: `Follow ${o.followColumn}`, command: "follow-key" });
  const f = o.filter;
  if (f) {
    const filters: MenuRow[] = f.isNull
      ? [
          { id: "f-null", label: `Rows where ${f.column} IS NULL` },
          { id: "f-not-null", label: `Hide rows where ${f.column} IS NULL` },
        ]
      : [
          { id: "f-only", label: `Only rows where ${f.column} = ${f.shown}` },
          { id: "f-hide", label: `Hide rows where ${f.column} = ${f.shown}` },
          ...(f.nullable === false ? [] : [{ id: "f-null", label: `Rows where ${f.column} IS NULL` }]),
        ];
    rows.push({ ...filters[0], separated: true }, ...filters.slice(1));
  }
  rows.push(
    { id: "csv", label: "Copy", command: "copy-cells", separated: true },
    { id: "csv-header", label: "Copy as CSV with headers", command: "copy-cells-with-headers" },
  );
  if (o.openAsTable) rows.push({ id: "open-table", label: "Open as table tab", separated: true });
  return rows;
}

/** Right-click a column header: sort, filter, hide, copy its name, the table's Structure. */
export function headerMenu(o: {
  column: string | undefined;
  sortable: boolean;
  hideable: boolean;
  sort: SortKey[] | undefined;
  /** A table tab: ⌘F filters by this column. */
  filterable: boolean;
  /** The result is a table's: ⌥⌘2 shows its Structure. */
  structure: boolean;
  /** The column is sensitive (Unmark) or not (Mark as sensitive); undefined: no row. */
  marked?: boolean;
  /** macOS glyphs (⇧-click); the platform's by default. */
  mac?: boolean;
}): MenuRow[] {
  const rows: MenuRow[] = [];
  if (o.sortable) {
    rows.push({ id: "asc", label: "Sort ascending", hint: "click" }, { id: "desc", label: "Sort descending" });
    if (o.sort?.some((k) => k.column === o.column)) rows.push({ id: "clear", label: "Clear sort" });
    if (o.sort?.length && !o.sort.some((k) => k.column === o.column))
      rows.push({ id: "secondary", label: "Secondary sort", hint: (o.mac ?? isMacPlatform()) ? "⇧-click" : "Shift-click" });
  }
  const more: MenuRow[] = [];
  if (o.filterable) more.push({ id: "filter", label: "Filter by this column", command: "filter-rows" });
  if (o.hideable) more.push({ id: "hide", label: "Hide column" });
  more.push({ id: "copy-name", label: "Copy column name" });
  if (o.structure) more.push({ id: "structure", label: "Structure", command: "show-structure" });
  if (o.marked !== undefined) more.push({ id: "mark", label: o.marked ? "Unmark sensitive" : "Mark as sensitive", separated: true });
  if (rows.length) more[0] = { ...more[0], separated: true };
  return [...rows, ...more];
}

/** Right-click a table or view in the schema panel. `importable`: a table (not a view) a CSV can go into. */
export function panelRowMenu(o: { pinned: boolean; mac: boolean; importable?: boolean }): MenuRow[] {
  return [
    { id: "open", label: "Open", hint: "click" },
    { id: "open-tab", label: "Open in a new tab", hint: modClick(o.mac) },
    // No chord: ⌥⌘2 acts on the shown tab, not on the row under the pointer.
    { id: "structure", label: "Structure" },
    ...(o.importable ? [{ id: "import-csv", label: "Import CSV…" }] : []),
    { id: "insert", label: "Insert name", command: "insert-name", separated: true },
    { id: "copy-name", label: "Copy name" },
    { id: "pin", label: o.pinned ? "Unpin" : "Pin to top", separated: true },
  ];
}

/** Right-click a query or table tab (it is selected first, so its keys act on it). */
export function tabMenu(o: { table: boolean; preview: boolean; tabCount: number; closedTabs: number }): MenuRow[] {
  const rows: MenuRow[] = [];
  if (o.preview) rows.push({ id: "keep", label: "Keep open", hint: "double-click" });
  if (o.table) {
    rows.push(
      { id: "edit-sql", label: "Edit SQL", command: "open-in-query" },
      { id: "refresh-rows", label: "Refresh rows", command: "refresh-rows" },
    );
  }
  rows.push({ id: "new-tab", label: "New query tab", command: "new-tab", separated: rows.length > 0 });
  rows.push({ id: "close", label: "Close tab", command: "close-tab", separated: true });
  if (o.tabCount > 1) rows.push({ id: "close-others", label: "Close other tabs" });
  if (o.closedTabs > 0) rows.push({ id: "reopen", label: "Reopen closed tab", command: "reopen-closed-tab" });
  return rows;
}

/** Right-click a window's pill in the title bar (it is selected first). */
export function railTileMenu(o: { hasConnection: boolean; connected: boolean; postgres: boolean }): MenuRow[] {
  const rows: MenuRow[] = [];
  if (o.connected && o.postgres) rows.push({ id: "switch-database", label: "Switch database…", command: "switch-database" });
  if (o.hasConnection) {
    rows.push(
      { id: "switch-connection", label: "Switch connection…", command: "switch-connection" },
      { id: "edit-connection", label: "Edit connection…", command: "edit-connection" },
      { id: "reconnect", label: "Reconnect", command: "reconnect" },
    );
  }
  rows.push(
    { id: "new-window", label: "New window", command: "new-window", separated: rows.length > 0 },
    { id: "close-window", label: "Close window", command: "close-window" },
  );
  return rows;
}

/** Right-click a filter chip in the SQL line. */
export function chipMenu(o: { chipCount: number }): MenuRow[] {
  const rows: MenuRow[] = [
    { id: "edit", label: "Edit filter", hint: "click" },
    { id: "remove", label: "Remove filter", command: "remove-filter" },
    { id: "copy-sql", label: "Copy as SQL" },
    { id: "add", label: "Add a filter", command: "filter-rows", separated: true },
  ];
  if (o.chipCount > 1) rows.push({ id: "clear", label: "Remove all filters" });
  return rows;
}

/** The Help menu's rows. */
export function helpMenu(): MenuRow[] {
  return [
    { id: "keyboard-shortcuts", label: "Keyboard shortcuts", command: "keyboard-shortcuts" },
    { id: "palette", label: "Command palette", command: "command-palette" },
    { id: "check-updates", label: "Check for updates…", command: "check-updates" },
    { id: "report-issue", label: "Report an issue…", command: "report-issue" },
  ];
}
