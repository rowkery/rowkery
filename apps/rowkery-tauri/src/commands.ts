import { KEYMAP_CHORDS, activeKeymap, type KeymapId } from "./keymaps";
import { isMacPlatform } from "./platform";
import { waitingCount } from "./proposals";
import { savedNativeDecorations } from "./windowChrome";
import { CONNECTION_ENVS, SAFE_MODES, type ConnectionEnv, type SafeMode } from "./types";
import { THEME_SETTINGS, type ThemeSetting } from "./theme";

/**
 * The one list of app commands: id, title, chord, when it can run and where
 * the macOS menu bar shows it. ⌘K lists `availableCommands`; the menu bar is
 * built in Rust from `src-tauri/menu.json`, which `menuSpec()` generates from
 * `MENU_BAR` (`npm test` fails when it is stale; `UPDATE_MENU=1 npm test`
 * rewrites it), and the page keeps its items enabled by `canRun`
 * (menuSync.ts). The shortcut sheet, tooltips (`keysFor`) and the key strip
 * read the same list, through the active keymap (keymaps.ts).
 */

/** What decides whether a command can run now; built once per render in Workspace. */
export interface CommandState {
  connected: boolean;
  /** Connecting or loading the schema. */
  busy: boolean;
  /** The shown query tab has a query running. */
  running: boolean;
  tableTab: boolean;
  /** The shown tab is the Sessions tab (no editor, no grid of results). */
  sessionsTab?: boolean;
  tabCount: number;
  hasSchema: boolean;
  sidebarHidden: boolean;
  /** The window has a connection picked (it may still be connecting or failed). */
  hasConnectionId: boolean;
  /** The picked connection's record, once loaded. */
  connection: {
    postgres: boolean;
    environment: ConnectionEnv | null;
    safeMode: SafeMode;
    /** Shared with the MCP server (`Rowkery --mcp`). */
    allowMcp?: boolean;
  } | null;
  windowCount: number;
  hasResult: boolean;
  hasRows: boolean;
  /** The shown tab was opened from a table (Data | Structure | Map applies). */
  hasActiveTable: boolean;
  resultsView: "data" | "structure" | "map";
  /** The window's connection failed (⌘R retries, ⌘E edits it). */
  failed: boolean;
  /** Rows the shown result has loaded, and whether more remain unloaded. */
  loadedRows: number;
  moreRows: boolean;
  /** Tabs closed in this window this session (⌘⇧T reopens them). */
  closedTabs: number;
  /** The window's history has a step back / forward. */
  historyBack: boolean;
  historyForward: boolean;
  /** The sample database is in the connection list. */
  hasSample: boolean;
  /** A key strip zone has retired (⌘K Show key hints brings it back). */
  hintsRetired: boolean;
  /**
   * The shown table tab's rows can be edited: a table with a primary key,
   * safe mode not Read-only, the Data view (editBuffer.ts `editRefusal`).
   */
  rowsEditable?: boolean;
  /** `rowsEditable`, and the grid's selected cell is in a column with an editor. */
  cellEditable?: boolean;
  /** `cellEditable`, the column takes NULL and the cell's row isn't marked for delete: Set NULL. */
  cellNullable?: boolean;
  /** Whole rows are selected in the grid (row numbers): ⌫ marks them for delete. */
  rowsSelected?: boolean;
  /** Staged edits waiting in the shown table tab's tray. */
  pendingEdits?: number;
  /** A write waits for ⇧⌘↵: a held statement, held edits, or Review SQL is open. */
  writeHeld?: boolean;
  /** The grid's selected cell holds a single-column foreign key (not NULL) of a table tab's rows. */
  cellFollowable?: boolean;
  /** ⌘K Hide tips was used (Tips.ts). */
  tipsHidden?: boolean;
  /** The appearance setting (theme.ts): Auto follows the system. */
  theme?: ThemeSetting;
  /** Presenting (presenting.ts): sensitive columns show as dots, the host is hidden. */
  presenting?: boolean;
  /** New connection is open in the inspector: ⌘↵ saves it, nothing runs. */
  connectionForm?: boolean;
  /** What ⌘W closes: the area used last, the query tab or the window (closeScope.ts). */
  closeScope?: "tab" | "connection";
}

/**
 * A chord in a platform-neutral form: modifiers `Ctrl`, `Alt`, `Shift`, `Mod`
 * (⌘ on macOS, Ctrl elsewhere) then the key, joined by `+`, e.g. `Mod+Shift+O`.
 * `other` overrides the Linux / Windows form when it is not a plain mapping.
 */
export interface Chord {
  mac: string;
  other?: string;
}

export type MenuSubmenu = "Rowkery" | "File" | "Edit" | "Connection" | "Query" | "View" | "Go" | "Window" | "Help";

/** The shortcut sheet's sections, in order (menu-bar order, then the zones). */
export const SHEET_SECTIONS = [
  "Connection",
  "Query",
  "Editor",
  "Grid",
  "Schema panel",
  "View",
  "Navigate",
  "Windows",
  "Help",
] as const;
export type SheetSection = (typeof SHEET_SECTIONS)[number];

export interface Command {
  id: string;
  /** ⌘K title. A function when it reads the state (Show / Hide sidebar). */
  title: string | ((s: CommandState) => string);
  chord?: Chord;
  /** Extra words ⌘K matches; a hit on one scores as a title hit. */
  synonyms?: string[];
  canRun: (s: CommandState) => boolean;
  /**
   * Its macOS menu bar title (Title Case); where it sits is `MENU_BAR`. A
   * function when it reads the state; the page pushes the text (menuSync.ts).
   */
  menuTitle?: string | ((s: CommandState) => string);
  /** Its shortcut sheet section when it isn't in the menu bar. */
  section?: SheetSection;
  /**
   * The chord equals a predefined macOS menu accelerator, and app_menu leaves
   * that predefined item out and binds this command instead. Must say why.
   */
  replacesPredefined?: string;
  /**
   * The chord is a predefined Edit item's (⌘C) and keeps it: the focused
   * zone's keydown handles the key before the menu does. Must say where.
   */
  sharesPredefined?: string;
  /**
   * False: ⌘K leaves it out, because it acts on what is under the pointer or
   * selected in its zone (a cell, a chip, a panel row). Context menus still
   * print its chord.
   */
  palette?: false;
  /** Not built yet: its key is reserved, and no menu or sheet prints it until `canRun` can be true. */
  planned?: true;
}

const always = () => true;

const copiedRows = (s: CommandState) =>
  s.moreRows ? `Copy loaded ${s.loadedRows.toLocaleString()} rows` : "Copy results";

const envCommands = (): Command[] => [
  ...CONNECTION_ENVS.map(
    (e): Command => ({
      id: `env:${e.value}`,
      title: `Set environment: ${e.label} (${e.value})`,
      canRun: (s) => !!s.connection && s.connection.environment !== e.value,
    }),
  ),
  {
    id: "env:none",
    title: "Clear environment",
    canRun: (s) => !!s.connection?.environment,
  },
  // Light or dark Paper; Auto follows the system (theme.ts).
  ...THEME_SETTINGS.map(
    (t): Command => ({
      id: `theme:${t.value}`,
      title: t.value === "auto" ? "Appearance: match the system" : `Appearance: ${t.label.toLowerCase()}`,
      menuTitle: t.value === "auto" ? "Match System Appearance" : `${t.label} Appearance`,
      synonyms: ["theme", "appearance", "dark", "light", "mode"],
      canRun: (s) => (s.theme ?? "auto") !== t.value,
    }),
  ),
  {
    id: "history-back",
    title: "Back",
    menuTitle: "Back",
    // Ctrl+[ is Esc in some toolkits: browser-style Alt+← elsewhere.
    chord: { mac: "Mod+[", other: "Alt+Left" },
    canRun: (s) => s.historyBack,
  },
  {
    id: "history-forward",
    title: "Forward",
    menuTitle: "Forward",
    chord: { mac: "Mod+]", other: "Alt+Right" },
    canRun: (s) => s.historyForward,
  },
  {
    id: "reopen-closed-tab",
    title: "Reopen closed tab",
    menuTitle: "Reopen Closed Tab",
    chord: { mac: "Mod+Shift+T" },
    synonyms: ["closed", "reopen"],
    canRun: (s) => s.closedTabs > 0,
  },
  {
    id: "change-safe-mode",
    title: "Change safe mode…",
    menuTitle: "Change Safe Mode…",
    synonyms: ["safe", "readonly", "confirm"],
    canRun: (s) => !!s.connection,
  },
  ...SAFE_MODES.map(
    (m): Command => ({
      id: `safe:${m.value}`,
      title: `Safe mode: ${m.label}`,
      canRun: (s) => !!s.connection && s.connection.safeMode !== m.value,
    }),
  ),
  {
    id: "mcp:on",
    title: "Share this connection with agents",
    synonyms: ["mcp", "claude", "agent", "share"],
    canRun: (s) => !!s.connection && !s.connection.allowMcp,
  },
  {
    id: "mcp:off",
    title: "Stop sharing this connection with agents",
    synonyms: ["mcp", "claude", "agent", "share"],
    canRun: (s) => !!s.connection && !!s.connection.allowMcp,
  },
  {
    id: "mcp-activity",
    title: "MCP activity",
    synonyms: ["mcp", "claude", "agent", "log", "audit", "history"],
    canRun: () => true,
  },
  {
    id: "mcp-access",
    title: "MCP access: what agents can reach",
    synonyms: ["mcp", "claude", "agent", "boundaries", "map", "permissions"],
    canRun: () => true,
  },
  {
    id: "mcp-edit-access",
    title: "Edit MCP access: databases and tables",
    synonyms: ["mcp", "claude", "agent", "tables", "databases", "whitelist", "share", "pick"],
    canRun: (s) => !!s.connection?.allowMcp,
  },
  {
    id: "mcp-connect",
    title: "Connect Claude Code or Claude Desktop",
    synonyms: ["mcp", "claude", "agent", "setup", "install", "desktop", "connect"],
    canRun: () => true,
  },
  {
    id: "review-proposals",
    title: "Review proposed changes",
    synonyms: ["mcp", "claude", "agent", "proposal", "change", "write", "approve"],
    canRun: () => waitingCount() > 0,
  },
  {
    id: "agents",
    title: "Agents",
    menuTitle: "Agents",
    chord: { mac: "Mod+Shift+A" },
    synonyms: ["mcp", "claude", "agent", "agents", "sharing"],
    canRun: () => true,
  },
];

/** Keys that act inside one zone (grid, schema panel, SQL line); context menus print them. */
const zoneCommands = (): Command[] => [
  {
    id: "copy-cells",
    title: "Copy",
    section: "Grid",
    chord: { mac: "Mod+C" },
    sharesPredefined: "the grid's keydown copies its selection before Edit > Copy sees the key",
    palette: false,
    canRun: (s) => s.hasRows,
  },
  {
    id: "copy-cells-with-headers",
    title: "Copy as CSV with headers",
    section: "Grid",
    chord: { mac: "Mod+Shift+C" },
    palette: false,
    canRun: (s) => s.hasRows,
  },
  {
    id: "quick-look",
    title: "Quick Look",
    section: "Grid",
    chord: { mac: "Space" },
    synonyms: ["row", "preview", "inspect"],
    canRun: (s) => s.hasRows && s.resultsView === "data",
  },
  {
    id: "edit-cell",
    title: "Edit cell",
    section: "Grid",
    chord: { mac: "Enter" },
    palette: false,
    canRun: (s) => !!s.cellEditable,
  },
  {
    id: "set-null",
    title: "Set NULL",
    section: "Grid",
    // ⌥⇧N types ˜ in a macOS text field (matched by code); Alt+Shift switches
    // the input language on Windows.
    chord: { mac: "Alt+Shift+N", other: "Ctrl+Alt+N" },
    palette: false,
    canRun: (s) => !!s.cellEditable && !!s.cellNullable,
  },
  {
    id: "delete-row",
    title: "Delete row",
    section: "Grid",
    // ⌫ on chips removes a filter; on whole rows selected in the grid, marks them.
    chord: { mac: "Backspace" },
    palette: false,
    canRun: (s) => !!s.rowsEditable && !!s.rowsSelected,
  },
  {
    id: "confirm-write",
    title: "Commit the held write",
    section: "Grid",
    // Shift, so a repeated ⌘↵ never commits.
    chord: { mac: "Mod+Shift+Enter" },
    palette: false,
    canRun: (s) => !!s.writeHeld,
  },
  {
    id: "follow-key",
    title: "Follow foreign key",
    section: "Grid",
    // ⌘↵ runs a query tab's statement and, in a table tab's grid, follows a key.
    chord: { mac: "Mod+Enter" },
    palette: false,
    canRun: (s) => !!s.cellFollowable && s.tableTab,
  },
  {
    id: "insert-name",
    title: "Insert name",
    section: "Schema panel",
    chord: { mac: "Alt+Enter" },
    palette: false,
    canRun: (s) => s.hasSchema,
  },
  {
    id: "remove-filter",
    title: "Remove filter",
    section: "Grid",
    chord: { mac: "Backspace" },
    palette: false,
    canRun: (s) => s.tableTab && !s.rowsSelected,
  },
];

/** Staged row edits on a table tab: the tray's keys, also in ⌘K. */
const editCommands = (): Command[] => [
  {
    id: "insert-row",
    title: "Insert row",
    section: "Grid",
    chord: { mac: "Mod+I" },
    synonyms: ["add row", "new row"],
    canRun: (s) => !!s.rowsEditable,
  },
  {
    id: "duplicate-row",
    title: "Duplicate row",
    section: "Grid",
    chord: { mac: "Mod+D" },
    synonyms: ["copy row"],
    canRun: (s) => !!s.cellEditable,
  },
  {
    id: "commit-edits",
    title: "Commit changes",
    section: "Grid",
    chord: { mac: "Mod+S" },
    synonyms: ["save", "apply"],
    canRun: (s) => !!s.pendingEdits,
  },
  {
    id: "review-sql",
    title: "Review SQL for changes",
    section: "Grid",
    chord: { mac: "Mod+Shift+P" },
    synonyms: ["preview", "pending"],
    canRun: (s) => !!s.pendingEdits,
  },
  {
    id: "discard-edits",
    title: "Discard changes",
    synonyms: ["revert", "pending"],
    canRun: (s) => !!s.pendingEdits,
  },
];

/** In ⌘K's empty-state order. */
export const COMMANDS: Command[] = [
  {
    id: "command-palette",
    title: "Search tables, queries and commands",
    chord: { mac: "Mod+K" },
    section: "Navigate",
    palette: false,
    canRun: always,
  },
  {
    id: "complete",
    title: "Complete at the caret",
    chord: { mac: "Ctrl+Space" },
    section: "Editor",
    palette: false,
    canRun: (s) => !s.tableTab && !s.sessionsTab,
  },
  {
    id: "run",
    title: "Run statement",
    menuTitle: "Run Statement",
    chord: { mac: "Mod+Enter" },
    canRun: (s) => s.connected && !s.busy && !s.tableTab && !s.sessionsTab && !s.connectionForm,
  },
  {
    id: "run-all",
    title: "Run all statements",
    menuTitle: "Run All Statements",
    chord: { mac: "Alt+Mod+Enter" },
    canRun: (s) => s.connected && !s.busy && !s.tableTab && !s.sessionsTab,
  },
  {
    id: "format-sql",
    title: "Format SQL",
    menuTitle: "Format SQL",
    // ⌘I on a query tab; a table tab's grid inserts a row with it.
    chord: { mac: "Mod+I" },
    synonyms: ["beautify", "prettify"],
    section: "Editor",
    // A running tab's editor is read-only and formats nothing; other tabs still can.
    canRun: (s) => s.hasConnectionId && !s.failed && !s.tableTab && !s.sessionsTab,
  },
  {
    id: "explain",
    title: "Explain statement",
    // ⌘E is Edit SQL on a table tab and Edit the failed connection while the
    // window's connection failed; this runs on a connected query tab only.
    chord: { mac: "Mod+E" },
    synonyms: ["plan", "query plan", "why is it slow"],
    section: "Query",
    canRun: (s) => s.connected && !s.busy && !s.tableTab && !s.connectionForm && !s.failed,
  },
  {
    id: "explain-timed",
    title: "Explain with timings",
    synonyms: ["explain analyze", "plan"],
    section: "Query",
    canRun: (s) => s.connected && !s.busy && !s.tableTab && !s.connectionForm && !s.failed && !!s.connection?.postgres,
  },
  {
    id: "open-in-query",
    title: "Edit SQL",
    menuTitle: "Edit SQL",
    chord: { mac: "Mod+E" },
    canRun: (s) => s.tableTab && !s.failed,
  },
  {
    id: "filter-rows",
    title: "Filter rows",
    menuTitle: "Filter Rows",
    chord: { mac: "Mod+F" },
    canRun: (s) => s.tableTab,
  },
  {
    id: "find-results",
    title: "Find in results",
    // ⌘F on a query tab: Filter rows takes it on a table tab.
    chord: { mac: "Mod+F" },
    synonyms: ["search rows"],
    canRun: (s) => !s.tableTab && s.hasRows,
  },
  {
    id: "cancel",
    title: "Cancel query",
    menuTitle: "Cancel Query",
    // ⌘. always cancels; Esc still does when nothing else is dismissible.
    // With nothing running, Esc discards a table tab's pending edits
    // (discard-edits, the gesture "esc-discard" below; 2026-10-13).
    chord: { mac: "Mod+." },
    canRun: (s) => s.running,
  },
  {
    id: "stop-all-queries",
    title: "Stop all queries",
    menuTitle: "Stop All Queries",
    synonyms: ["kill", "stuck", "force stop"],
    canRun: always,
  },
  { id: "new-tab", title: "New query tab", menuTitle: "New Query Tab", canRun: always },
  {
    id: "close-tab",
    title: "Close query tab",
    // ⌘W closes what was used last (closeScope.ts): the window when its
    // pill or schema column was; the menu says which.
    menuTitle: (s) => (s.closeScope === "connection" ? "Close Window" : "Close Tab"),
    chord: { mac: "Mod+W" },
    canRun: always,
    replacesPredefined:
      "app_menu has no predefined Close Window item; File > Close Tab owns ⌘W so it never closes the app",
  },
  { id: "next-tab", title: "Next query tab", menuTitle: "Next Query Tab", canRun: (s) => s.tabCount > 1 },
  { id: "prev-tab", title: "Previous query tab", menuTitle: "Previous Query Tab", canRun: (s) => s.tabCount > 1 },
  { id: "focus-editor", title: "Focus editor", menuTitle: "Focus Editor", canRun: always },
  {
    id: "filter-schema",
    title: "Filter schema",
    chord: { mac: "/" },
    section: "Schema panel",
    canRun: (s) => s.hasSchema,
  },
  {
    id: "toggle-sidebar",
    title: (s) => (s.sidebarHidden ? "Show sidebar" : "Hide sidebar"),
    menuTitle: (s) => (s.sidebarHidden ? "Show Sidebar" : "Hide Sidebar"),
    // ⌘B, as most apps; App.tsx also takes ⌃⌘S (Ctrl+Alt+S), the old chord.
    chord: { mac: "Mod+B" },
    canRun: always,
  },
  {
    id: "show-sessions",
    title: "Show sessions",
    menuTitle: "Sessions",
    synonyms: ["running", "activity", "locks", "blocking", "blocked", "slow", "kill", "cancel", "terminate", "processes", "pg_stat_activity"],
    canRun: (s) => s.connected && !!s.connection?.postgres,
  },
  {
    id: "presenting",
    title: (s) => (s.presenting ? "Stop presenting" : "Start presenting"),
    menuTitle: (s) => (s.presenting ? "Stop Presenting" : "Start Presenting"),
    synonyms: ["present", "screen", "sensitive", "hide", "privacy"],
    canRun: always,
  },
  {
    id: "new-connection",
    title: "New connection…",
    menuTitle: "New Connection…",
    chord: { mac: "Mod+N" },
    canRun: always,
  },
  {
    // The connection form's Test is a button with no chord: ⌘T is New window.
    id: "connection-test",
    title: "Test the connection",
    section: "Connection",
    palette: false,
    canRun: (s) => !!s.connectionForm,
  },
  {
    id: "connection-save",
    title: "Save and connect",
    section: "Connection",
    // ⌘↵ in the form; it never runs together with Run (run waits while the form is open).
    chord: { mac: "Mod+Enter" },
    palette: false,
    canRun: (s) => !!s.connectionForm,
  },
  {
    id: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    menuTitle: "Keyboard Shortcuts",
    chord: { mac: "Mod+Shift+/" },
    synonyms: ["help", "keys", "shortcuts", "hotkeys"],
    canRun: always,
  },
  {
    id: "show-key-hints",
    title: "Show key hints",
    menuTitle: "Show Key Hints",
    synonyms: ["hints", "strip"],
    canRun: (s) => s.hintsRetired,
  },
  {
    id: "settings",
    title: "Settings…",
    menuTitle: "Settings…",
    chord: { mac: "Mod+," },
    synonyms: ["preferences", "settings", "updates", "options", "appearance", "keymap"],
    canRun: always,
  },
  {
    id: "check-updates",
    title: "Check for updates…",
    menuTitle: "Check for Updates…",
    synonyms: ["update", "upgrade", "version"],
    canRun: always,
  },
  {
    id: "report-issue",
    title: "Report an issue…",
    menuTitle: "Report an Issue…",
    synonyms: ["feedback", "bug", "report"],
    canRun: always,
  },
  {
    // THIRD_PARTY_NOTICES.md (scripts/notices.mjs) in a sheet.
    id: "third-party-notices",
    title: "Third-party notices",
    menuTitle: "Third-party Notices",
    synonyms: ["licenses", "licences", "credits", "acknowledgements", "open source", "fonts", "about"],
    canRun: always,
  },
  {
    id: "hide-tips",
    title: "Hide tips",
    synonyms: ["tips", "hints"],
    canRun: (s) => !s.tipsHidden,
  },
  {
    // Linux / Windows only; decorations are fixed when the window is
    // created, so the switch applies on the next launch (windowChrome.ts).
    id: "window-controls",
    title: () =>
      savedNativeDecorations()
        ? "Use Rowkery window controls (next launch)"
        : "Use system window controls (next launch)",
    synonyms: ["title bar", "decorations", "native", "window buttons"],
    canRun: () => !isMacPlatform(),
  },
  {
    id: "switch-connection",
    title: "Switch connection…",
    menuTitle: "Switch Connection…",
    chord: { mac: "Mod+Shift+O" },
    canRun: always,
  },
  {
    id: "switch-database",
    title: "Switch database…",
    menuTitle: "Switch Database…",
    chord: { mac: "Mod+Shift+D" },
    canRun: (s) => s.connected && !!s.connection?.postgres,
  },
  { id: "new-window", title: "New window", menuTitle: "New Window", chord: { mac: "Mod+T" }, canRun: always },
  {
    id: "open-sqlite-file",
    title: "Open a SQLite file…",
    menuTitle: "Open SQLite File…",
    chord: { mac: "Mod+O" },
    canRun: always,
  },
  {
    id: "open-sample",
    title: "Open the sample database",
    menuTitle: "Open the Sample Database",
    synonyms: ["sample", "demo", "tutorial"],
    canRun: always,
  },
  {
    id: "reset-sample",
    title: "Reset the sample database",
    synonyms: ["reset sample"],
    canRun: (s) => s.hasSample,
  },
  {
    id: "close-window",
    title: "Close window",
    menuTitle: "Close Window",
    chord: { mac: "Mod+Shift+W" },
    canRun: (s) => s.windowCount > 1,
  },
  { id: "next-window", title: "Next window", menuTitle: "Next Window", canRun: (s) => s.windowCount > 1 },
  { id: "prev-window", title: "Previous window", menuTitle: "Previous Window", canRun: (s) => s.windowCount > 1 },
  {
    id: "refresh-rows",
    title: "Refresh rows",
    menuTitle: "Refresh Rows",
    chord: { mac: "Mod+Shift+R" },
    synonyms: ["reload", "rerun"],
    canRun: (s) => s.tableTab && s.connected && !s.running,
  },
  {
    id: "refresh-schema",
    title: "Refresh schema",
    menuTitle: "Refresh Schema",
    chord: { mac: "Mod+R" },
    canRun: (s) => s.connected,
  },
  {
    id: "retry-connect",
    title: "Retry connecting",
    // ⌘R is Refresh schema while connected, Retry while failed.
    chord: { mac: "Mod+R" },
    canRun: (s) => s.failed,
  },
  {
    id: "edit-failed-connection",
    title: "Edit the failed connection…",
    // ⌘E is Edit SQL on a table tab, and this while the window's connection
    // failed (the field that failed is marked). ⌘K lists Edit connection….
    chord: { mac: "Mod+E" },
    palette: false,
    canRun: (s) => s.failed,
  },
  {
    id: "reconnect",
    title: "Reconnect and reload schema",
    menuTitle: "Reconnect",
    canRun: (s) => s.hasConnectionId && !s.busy,
  },
  { id: "edit-connection", title: "Edit connection…", menuTitle: "Edit Connection…", canRun: (s) => !!s.connection },
  ...envCommands(),
  // While rows remain unloaded, the titles say which copy is which.
  { id: "copy-tsv", title: (s) => `${copiedRows(s)} as TSV`, canRun: (s) => s.hasRows },
  { id: "copy-csv", title: (s) => `${copiedRows(s)} as CSV`, menuTitle: "Copy Results as CSV", canRun: (s) => s.hasRows },
  {
    id: "copy-all-csv",
    title: "Copy all results as CSV",
    canRun: (s) => s.hasRows && s.moreRows && !s.running,
  },
  {
    id: "copy-all-tsv",
    title: "Copy all results as TSV",
    canRun: (s) => s.hasRows && s.moreRows && !s.running,
  },
  {
    id: "export",
    title: "Export results…",
    menuTitle: "Export Results…",
    chord: { mac: "Mod+Shift+E" },
    synonyms: ["export", "csv", "download"],
    canRun: (s) => s.hasRows && !s.running,
  },
  {
    // Into the shown table tab's table; the panel opens beside its grid (CsvImport.tsx).
    id: "import-csv",
    title: "Import CSV into this table…",
    menuTitle: "Import CSV…",
    synonyms: ["import", "csv", "tsv", "upload", "load", "file"],
    canRun: (s) => s.connected && s.tableTab && s.hasActiveTable && !s.busy,
  },
  { id: "clear-results", title: "Clear results", menuTitle: "Clear Results", canRun: (s) => s.hasResult },
  {
    id: "timings",
    title: "Timings",
    synonyms: ["timings", "speed", "slow", "latency"],
    canRun: always,
  },
  {
    id: "all-tables",
    title: "All tables as rows",
    synonyms: ["catalog", "all tables", "tables as rows"],
    canRun: (s) => s.hasSchema,
  },
  {
    id: "show-data",
    title: "Show data",
    menuTitle: "Data",
    chord: { mac: "Alt+Mod+1" },
    canRun: (s) => s.hasActiveTable && s.resultsView !== "data",
  },
  {
    id: "show-structure",
    title: "Show structure",
    menuTitle: "Structure",
    chord: { mac: "Alt+Mod+2" },
    canRun: (s) => s.hasActiveTable && s.resultsView !== "structure",
  },
  {
    id: "show-map",
    title: "Show map",
    menuTitle: "Map",
    chord: { mac: "Alt+Mod+3" },
    synonyms: ["map", "diagram", "erd", "relations", "foreign keys", "references"],
    canRun: (s) => s.hasActiveTable && s.resultsView !== "map",
  },
  ...zoneCommands(),
  ...editCommands(),
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id);
}

const MAC_MOD: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];
const OTHER_ORDER = ["Ctrl", "Alt", "Shift"];
const KEY_GLYPH: Record<string, string> = {
  Enter: "↵",
  Escape: "esc",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
};
/** Glyphs only macOS draws; elsewhere the key keeps its name. */
const MAC_KEY_GLYPH: Record<string, string> = { Backspace: "⌫" };

function splitChord(chord: string): { mods: Set<string>; key: string } {
  const parts = chord.split("+");
  // `Mod++` would be the + key; no command uses it.
  const key = parts.pop() ?? "";
  return { mods: new Set(parts), key };
}

/** `⇧⌘O` on macOS, `Ctrl+Shift+O` elsewhere; `esc`, `/` bare. */
export function formatChord(chord: Chord, mac: boolean): string {
  const { mods, key } = splitChord(mac ? chord.mac : (chord.other ?? chord.mac));
  const glyph = (mac && MAC_KEY_GLYPH[key]) || KEY_GLYPH[key] || key;
  if (mac) return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_MOD[m]).join("") + glyph;
  const other = new Set([...mods].map((m) => (m === "Mod" ? "Ctrl" : m)));
  return [...OTHER_ORDER.filter((m) => other.has(m)), glyph].join("+");
}

/** Tauri accelerator form (`CmdOrCtrl+Shift+O`) of a chord's macOS spelling. */
export function acceleratorFor(chord: Chord): string {
  const { mods, key } = splitChord(chord.mac);
  const names: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Mod: "CmdOrCtrl" };
  const order = ["Mod", "Ctrl", "Alt", "Shift"];
  return [...order.filter((m) => mods.has(m)).map((m) => names[m]), key].join("+");
}

/** The command's chord under a keymap (the active one by default). */
export function chordFor(c: Command, keymap: KeymapId = activeKeymap()): Chord | undefined {
  return KEYMAP_CHORDS[keymap][c.id] ?? c.chord;
}

/** Keycap text for a command id under the active keymap, or "" (tooltips, strip). */
export function keysFor(id: string, mac: boolean, keymap: KeymapId = activeKeymap()): string {
  const c = BY_ID.get(id);
  const chord = c && chordFor(c, keymap);
  return chord ? formatChord(chord, mac) : "";
}

/** A tooltip: the verb phrase, two spaces, the command's keycaps. */
export function tooltip(text: string, id: string, mac: boolean): string {
  const keys = keysFor(id, mac);
  return keys ? `${text}  ${keys}` : text;
}

/** e.code → the key names chords use. */
const CODE_KEY: Record<string, string> = {
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Escape: "Escape",
  Space: "Space",
  Period: ".",
  Comma: ",",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

/** Whether a keydown is this chord (by e.code, so ⌥ and layouts don't matter). */
export function eventMatches(
  e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  chord: Chord,
  mac: boolean,
): boolean {
  const { mods, key } = splitChord(mac ? chord.mac : (chord.other ?? chord.mac));
  const code = /^(Key[A-Z]|Digit\d)$/.test(e.code) ? e.code.slice(-1) : CODE_KEY[e.code];
  if (code !== key) return false;
  return (
    e.metaKey === (mac && mods.has("Mod")) &&
    e.ctrlKey === (mods.has("Ctrl") || (!mac && mods.has("Mod"))) &&
    e.altKey === mods.has("Alt") &&
    e.shiftKey === mods.has("Shift")
  );
}

/**
 * The command a keydown stands for under the active keymap: of the commands
 * on that chord, the first that can run now (⌘R: Refresh schema or Retry).
 */
export function matchCommand(
  e: Parameters<typeof eventMatches>[0],
  s: CommandState,
  mac: boolean,
  keymap: KeymapId = activeKeymap(),
): Command | undefined {
  return COMMANDS.find((c) => {
    const chord = chordFor(c, keymap);
    return !!chord && eventMatches(e, chord, mac) && c.canRun(s);
  });
}

/** Tooltips are a verb phrase and the keycap, this long at most. */
export const MAX_TIP = 75;

/**
 * A control's tooltip: `verb` (else the command's title) and the command's
 * keycap from this registry, e.g. `Switch connection  ⇧⌘O`, so a tooltip
 * can't print a different chord than ⌘K, the menu bar or the shortcut sheet.
 */
export function commandTip(id: string, verb?: string, mac = isMacPlatform()): string {
  const c = BY_ID.get(id);
  const label = verb ?? (c && typeof c.title === "string" ? c.title : id);
  const keys = commandKeys(id, mac);
  return keys ? `${label}  ${keys}` : label;
}

/** A command's keycap text under the active keymap (`⌘[`, `Alt+←`); "" when it has none. */
export function commandKeys(id: string, mac = isMacPlatform()): string {
  return keysFor(id, mac);
}

export function commandTitle(c: Command, s: CommandState): string {
  return typeof c.title === "function" ? c.title(s) : c.title;
}

export interface AvailableCommand {
  id: string;
  title: string;
  keys?: string;
  synonyms?: string[];
}

/** Commands that can run now, in registry order, with their keycap text. */
export function availableCommands(s: CommandState, mac: boolean): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const c of COMMANDS) {
    if (c.palette === false || !c.canRun(s)) continue;
    const chord = chordFor(c);
    out.push({
      id: c.id,
      title: commandTitle(c, s),
      keys: chord && formatChord(chord, mac),
      synonyms: c.synonyms,
    });
  }
  return out;
}

/**
 * The macOS menu bar's app items, in order; `null` is a separator. Rowkery's
 * items sit under About in the app menu, and Edit's below the native Undo,
 * Cut, Copy, Paste; Services, Hide, Quit and the native View / Window items
 * are added by app_menu around these. Commands whose chord is a bare key (`/`) stay out:
 * a menu key equivalent without a modifier would eat that key in text fields.
 */
export const MENU_BAR: { submenu: MenuSubmenu; items: (string | null)[] }[] = [
  { submenu: "Rowkery", items: ["check-updates", null, "settings"] },
  { submenu: "File", items: ["new-tab", "reopen-closed-tab", null, "close-tab"] },
  { submenu: "Edit", items: ["format-sql"] },
  {
    submenu: "Connection",
    items: [
      "new-connection",
      "open-sqlite-file",
      "open-sample",
      null,
      "switch-connection",
      "switch-database",
      "edit-connection",
      "change-safe-mode",
      null,
      "refresh-schema",
      "reconnect",
    ],
  },
  {
    submenu: "Query",
    items: [
      "run",
      "run-all",
      "cancel",
      "stop-all-queries",
      null,
      "open-in-query",
      "filter-rows",
      "refresh-rows",
      null,
      "copy-csv",
      "export",
      "import-csv",
      "clear-results",
    ],
  },
  {
    submenu: "View",
    items: ["toggle-sidebar", "presenting", null, "show-data", "show-structure", "show-map", "show-sessions", null, "theme:auto", "theme:light", "theme:dark"],
  },
  {
    submenu: "Go",
    items: ["history-back", "history-forward", null, "next-tab", "prev-tab", null, "focus-editor"],
  },
  { submenu: "Window", items: ["new-window", "close-window", null, "next-window", "prev-window", null, "agents"] },
  { submenu: "Help", items: ["keyboard-shortcuts", "show-key-hints", null, "report-issue", null, "third-party-notices"] },
];

/** Ids of every command in the menu bar. */
export const MENU_IDS: string[] = MENU_BAR.flatMap((m) => m.items.filter((i): i is string => i !== null));

/** A menu item's title: its `menuTitle`, read against the state when it is a function. */
export function menuTitle(c: Command, s: CommandState): string {
  const t = c.menuTitle ?? c.title;
  return typeof t === "function" ? t(s) : t;
}

export type MenuSpecItem = { id: string; title: string; accelerator: string | null } | { separator: true };

/**
 * What `src-tauri/menu.json` holds: each submenu's app items in order, with
 * the titles a fresh window shows (the page pushes later changes, menuSync.ts).
 */
export function menuSpec(): { submenu: MenuSubmenu; items: MenuSpecItem[] }[] {
  const fresh = { sidebarHidden: false } as CommandState;
  return MENU_BAR.map(({ submenu, items }) => ({
    submenu,
    items: items.map((id): MenuSpecItem => {
      if (id === null) return { separator: true };
      const c = BY_ID.get(id);
      if (!c) throw new Error(`MENU_BAR names an unknown command ${id}`);
      const chord = chordFor(c, "rowkery");
      return { id, title: menuTitle(c, fresh), accelerator: chord ? acceleratorFor(chord) : null };
    }),
  }));
}

export interface MenuItemState {
  enabled: boolean;
  /** Only for titles that read the state. */
  title?: string;
  /** The active keymap's accelerator. */
  accelerator: string | null;
}

/**
 * Each menu item's enabled state, accelerator under the active keymap and
 * (when it reads the state) title now: what the page pushes to app_menu.
 * Disabled, never hidden.
 */
export function menuState(s: CommandState, keymap: KeymapId = activeKeymap()): Record<string, MenuItemState> {
  const out: Record<string, MenuItemState> = {};
  for (const id of MENU_IDS) {
    const c = BY_ID.get(id)!;
    const chord = chordFor(c, keymap);
    out[id] = { enabled: c.canRun(s), accelerator: chord ? acceleratorFor(chord) : null };
    if (typeof (c.menuTitle ?? c.title) === "function") out[id].title = menuTitle(c, s);
  }
  return out;
}

/** The section a command's shortcut sheet row sits in. */
export function sheetSection(c: Command): SheetSection {
  if (c.section) return c.section;
  const sub = MENU_BAR.find((m) => m.items.includes(c.id))?.submenu;
  switch (sub) {
    case "Connection":
    case "Query":
    case "View":
    case "Help":
      return sub;
    case "Rowkery":
      return "Help";
    case "Window":
      return "Windows";
    default:
      return "Navigate";
  }
}

/**
 * Keys that aren't commands (gestures, and keys the page owns in one zone
 * like the grid's ⌘C), for the shortcut sheet's static rows. With a `chord`,
 * keyTracker counts presses in their zone (the key strip retires them); they
 * never count in "Used n of m".
 */
export interface Gesture {
  id: string;
  title: string;
  section: SheetSection;
  chord?: Chord;
  /** Printed as is when there is no chord (⇧-click, ⌘1–9). */
  keys?: { mac: string; other: string };
}

export const GESTURES: Gesture[] = [
  { id: "tab-expand-star", title: "Expand * into the column list", section: "Editor", keys: { mac: "⇥ after *", other: "Tab after *" } },
  { id: "copy-cells", title: "Copy the cell, or the block as CSV", section: "Grid", chord: { mac: "Mod+C" } },
  { id: "copy-cells-with-headers", title: "Copy the block with column names", section: "Grid", chord: { mac: "Mod+Shift+C" } },
  { id: "grid-select-all", title: "Select the whole result", section: "Grid", chord: { mac: "Mod+A" } },
  { id: "grid-extend", title: "Extend the selection", section: "Grid", keys: { mac: "⇧-click · ⇧↑↓←→", other: "Shift+click/arrows" } },
  { id: "grid-rows", title: "Select whole rows", section: "Grid", keys: { mac: "drag row numbers", other: "drag row numbers" } },
  { id: "grid-count", title: "Count the rows exactly", section: "Grid", keys: { mac: "#", other: "#" } },
  { id: "map-move", title: "Map: move between tables", section: "View", keys: { mac: "↑↓←→", other: "Arrows" } },
  { id: "map-centre", title: "Map: centre on the table", section: "View", keys: { mac: "Space", other: "Space" } },
  { id: "map-open", title: "Map: open the table (⌘↵ in its own tab)", section: "View", keys: { mac: "↵ · ⌘↵", other: "Enter · Ctrl+Enter" } },
  { id: "panel-open", title: "Browse the table", section: "Schema panel", chord: { mac: "Enter" } },
  { id: "panel-own-tab", title: "Open a table in its own tab", section: "Schema panel", keys: { mac: "⌘-click", other: "Ctrl-click" } },
  { id: "switch-window-n", title: "Switch to window 1–9", section: "Windows", keys: { mac: "⌘1–9", other: "Ctrl+1–9" } },
  { id: "agents-filter-tables", title: "Filter tables in Edit access", section: "Windows", chord: { mac: "Mod+F" } },
  { id: "shortcuts-here", title: "Keyboard shortcuts, from the grid or panel", section: "Help", keys: { mac: "?", other: "?" } },
  // Esc's last step (Workspace): after a cell editor and a running query, the pending edits go, with Undo.
  { id: "esc-discard", title: "Discard pending edits (Undo in the toast)", section: "Grid", keys: { mac: "esc", other: "Esc" } },
];

/** One row of the shortcut sheet: a command with a key, or a gesture. */
export interface SheetRow {
  id: string;
  title: string;
  keys: string;
  synonyms?: string[];
  /** A command: it has a used dot and counts in "Used n of m". */
  command: boolean;
  /** The keymap moved this chord. */
  remapped: boolean;
}

/**
 * The shortcut sheet's sections and rows under a keymap: every command with a
 * key (titles that read the state show their default), then the gestures.
 * The sheet draws it, and the docs' shortcut table is generated from it
 * (test/docs-tables.test.ts), so neither can drift from the registry.
 */
export function sheetRows(keymap: KeymapId, mac: boolean): { name: SheetSection; rows: SheetRow[] }[] {
  const by = new Map<SheetSection, SheetRow[]>(SHEET_SECTIONS.map((s) => [s, []]));
  for (const c of COMMANDS) {
    const chord = chordFor(c, keymap);
    // A key the grid or panel handles itself reads as its gesture row.
    if (!chord || c.planned || GESTURES.some((g) => g.id === c.id)) continue;
    const title = typeof c.title === "function" ? c.title({ sidebarHidden: false } as CommandState) : c.title;
    by.get(sheetSection(c))!.push({
      id: c.id,
      title,
      keys: formatChord(chord, mac),
      synonyms: c.synonyms,
      command: true,
      remapped: !!KEYMAP_CHORDS[keymap][c.id],
    });
  }
  for (const g of GESTURES) {
    by.get(g.section)!.push({ id: g.id, title: g.title, keys: gestureKeys(g, mac), command: false, remapped: false });
  }
  return SHEET_SECTIONS.map((name) => ({ name, rows: by.get(name)! })).filter((s) => s.rows.length > 0);
}

/** Keycap text for a gesture. */
export function gestureKeys(g: Gesture, mac: boolean): string {
  if (g.chord) return formatChord(g.chord, mac);
  return g.keys ? (mac ? g.keys.mac : g.keys.other) : "";
}

/**
 * Accelerators macOS predefines in an app's menu bar (Hide, Hide Others,
 * Quit, Minimize, Full Screen, Close Window, Undo, Redo, Cut, Copy, Paste,
 * Select All). A command bound to one would steal it or never fire.
 */
export const PREDEFINED_MAC_CHORDS = [
  "⌘H",
  "⌥⌘H",
  "⌘Q",
  "⌘M",
  "⌃⌘F",
  "⌘W",
  "⌘Z",
  "⇧⌘Z",
  "⌘X",
  "⌘C",
  "⌘V",
  "⌘A",
];
