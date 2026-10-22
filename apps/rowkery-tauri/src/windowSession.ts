import type { LocalServer } from "./api";
import type { ConnectionState } from "./ConnectionSwitcher";
import type { ReportContext } from "./report";
import type { SettingsSection } from "./SettingsPage";
import type { ConnectionEnv, MaskedColumns, SafeMode, SchemaCatalog } from "./types";

/** A window's connection as the app shell tracks it. */
export interface WindowSession {
  id: string;
  connectionId: string | null;
  /** Database the window is on; null until it has connected once. */
  database: string | null;
  state: ConnectionState;
  schema: SchemaCatalog | null;
  /** From the last connect: "16.4" for Postgres, the SQLite library version. */
  serverVersion: string | null;
  connectMs: number | null;
  error: string | null;
  /** When `schema` was loaded (ms since epoch). */
  schemaAt: number | null;
  /** A reload asked for by hand (refresh button, ⌘R) is running. */
  refreshing: boolean;
}

/** Things a window asks the app shell to do. */
export interface WindowActions {
  selectConnection: (id: string) => void;
  reconnect: () => void;
  newConnection: () => void;
  editConnection: (id: string, mark?: { field: string; message: string }) => void;
  /** Connect the window again, on the same database (a failed connection's Retry). */
  retryConnect: () => void;
  openConnectionSwitcher: () => void;
  openDatabaseSwitcher: () => void;
  newWindow: () => void;
  closeWindow: () => void;
  cycleWindow: (dir: 1 | -1) => void;
  setEnvironment: (env: ConnectionEnv | null) => void;
  setSafeMode: (mode: SafeMode) => void;
  setAllowMcp: (allow: boolean) => void;
  /** The grid header's Mark as sensitive: a connection's whole sensitive-column map. */
  setMaskedColumns: (id: string, masked: MaskedColumns) => void;
  /** ⌘K MCP activity / MCP access / Connect an agent. */
  /** The Agents page: at its log, its switches, with Connect an agent open, or wherever it last was. */
  openMcp: (tab: "activity" | "access" | "connect" | "page" | "edit") => void;
  /** Agents' proposed changes, on the review page. */
  reviewProposals: () => void;
  toggleSidebar: () => void;
  /**
   * Reloads a window's schema in the background, keeping the current one
   * meanwhile. `manual` (refresh button, ⌘R) shows a spinner and a toast.
   */
  refreshSchema: (windowId: string, manual?: boolean) => void;
  /** Opens the Report an Issue sheet with this window's context. */
  reportIssue: (context: ReportContext) => void;
  /** ⌘K Open (`reset` false) / Reset (`reset` true) the sample database. */
  openSample: (reset: boolean) => void;
  /** ⇧⌘/: the keyboard shortcuts sheet. */
  openShortcuts: () => void;
  /** Help > Third-party Notices: the notices sheet. */
  openNotices: () => void;
  /** Rowkery > Check for Updates…: says what it found (updates.ts). */
  checkForUpdates: () => void;
  /** ⌘,, the foot's gear or its update button: the Settings page, on a section. */
  openSettings: (section?: SettingsSection) => void;
  /** ⌘O: the file dialog; the file becomes a connection named after it. */
  openSqliteFile: () => void;
  /** A SQLite file by path (pasted into ⌘K): a connection named after it. */
  openSqlitePath: (path: string) => void;
  /** ⌘V outside a text field (or the editor toast's Connect): the sheet filled from `text`, or from the clipboard. */
  pasteConnection: (text?: string, openAnyway?: boolean) => void;
  /** A Found on this Mac row: connect with libpq's defaults, or open the sheet on failure. */
  connectFound: (server: LocalServer) => void;
  /** The import panel's Connection picker: Import CSV `path` in a window on that connection. */
  importInConnection: (id: string, path: string) => void;
}
