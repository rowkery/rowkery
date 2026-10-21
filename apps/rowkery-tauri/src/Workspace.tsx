import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  applyChanges,
  browseTable,
  copyAllResults,
  reviewChanges,
  exportResults,
  browseTableSql,
  cancelCount,
  cancelQuery,
  countRows,
  stopAllQueries,
  closeQueryTab,
  explainConnectError,
  explainStatement,
  cancelPrefetch,
  countIncoming,
  followKeys,
  prefetchTable,
  runQuery,
  tableIndexes,
  type BrowseOptions,
  type BrowseRequest,
  type ConnectExplanation,
  type FollowLookup,
  type LocalServer,
  type QueryPlan,
} from "./api";
import { PlanView, copy as copyPlanText, planText } from "./PlanView";
import type { ConnectionState } from "./ConnectionSwitcher";
import { CommandPalette, type PickMode } from "./CommandPalette";
import { availableCommands, commandById, commandKeys, commandTip, keysFor, type CommandState } from "./commands";
import { ZoneMenu } from "./ZoneMenu";
import { hideTips, noteTrigger, retireTip, setQueryRunning, useTip, useTipsHidden } from "./Tips";
import { commandUses, recordCommandUse } from "./commandUses";
import { catalogResult } from "./catalogRows";
import { columnComments } from "./comments";
import { TimingsSheet } from "./TimingsSheet";
import { syncMenu } from "./menuSync";
import { setShownState } from "./keyTracker";
import { closeScope, setCloseScope, subscribeCloseScope } from "./closeScope";
import { useKeymap } from "./keymaps";
import { KeyStrip } from "./KeyStrip";
import { showKeyHints, useStripState } from "./keyHints";
import { RenderErrorBoundary } from "./ErrorBoundary";
import { SafetyBar, SafetyRefusal } from "./SafeMode";
import {
  BlocksIcon,
  CloseIcon,
  GridIcon,
  PlayIcon,
  PlusIcon,
  ShieldModeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  TableIcon,
} from "./icons";
import {
  buildTableIndex,
  idleBuild,
  item,
  queryLabel,
  sqlIdent,
  timeAgo,
  type PaletteGroup,
  type PaletteItem,
} from "./paletteIndex";
import { isMacPlatform } from "./platform";
import { loadHistory, recordHistory, type HistoryEntry } from "./queryHistory";
import { keywordHabits, recordKeywords } from "./keywordHabits";
import { escLeftSelection, markReveal, ResultsGrid, type KeyColumns, type QuickLookView } from "./ResultsGrid";
import { QuickLook, followLabel, sqlLiteral, type FollowKey, type IncomingRef, type KeyTarget, type QuickLookLinks } from "./QuickLook";
import { resultsToText } from "./resultsExport";
import { sqlStatementRanges, type CharRange } from "./sqlStatements";
import { allTables, buildSchemaTree, findTable, isView, tableKey, type SidebarTable } from "./schemaTree";
import { prefetchOn } from "./prefetchSwitch";
import { toggleNativeDecorations } from "./windowChrome";
import { TableStructure } from "./TableStructure";
import { Sidebar, SidebarFoot } from "./Sidebar";
import type { SettingsSection } from "./SettingsPage";
import { createPortal } from "react-dom";
import { ENGINES } from "./engines";
import { SqlEditor, type EditorCompletion, type SqlEditorHandle } from "./SqlEditor";
import { completionIndexFor, usageFromHistory } from "./completionIndex";
import { complete, expandStar, tableRead } from "./sqlComplete";
import type { CompletionResult } from "./sqlComplete";
import { showOfferToast, showToast, showUndoToast } from "./notify";
import { atCap, CAPPED_MESSAGE, nextFetchRows } from "./rowCap";
import { parsePostgresUrl } from "./connectionUrl";
import { ConnectFailed, EmptyWindow, useConnectFailure } from "./EmptyWindow";
import { emptyWindowPose } from "./penguinPlacement";
import { SqlLine, type LineWash } from "./SqlLine";
import { cycleSort, hiddenGrips, setSortDirection, sortKeys, sortResult, visibleColumns, type SortKey } from "./tableSort";
import { ChipEditor, type ChipDraft } from "./ChipEditor";
import {
  chipFragments,
  chipWords,
  chipsFromFilter,
  chipComplete,
  chipsToWhere,
  defaultOp,
  parseFragment,
  renameFragmentColumn,
  savedChips,
  textColumns,
  unknownColumn,
  type FilterChip,
} from "./filterChips";
import { flushPersist, readKey, writeKey } from "./persist";
import type { SelectionStats } from "./selectionStats";
import type { SavedTab } from "./windowStore";
import { ResultRows, useResultRows } from "./resultStore";
import { loadWidths, saveShapeWidths, type WidthsByShape } from "./gridWidths";
import { flushTimings, initTimings, ledgerLines, mark, proofAutomation, startQuery } from "./timings";
import { mcpShared } from "./mcpActivity";
import type { ReportContext } from "./report";
import { Presence, useSlidingThumb, useTabPresence } from "./motion";
import { EnvTag } from "./EnvTag";
import { GridMenu, useContextMenu } from "./GridMenu";
import { tabMenu as tabMenuRows } from "./contextMenus";
import { bufferChanges, changeCount, editTableOf, savedBuffer, withoutCommitted, type EditBuffer } from "./editBuffer";
import { EditTray, type TrayState } from "./EditTray";
import { ReviewSql, reviewCards, type ReviewCard } from "./ReviewSql";
import { Inspector, type InspectorKind } from "./Inspector";
import { useRowEdits } from "./useRowEdits";
import { QueryErrorView } from "./QueryErrorView";
import { nearestName, positionToOffset, quotedName, tokenAt } from "./queryError";
import { EMPTY_HISTORY, goHistory, historyLabel, pushHistory, type History as NavHistory, type HistoryEntry as NavEntry } from "./history";
import { moveItem, useTabReorder } from "./tabReorder";
import { setThemeSetting, useTheme, type ThemeSetting } from "./theme";
import { connectionLine, markedNames, presentingOn, setPresenting, usePresenting } from "./presenting";
import { withMasked } from "./mcpAccess";
import type {
  ConnectionEnv,
  ConnectionRecord,
  MaskedColumns,
  QueryResultDto,
  SafeMode,
  Value,
  SafetyHold,
  SchemaCatalog,
  TableIndexes,
} from "./types";
import {
  SAFE_MODES,
  connectionSubtitle,
  engineForConnection,
  formatMs,
  safeFormatCell,
} from "./types";
import { Keys } from "./Keys";
import { StatementList, type StatementResult } from "./StatementList";
import { instanceShortName } from "./CloudSqlFields";
import { SessionDetail, SessionsBar, SessionsGrid, useSessions } from "./SessionsView";

type ResultsView = "data" | "structure";

const NO_ENUMS: NonNullable<SchemaCatalog["enums"]> = [];

/** DDL that changes what completion and the sidebar know about. */
const CHANGES_SCHEMA =
  /\b(create|alter|drop)\s+(or\s+replace\s+)?((temp|temporary|unlogged|materialized)\s+)?(table|view|schema|type|function|procedure|sequence|extension)\b/i;

/** A COMMIT: DDL run earlier in the tab's open transaction becomes visible. */
const ENDS_TRANSACTION = /(^|;)\s*(commit|end)\b/i;

/** A window shown again after this long reloads its schema in the background. */
/** Hover prefetch starts once the pointer has rested on a row this long. */
const PREFETCH_HOVER_MS = 120;

/** Quick Look's labels are fetched this long after a cell selection settles. */
const SPECULATE_MS = 80;

const SCHEMA_STALE_MS = 15 * 60_000;

/** Rows a table tab loads at a time, unless its page size says otherwise. */
const DEFAULT_PAGE = 1000;
/** The page-size menu; 0 loads every row. */
const PAGE_SIZES = [1000, 5000, 0];

type SortState = SortKey;

/**
 * A query tab is a SQL scratchpad. A table tab shows one table (no editor):
 * a filter line, header-click sorting and paged rows. The sidebar only ever
 * opens table tabs, so it can't overwrite a query.
 */
interface QueryTab {
  id: number;
  /** "sessions": the server's sessions (SessionsView.tsx), Postgres only. */
  kind: "query" | "table" | "sessions";
  title: string;
  sql: string;
  view?: ResultsView;
  /** Table tabs: the table, its filter (as applied, and as typed) and sort. */
  tableKey?: string;
  schema?: string;
  table?: string;
  filter?: string;
  /** The filter as chips; `filter` is always `chipsToWhere(chips)`. */
  chips?: FilterChip[];
  /** Sort keys, primary first (a table tab sorts on the server). */
  sort?: SortState[];
  /** Table tabs: columns left out of the SELECT list. */
  hidden?: string[];
  /** Table tabs: rows per page (`DEFAULT_PAGE` when unset; 0 is All). */
  pageSize?: number;
  /** The reusable tab a sidebar click retargets; keeping it makes it a normal tab. */
  preview?: boolean;
  /** Table tabs: staged row edits, saved with the tab until Commit or Discard. */
  edits?: EditBuffer;
}

/** Where a table tab is, as a history entry (null for query tabs). */
function entryOf(tab: QueryTab | undefined): NavEntry | null {
  if (!tab || tab.kind !== "table" || !tab.tableKey) return null;
  return {
    tableKey: tab.tableKey,
    name: tab.table ?? tab.title,
    view: tab.view === "structure" ? "structure" : "data",
    filter: tab.filter ?? "",
    chips: tab.chips,
    sort: tab.sort ?? [],
    pageSize: tab.pageSize,
  };
}

/** Set once the first explicit chip is applied in this install: typing on a cell then filters. */
const TYPE_TO_FILTER_KEY = "rowkery.typeToFilter";

/** A closed tab, kept for Undo and ⌘⇧T until the app quits. */
interface ClosedTab {
  tab: QueryTab;
  run: TabRun | undefined;
  /** Where it sat in the tab row. */
  index: number;
}

/** Recently closed tabs kept per window (their rows only while the Undo toast is up). */
const MAX_CLOSED_TABS = 10;

const queryTab = (id: number, title: string, sql: string): QueryTab => ({
  id,
  kind: "query",
  title,
  sql,
});

/** "1,400 rows ·" in the results header while a query streams; re-renders on its own. */
function RowsSoFar({ rows }: { rows: ResultRows }) {
  const n = useResultRows(rows);
  return (
    <span data-rows-so-far={n}>
      {n.toLocaleString()} {n === 1 ? "row" : "rows"} ·{" "}
    </span>
  );
}

/** A query tab's last run. Tabs run independently, several at a time. */
/** How one run ended: Run All goes on only after "done". */
type RunEnd = "done" | "error" | "cancelled" | "held" | "skipped";

interface TabRun {
  result: QueryResultDto | null;
  /** The run failed before the database answered (bad session, network). */
  error: string | null;
  /**
   * The one table `result` reads (a table tab's table, or what the query's SQL
   * reads): its key columns get icons and Structure shows it.
   */
  tableKey: string | null;
  /**
   * More rows remain: a table tab's last page came back full. Load more (or
   * scrolling to the end) gets them. A query tab gets every row at once.
   */
  hasMore: boolean;
  /** The statement the last run ran (a query tab's), for Export and Copy all. */
  ranSql?: string;
  /**
   * A failed run's token in the editor (dotted underline until the next
   * edit) and, for an unknown column or table, the name it probably meant.
   */
  errorMark?: { start: number; end: number; suggestion: string | null } | null;
  /** An export or copy-all of this tab's result is running: rows so far. */
  exporting?: { verb: "Exporting" | "Copying"; rows: number } | null;
  /** `Date.now()` when the running query started; null when none is running. */
  startedAt: number | null;
  /** The running fetch appends a page to the rows shown (they, and their edits, stay). */
  appending?: boolean;
  cancelling: boolean;
  /**
   * The run waits for a free connection: every one the saved connection may
   * hold (10) is busy running something or holding a transaction.
   */
  waiting?: boolean;
  /** How the last run ended: a green or red dot on the tab until the next run. */
  outcome: "done" | "error" | null;
  /** How long the last finished run took; shown after the tab's name. */
  elapsedMs: number | null;
  /**
   * Safe mode stopped the last run; `sql` is exactly what would run.
   * `explain`: it was a timed plan of a write (⌘E, Run with timings).
   */
  held: {
    sql: string;
    hold: SafetyHold;
    tableKey: string | null;
    explain?: boolean;
    /** A statement of a run of several: confirmed, it joins that run's list. */
    statement?: { at: number | null };
  } | null;
  /** ⌘E's plan of `sql`, shown in place of the results until the next run. */
  plan?: { plan: QueryPlan; sql: string; elapsedMs: number } | null;
  /** The running query's rows are arriving; `result` holds them so far. */
  streaming: boolean;
  /** Counts runs (not appended pages): a new one scrolls the grid to the top. */
  runNo?: number;
  /**
   * A run of several statements (Run All, or a selection of several): each
   * one's result, in order. The fields above show `statements[statementAt]`.
   */
  statements?: StatementResult[] | null;
  statementAt?: number;
}

/** The run's statements with the one shown as it is now. */
function keepShownStatement(run: TabRun): Pick<TabRun, "statements"> {
  if (!run.statements || run.statementAt === undefined) return {};
  const statements = run.statements.slice();
  statements[run.statementAt] = shownStatement(run);
  return { statements };
}

/** The statement a tab shows, to keep while it shows another. */
function shownStatement(run: TabRun): StatementResult {
  const { result, tableKey, ranSql, runNo } = run;
  return { result, tableKey, ranSql, runNo };
}

const IDLE_RUN: TabRun = {
  streaming: false,
  result: null,
  error: null,
  tableKey: null,
  hasMore: false,
  startedAt: null,
  cancelling: false,
  outcome: null,
  elapsedMs: null,
  held: null,
};

/** How long a confirmation such as "Copied 100 rows" stays in the results header. */
const NOTICE_MS = 2400;

const PALETTE_EMPTY_GROUPS: PaletteGroup[] = [
  "queries",
  "commands",
  "connections",
];

const DEFAULT_EDITOR_SPLIT = 42;
const SPLIT_KEY = "rowkery.editorSplit";
/** A saved split never loads below this share; a drag stops at an 80 px editor. */
const MIN_EDITOR_SPLIT = 8;
const MAX_EDITOR_SPLIT = 72;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
  );
}

/** Lowest "Query N" not already open, so closing tabs never yields duplicates. */
/** A table's name as SQL, schema-qualified unless it is the default one (⌥↵ inserts it). */
function tableIdent(schema: string, name: string): string {
  const bare = schema === "public" || schema === "main";
  return bare ? sqlIdent(name) : `${sqlIdent(schema)}.${sqlIdent(name)}`;
}

function nextTabTitle(tabs: QueryTab[]): string {
  const used = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (used.has(`Query ${n}`)) n++;
  return `Query ${n}`;
}

/**
 * The run clock: one 100 ms interval, alive only while an `Elapsed` in a
 * shown window reads it. Only those few spans re-render as it ticks; the
 * workspace and the grid never do.
 */
const clock = { now: Date.now(), timer: 0, listeners: new Set<() => void>() };

function subscribeClock(fn: () => void) {
  clock.listeners.add(fn);
  if (!clock.timer) {
    clock.now = Date.now();
    clock.timer = window.setInterval(() => {
      clock.now = Date.now();
      for (const l of clock.listeners) l();
    }, 100);
  }
  return () => {
    clock.listeners.delete(fn);
    if (clock.listeners.size === 0) {
      window.clearInterval(clock.timer);
      clock.timer = 0;
    }
  };
}

const noSubscribe = () => () => {};
const clockNow = () => clock.now;

/** Time since `since`, ticking while `active` (a hidden window's stands still). */
function Elapsed({ since, active, format }: { since: number; active: boolean; format: (ms: number) => string }) {
  const now = useSyncExternalStore(active ? subscribeClock : noSubscribe, clockNow);
  return <>{format(Math.max(0, Math.max(now, since) - since))}</>;
}

const formatRunningTab = (ms: number) => formatTabTime(ms);

/**
 * A query tab's title with its run: a spinner and the elapsed time while it
 * runs, then a green or red dot for how it ended and how long it took, both
 * kept until the next run.
 */
function TabStatus({
  run,
  table,
  active,
  children,
}: {
  run?: TabRun;
  table: boolean;
  /** The window is shown: a running tab's time ticks. */
  active: boolean;
  children: ReactNode;
}) {
  const running = run?.startedAt != null;
  const outcome = running ? null : run?.outcome;
  const ms = outcome ? (run?.elapsedMs ?? null) : null;
  return (
    <>
      {running ? (
        <span data-testid="query-tab-spin" className="query-tab-spin" aria-label="Running" />
      ) : outcome ? (
        <span
          data-testid="query-tab-dot"
          className={`query-tab-dot ${outcome}`}
          data-outcome={outcome}
          aria-label={outcome === "error" ? "Failed" : "Succeeded"}
        />
      ) : (
        table && <TableIcon size={12} className="query-tab-icon" />
      )}
      <span data-testid="query-tab-title" className="query-tab-title">{children}</span>
      {running ? (
        <span data-testid="query-tab-time" className="query-tab-time">
          <Elapsed since={run!.startedAt!} active={active} format={formatRunningTab} />
        </span>
      ) : (
        ms !== null && <span data-testid="query-tab-time" className="query-tab-time">{formatTabTime(ms, true)}</span>
      )}
    </>
  );
}

/**
 * "0.4s", "42.1s", "3:07": short, and steady in width as it ticks. A
 * finished run under a second reads in ms ("12ms"), not "0.0s".
 */
function formatTabTime(ms: number, finished = false): string {
  if (finished && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
}

/** Menu picks that open a sheet, menu or setting over the Agents page, so the page stays. */
const OVER_PAGE = new Set([
  "new-connection",
  "edit-connection",
  "keyboard-shortcuts",
  "third-party-notices",
  "report-issue",
  "check-updates",
  "show-key-hints",
  "hide-tips",
  "timings",
  "switch-connection",
  "switch-database",
  "change-safe-mode",
  "open-sqlite-file",
  "window-controls",
  "agents",
  "settings",
]);
const opensOverPage = (id: string) =>
  OVER_PAGE.has(id) || /^(theme|safe|env|mcp):|^mcp-/.test(id);

interface WorkspaceProps {
  session: WindowSession;
  /** Hidden windows stay mounted (instant switching) but take no keys. */
  active: boolean;
  connections: ConnectionRecord[];
  windowCount: number;
  /** A sheet or popover owns the keyboard. */
  keysBlocked: boolean;
  /** A sheet or popover owns menu bar picks too (the Agents page doesn't: see onCommand). */
  commandsBlocked?: boolean;
  /** New connection is open (App's inspector): ⌘↵ saves it, so Run waits. */
  connectionForm?: boolean;
  /** ⌘K palette; the app shell owns it so the toolbar's search can open it. */
  paletteOpen: boolean;
  onPaletteClose: () => void;
  /** ⌘B (or ⌃⌘S) slid the sidebar away; / and "Filter schema" bring it back. */
  sidebarHidden: boolean;
  /** The active window's connection and database switchers (sidebar top). */
  switchers?: ReactNode;
  /** The title bar's slot: the shown window portals its Safe mode and MCP buttons there. */
  titlebarTools?: HTMLElement | null;
  /** The Agents page is up: the foot's Agents row is lit, and pressing it returns. */
  agentsOpen?: boolean;
  /** The Settings page is up: menu picks that act on the window close it first, as Agents does. */
  settingsOpen?: boolean;
  onCloseSettings?: () => void;
  /** Changes agents proposed that wait for review. */
  proposalCount?: number;
  onToggleAgents?: () => void;
  /** The same switchers, shown at the tab row's left while the panel is hidden. */
  identity?: ReactNode;
  actions: WindowActions;
  /** VITE_ROWKERY_AUTO_PROOF steps, run once after the first connect. */
  proof?: string;
  /** Tabs saved from the last session, restored when the window mounts. */
  restoredTabs?: { tabs: SavedTab[]; active: number };
  /** Runs the shown tab's first statement once the window first connects (the sample's Getting started). */
  runOnConnect?: boolean;
  /** How many of the window's tabs are running, for the window pill's status. */
  onRunningChange?: (windowId: string, running: number) => void;
  /** Called when the window's tabs or their SQL change, to be saved. */
  onTabsChange?: (windowId: string, tabs: SavedTab[], active: number) => void;
}

/**
 * One window: the schema panel, query tabs, editor and results for one
 * connection and database. The app shell owns connecting, the title bar
 * and the switchers at the top of the panel; this owns the rest.
 */
export function Workspace({
  session,
  active,
  connections,
  windowCount,
  keysBlocked,
  commandsBlocked = keysBlocked,
  connectionForm,
  paletteOpen,
  onPaletteClose,
  sidebarHidden,
  switchers,
  titlebarTools,
  agentsOpen = false,
  settingsOpen = false,
  onCloseSettings,
  proposalCount = 0,
  onToggleAgents,
  identity,
  actions,
  proof,
  restoredTabs,
  runOnConnect,
  onRunningChange,
  onTabsChange,
}: WorkspaceProps) {
  const windowId = session.id;
  const activeId = session.connectionId;
  const schema = session.schema;
  const connState = session.state;
  const [tabs, setTabs] = useState<QueryTab[]>(() =>
    restoredTabs?.tabs.length
      ? restoredTabs.tabs.map((t, i) => ({
          ...t,
          id: i + 1,
          sort: sortKeys(t.sort),
          chips: t.kind === "table" ? (savedChips(t.chips) ?? chipsFromFilter(t.filter)) : undefined,
          edits: t.kind === "table" ? savedBuffer(t.edits) : undefined,
        }))
      : [queryTab(1, "Query 1", "SELECT 1;")],
  );
  const [activeTabId, setActiveTabId] = useState(() =>
    restoredTabs?.tabs.length ? Math.min(restoredTabs.active, restoredTabs.tabs.length - 1) + 1 : 1,
  );
  /**
   * Each table tab's first-page SQL as core ran it (and the WHERE text it ran
   * with): the SQL line, and what Edit SQL opens. `tableKey` and `key` (the
   * tab's `runKey`) say what it was for: the line shows it only for the same
   * table, Edit SQL only for exactly the tab as it is now.
   */
  const [lineSql, setLineSql] = useState<
    Record<number, { sql: string; filter: string; tableKey: string; key: string }>
  >({});
  /** The clause a gesture changed (sort, hide, chips, page size): washed when that tab's new SQL lands. */
  const pendingWash = useRef<Record<number, LineWash["clause"]>>({});
  const [lineWash, setLineWash] = useState<(LineWash & { tabId: number }) | null>(null);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const nextTabId = useRef((restoredTabs?.tabs.length ?? 1) + 1);
  // Tabs and their SQL are saved as they change; persist.ts waits for the
  // typing to pause before writing.
  useEffect(() => {
    if (!onTabsChange) return;
    const saved: SavedTab[] = tabs.map((t) => ({
      kind: t.kind,
      title: t.title,
      sql: t.sql,
      view: t.view,
      tableKey: t.tableKey,
      schema: t.schema,
      table: t.table,
      filter: t.filter,
      chips: t.chips,
      sort: t.sort,
      hidden: t.hidden?.length ? t.hidden : undefined,
      pageSize: t.pageSize,
      preview: t.preview,
      edits: t.edits,
    }));
    onTabsChange(
      session.id,
      saved,
      Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
    );
  }, [tabs, activeTabId, onTabsChange, session.id]);
  const [runs, setRuns] = useState<Record<number, TabRun>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** Merges into a tab's run; a tab closed while its query ran is left alone. */
  const patchRun = useCallback(
    (tabId: number, patch: Partial<TabRun> | ((prev: TabRun) => Partial<TabRun>)) => {
      if (!tabsRef.current.some((t) => t.id === tabId)) return;
      setRuns((prev) => {
        const before = prev[tabId] ?? IDLE_RUN;
        const next = typeof patch === "function" ? patch(before) : patch;
        return { ...prev, [tabId]: { ...before, ...next } };
      });
    },
    [],
  );
  const activeRun = runs[activeTabId] ?? IDLE_RUN;
  const result = activeRun.result;
  const resultTableKey = activeRun.tableKey;
  const renderError = activeRun.error;
  const runStartedAt = activeRun.startedAt;
  const cancelling = activeRun.cancelling;
  const busy = runStartedAt !== null;
  /** A short confirmation in the results header ("Copied 100 rows as CSV"). */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);
  // The editor / results split, as dragged (persist.ts, 2026-10-13).
  const [editorSplitPct, setEditorSplitPct] = useState(() => {
    const v = Number(readKey(SPLIT_KEY));
    return Number.isFinite(v) && v > 0 ? Math.min(MAX_EDITOR_SPLIT, Math.max(MIN_EDITOR_SPLIT, v)) : DEFAULT_EDITOR_SPLIT;
  });
  // Dragged column widths per result shape (its column names), so a width
  // set on one table's `id` doesn't squash every other table's `id`; kept
  // in config.json (gridWidths.ts).
  const [widthsByShape, setWidthsByShape] = useState<WidthsByShape>(loadWidths);
  const resultShape = useMemo(
    () => result?.columns.map((c) => c.name).join("\0") ?? "",
    [result?.columns],
  );
  const columnWidths = widthsByShape[resultShape];
  const setColumnWidths = useCallback(
    (widths: Record<string, number>) => setWidthsByShape(saveShapeWidths(resultShape, widths)),
    [resultShape],
  );
  const mainRef = useRef<HTMLElement>(null);
  const sqlEditorRef = useRef<SqlEditorHandle>(null);
  const viewTrackRef = useRef<HTMLDivElement>(null);
  const viewThumbRef = useRef<HTMLSpanElement>(null);
  const macOverlay = isMacPlatform();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const activeSql = activeTab?.sql ?? "";
  const isTableTab = activeTab?.kind === "table";
  const isSessionsTab = activeTab?.kind === "sessions";
  const presenting = usePresenting();
  const runsRef = useRef(runs);
  runsRef.current = runs;

  // ‹ › / ⌘[ ⌘]: where this window's Preview tab has been (history.ts).
  const [navHistory, setNavHistory] = useState<NavHistory>(EMPTY_HISTORY);
  const navRef = useRef(navHistory);
  navRef.current = navHistory;

  const setActiveView = useCallback(
    (view: ResultsView) => {
      const before = entryOf(tabsRef.current.find((t) => t.id === activeTabId));
      setTabs((prev) =>
        prev.map((t) => (t.id === activeTabId ? { ...t, view } : t)),
      );
      // Opening Structure (or back to Data) on a table is a step in history.
      if (before && before.view !== view) setNavHistory((h) => pushHistory(h, { ...before, view }, before));
    },
    [activeTabId],
  );

  const setActiveSql = useCallback(
    (sql: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === activeTabId ? { ...t, sql } : t)),
      );
      // Any edit takes the error's underline away.
      if (runsRef.current[activeTabId]?.errorMark) patchRun(activeTabId, { errorMark: null });
    },
    [activeTabId, patchRun],
  );


  const addTab = () => {
    const id = nextTabId.current++;
    const title = nextTabTitle(tabs);
    setTabs((prev) => [...prev, queryTab(id, title, "")]);
    setActiveTabId(id);
  };

  /** ⌘K Show sessions: the window's Sessions tab, opened once. */
  const showSessions = () => {
    const open = tabs.find((t) => t.kind === "sessions");
    if (open) return setActiveTabId(open.id);
    const id = nextTabId.current++;
    setTabs((prev) => [...prev, { id, kind: "sessions", title: "Sessions", sql: "" }]);
    setActiveTabId(id);
  };

  const { rows: tabRows, ref: tabRef } = useTabPresence(
    tabs,
    (t) => String(t.id),
    6,
  );

  const queryTabsRef = useRef<HTMLDivElement>(null);
  const dragQueryTab = useTabReorder({
    track: queryTabsRef,
    keys: tabs.map((t) => String(t.id)),
    onReorder: (from, to) => setTabs((prev) => moveItem(prev, from, to)),
    onStart: (key) => setActiveTabId(Number(key)),
  });

  /**
   * Closes a tab without asking: it goes to Recently closed (this session
   * only) and the toast offers Undo; ⌘⇧T reopens the most recent one any
   * time. Undo puts it back as it was; once the toast has gone, Recently
   * closed keeps its SQL, chips and pending edits but not its rows
   * (docs/spec.md, Undo and Esc), so ten closed
   * tabs don't hold ten results. Reopened then, a table tab browses again
   * and a query tab waits for ⌘↵.
   */
  const closedTabs = useRef<ClosedTab[]>([]);
  const releaseClosedRows = (entries: ClosedTab[]) => {
    // Only those still in Recently closed: one reopened meanwhile has its rows in `runs`.
    for (const entry of entries) if (closedTabs.current.includes(entry)) entry.run = undefined;
  };
  const [closedCount, setClosedCount] = useState(0);
  const closeTab = (id: number) => {
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = tabs[index];
    void closeQueryTab(windowId, id).catch(() => {});
    const run = runsRef.current[id];
    const worthKeeping = tab.kind === "table" || !!tab.sql.trim() || !!run?.result;
    const entry: ClosedTab = { tab, run, index };
    if (worthKeeping) {
      closedTabs.current = [...closedTabs.current, entry].slice(-MAX_CLOSED_TABS);
      setClosedCount(closedTabs.current.length);
    }
    setRuns(({ [id]: _closed, ...rest }) => rest);
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      // Always keep one tab open: closing the last one leaves a fresh empty tab.
      const fresh = nextTabId.current++;
      setTabs([queryTab(fresh, "Query 1", "")]);
      setActiveTabId(fresh);
    } else {
      setTabs(rest);
      if (id === activeTabId) {
        setActiveTabId(rest[Math.min(index, rest.length - 1)].id);
      }
    }
    if (worthKeeping) {
      const edits = changeCount(tab.edits);
      const unsaved = edits
        ? ` with ${edits} unsaved ${edits === 1 ? "change" : "changes"}`
        : tab.kind === "query" && !!tab.sql.trim()
          ? " with unsaved SQL"
          : "";
      showUndoToast(`Closed ${tab.title}${unsaved}`, undefined, {
        undo: () => reopenTabRef.current(entry),
        commit: () => releaseClosedRows([entry]),
      });
    }
  };

  /** The tab menu's Close other tabs: each goes to Recently closed; Undo puts them all back. */
  const closeOtherTabs = (keepId: number) => {
    const entries: ClosedTab[] = [];
    tabs.forEach((tab, index) => {
      if (tab.id === keepId) return;
      void closeQueryTab(windowId, tab.id).catch(() => {});
      entries.push({ tab, run: runsRef.current[tab.id], index });
    });
    if (!entries.length) return;
    closedTabs.current = [...closedTabs.current, ...entries].slice(-MAX_CLOSED_TABS);
    setClosedCount(closedTabs.current.length);
    setRuns((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => Number(id) === keepId)));
    setTabs((prev) => prev.filter((t) => t.id === keepId));
    setActiveTabId(keepId);
    showUndoToast(`Closed ${entries.length} ${entries.length === 1 ? "tab" : "tabs"}`, undefined, {
      undo: () => entries.forEach((e) => reopenTabRef.current(e)),
      commit: () => releaseClosedRows(entries),
    });
  };

  /** Puts a closed tab back where it was, as it was (a new id; no query running). */
  const reopenTab = (entry: ClosedTab) => {
    closedTabs.current = closedTabs.current.filter((e) => e !== entry);
    setClosedCount(closedTabs.current.length);
    const id = nextTabId.current++;
    const tab: QueryTab = { ...entry.tab, id, preview: false };
    const list = tabsRef.current;
    // The fresh empty tab that closing the last one left goes away again.
    const blank = list.length === 1 && list[0].kind === "query" && !list[0].sql.trim() && !runsRef.current[list[0].id]?.result;
    const base = blank ? [] : list;
    const at = Math.min(entry.index, base.length);
    const next = [...base.slice(0, at), tab, ...base.slice(at)];
    setTabs(next);
    tabsRef.current = next;
    // A table tab's SQL line reads what its first page ran under the old id.
    setLineSql((prev) => (prev[entry.tab.id] ? { ...prev, [id]: prev[entry.tab.id] } : prev));
    // Read now: the state update runs later, after the Undo toast this
    // reopen replaced may have released the entry's rows.
    const run = entry.run;
    if (run) {
      setRuns((prev) => ({
        ...prev,
        [id]: { ...run, startedAt: null, cancelling: false, streaming: false, hasMore: false },
      }));
    }
    setActiveTabId(id);
    return tab;
  };
  const reopenTabRef = useRef(reopenTab);
  reopenTabRef.current = reopenTab;
  /** ⌘⇧T: the most recently closed tab. */
  const reopenClosedTab = () => {
    const entry = closedTabs.current[closedTabs.current.length - 1];
    if (!entry) return;
    const tab = reopenTab(entry);
    showToast(`Reopened ${tab.title}`);
  };
  const reopenClosedTabRef = useRef(reopenClosedTab);
  reopenClosedTabRef.current = reopenClosedTab;

  const cycleTab = (dir: 1 | -1) => {
    const index = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(index + dir + tabs.length) % tabs.length];
    if (next) setActiveTabId(next.id);
  };

  /**
   * Reuse the active query tab when it is empty, otherwise open a new one
   * (after `after`, when given). Table tabs are never written to. Returns the
   * tab's id.
   */
  const openSqlInTab = (sql: string, title?: string, after?: number): number => {
    const current = tabs.find((t) => t.id === activeTabId);
    if (current && current.kind === "query" && !current.sql.trim() && after === undefined) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === current.id ? { ...t, sql, title: title ?? t.title } : t,
        ),
      );
      return current.id;
    }
    const id = nextTabId.current++;
    const fresh = queryTab(id, title ?? nextTabTitle(tabsRef.current), sql);
    const insert = (list: QueryTab[]) => {
      const at = after === undefined ? -1 : list.findIndex((t) => t.id === after);
      return at < 0 ? [...list, fresh] : [...list.slice(0, at + 1), fresh, ...list.slice(at + 1)];
    };
    setTabs(insert);
    // `patchRun` drops runs for tabs it doesn't know; a run started before the
    // next render must still land here.
    tabsRef.current = insert(tabsRef.current);
    setActiveTabId(id);
    return id;
  };

  /** ⌘K All tables as rows: the catalog as a result in its own tab, no query. */
  const openAllTables = () => {
    const { result, sql } = catalogResult(schemaTree);
    const tabId = openSqlInTab(sql, "All tables");
    patchRun(tabId, (prev) => ({
      ...IDLE_RUN,
      result,
      outcome: "done",
      elapsedMs: 0,
      runNo: (prev.runNo ?? 0) + 1,
    }));
  };

  // Drag the line between the editor and the results: the editor keeps at
  // least 80 px (2026-10-13) and the share is saved on release.
  const startSplitDrag = (handle: HTMLElement) => {
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const minPct = (80 / rect.height) * 100;
    let pct = editorSplitPct;
    handle.dataset.dragging = "";
    const onMove = (e: MouseEvent) => {
      pct = Math.min(MAX_EDITOR_SPLIT, Math.max(minPct, ((e.clientY - rect.top) / rect.height) * 100));
      setEditorSplitPct(pct);
    };
    const onUp = () => {
      delete handle.dataset.dragging;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      writeKey(SPLIT_KEY, Math.round(pct * 10) / 10);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };


  const flash = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // A (re)connect starts from a clean slate; query tabs stay.
  useEffect(() => {
    if (connState !== "connecting") return;
    setNotice(null);
    setRuns({});
  }, [connState]);

  const proofRan = useRef(false);
  const latencyHooks = useRef<{
    tree: ReturnType<typeof buildSchemaTree>;
    openTable: (t: SidebarTable) => void;
  }>({ tree: [], openTable: () => {} });
  useEffect(() => {
    if (!proof || proofRan.current || connState !== "connected") return;
    proofRan.current = true;
    void (async () => {
      try {
        if (proof === "latency") {
          await runLatencyProof();
          return;
        }
        if (proof === "query-cancel") {
          const sql = "SELECT pg_sleep(30);";
          setTabs([queryTab(1, "Query 1", sql)]);
          setActiveTabId(1);
          setRuns({});
          setTimeout(() => void onRunRef.current(sql), 500);
          return;
        }

        const browseSql = await browseTableSql(
          "postgres",
          "public",
          "failed_jobs",
        );
        setTabs([queryTab(1, "Query 1", browseSql)]);
        setActiveTabId(1);
        const res = await runQuery(windowId, 1, browseSql);
        patchRun(1, { result: res, error: null });

        if (proof === "1") {
          requestAnimationFrame(() => {
            setTimeout(() => {
              const el = document.querySelector('[data-testid="results-grid-wrap"]');
              if (el) {
                el.scrollTop = 720;
                el.scrollLeft = 40;
              }
            }, 400);
          });
        }
      } catch (e) {
        patchRun(1, { error: String(e) });
      }
    })();
  }, [proof, connState]);

  /**
   * scripts/latency-proof.sh: runs ROWKERY_AUTO_RUN_SQL one statement at a time
   * in Query 1, then browses ROWKERY_AUTO_BROWSE_TABLE as a sidebar click would,
   * marks `proof-done` and flushes the ledger. The script reads the marks.
   */
  const runLatencyProof = async () => {
    await initTimings();
    const auto = proofAutomation();
    const statements = auto?.run_sql.length ? auto.run_sql : ["SELECT 1;"];
    setTabs([queryTab(1, "Query 1", statements[0])]);
    setActiveTabId(1);
    setRuns({});
    for (const sql of statements) {
      await new Promise((r) => setTimeout(r, 100));
      await onRunRef.current(sql, false, undefined, 1);
    }
    const want = auto?.browse_table;
    const table = want
      ? latencyHooks.current.tree
          .flatMap((sc) => sc.tables)
          .find((t) => `${t.schema}.${t.name}` === want)
      : undefined;
    if (table) {
      const before = ledgerLines().length;
      latencyHooks.current.openTable(table);
      // Rows painted for the browse, or give up after 10 s.
      for (let i = 0; i < 200; i++) {
        if (ledgerLines().slice(before).some((l) => l.mark === "first-frame-painted")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    // The script ends the app at proof-done, not as a quit would (which writes
    // config.json): save the windows now, so the warm launch reopens one
    // while the webview boots, as a relaunch does. The writer takes ≤ 500 ms.
    flushPersist();
    await new Promise((r) => setTimeout(r, 700));
    mark("proof-done");
    await flushTimings();
  };

  const schemaTree = useMemo(() => buildSchemaTree(schema), [schema]);
  // Flattened once per schema load, when the browser is next idle (or at
  // once if ⌘K opens first); the palette only filters it.
  const tableIndex = useMemo(() => idleBuild(() => buildTableIndex(schemaTree)), [schemaTree]);
  useEffect(() => tableIndex.cancel, [tableIndex]);

  useEffect(() => setHistory(loadHistory(activeId)), [activeId]);

  /** `schema` + name → sidebar key, to tie a query's table to the catalog. */
  const keyBySchemaName = useMemo(() => {
    const map = new Map<string, string>();
    for (const sc of schemaTree) {
      for (const t of [...sc.tables.flatMap((x) => [x, ...x.partitions]), ...sc.views]) {
        const k = `${t.schema}\0${t.name}`;
        if (!map.has(k)) map.set(k, t.key);
      }
    }
    return map;
  }, [schemaTree]);

  const activeConnection = connections.find((c) => c.id === activeId) ?? null;

  // A failed connection, explained by core: the cause sentence and the field
  // Edit… marks.
  const [explained, setExplained] = useState<ConnectExplanation | null>(null);
  useEffect(() => {
    setExplained(null);
    if (connState !== "error" || !session.error || !activeConnection) return;
    let live = true;
    const pg = activeConnection.kind === "postgres" ? activeConnection : null;
    void explainConnectError(session.error, {
      host: pg?.host ?? "",
      port: pg?.port ?? 0,
      username: pg?.username ?? "",
      sshHost: pg?.ssh?.host ?? null,
      cloudSql: pg?.cloud_sql?.instance ?? null,
    })
      .then((x) => live && setExplained(x))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connState, session.error, activeConnection]);
  const editFailed = () => {
    if (!activeId) return;
    // The sheet calls the SSH password field sshSecret.
    const field = explained?.field === "sshPassword" ? "sshSecret" : explained?.field;
    actions.editConnection(activeId, field ? { field, message: explained?.cause ?? session.error ?? "" } : undefined);
  };
  const failedRef = useRef(false);
  failedRef.current = connState === "error";
  const retryRef = useRef(actions.retryConnect);
  retryRef.current = actions.retryConnect;
  const editFailedRef = useRef(editFailed);
  editFailedRef.current = editFailed;

  /** Help > Report an Issue…, ⌘K, or the Report button on a failed connection. */
  const reportIssue = (fromError = false) =>
    actions.reportIssue({
      connection: activeConnection,
      serverVersion: session.serverVersion,
      error:
        connState === "error"
          ? session.error
          : (activeRun.error ?? activeRun.result?.error ?? null),
      query: activeSql,
      fromError,
    });

  // Someone else's migrations show up when you come back to a window.
  const schemaAt = session.schemaAt;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    if (active && schemaAt !== null && Date.now() - schemaAt > SCHEMA_STALE_MS)
      actionsRef.current.refreshSchema(windowId);
  }, [active, schemaAt, windowId]);
  /** Tabs that ran DDL, so their next COMMIT reloads the schema again. */
  const ddlTabs = useRef(new Set<number>());

  // Structure's index details, fetched per table and kept until the schema reloads.
  const loadIndexes = useMemo(() => {
    // A new schema load (`schema` changes) starts a fresh cache.
    const cache = new Map<string, Promise<TableIndexes[]>>();
    void schema;
    return (schemaName: string, tables: string[]) => {
      const key = `${schemaName}\0${tables.join("\0")}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = tableIndexes(windowId, schemaName, tables);
        hit.catch(() => cache.delete(key));
        cache.set(key, hit);
      }
      return hit;
    };
  }, [windowId, schema]);

  // Editor completion reads the schema this window already loaded. The index
  // is built once per schema load, off the keystroke path when the app idles.
  const completionEngine = activeConnection ? engineForConnection(activeConnection) : null;
  const usage = useMemo(() => usageFromHistory(history), [history]);
  useEffect(() => {
    if (!schema || !completionEngine) return;
    const timer = window.setTimeout(() => completionIndexFor(schema, completionEngine), 300);
    return () => window.clearTimeout(timer);
  }, [schema, completionEngine]);
  const completion = useMemo<EditorCompletion | undefined>(() => {
    if (!schema || !completionEngine) return undefined;
    const index = () => completionIndexFor(schema, completionEngine);
    return {
      complete: (text, caret, explicit) => complete(text, caret, index(), usage, { explicit, habits: keywordHabits() }),
      expandStar: (text, caret) => expandStar(text, caret, index()),
    };
  }, [schema, completionEngine, usage]);
  // The filter box completes as if it were `SELECT * FROM t WHERE …`.
  const filterCompletion = useMemo<EditorCompletion | undefined>(() => {
    if (!completion || !isTableTab || !activeTab?.table) return undefined;
    const bare = activeTab.schema === "public" || activeTab.schema === "main";
    const name = sqlIdent(activeTab.table);
    const prefix = `SELECT * FROM ${bare ? name : `${sqlIdent(activeTab.schema ?? "")}.${name}`} WHERE `;
    const n = prefix.length;
    return {
      complete: (text, caret, explicit): CompletionResult | null => {
        const r = completion.complete(prefix + text, caret + n, explicit);
        return r && r.from >= n ? { ...r, from: r.from - n, to: r.to - n } : null;
      },
      expandStar: () => null,
    };
  }, [completion, isTableTab, activeTab?.schema, activeTab?.table]);

  // A table tab is about its table; a query tab about the table its last
  // successful run read, if it read exactly one.
  const activeTableKey = isTableTab ? activeTab?.tableKey : activeRun.tableKey;
  const activeTable = activeTableKey ? findTable(schemaTree, activeTableKey) : undefined;
  const resultsView: ResultsView =
    isTableTab && activeTable && activeTab?.view === "structure" ? "structure" : "data";

  // Memoised on the table, so the grid only re-sizes columns for a new result.
  const keyColumns: KeyColumns | null = useMemo(() => {
    const t = resultTableKey ? findTable(schemaTree, resultTableKey) : undefined;
    if (!t) return null;
    const pk = new Set(t.table.primary_key ?? []);
    const fk = new Set((t.table.foreign_keys ?? []).flatMap((f) => f.columns));
    const notNull = new Set((t.table.columns ?? []).filter((c) => !c.nullable).map((c) => c.name));
    return pk.size || fk.size || notNull.size ? { pk, fk, notNull } : null;
  }, [resultTableKey, schemaTree]);

  // Staged row edits on a table tab (editBuffer.ts): the grid's editors and marks.
  const rowEdits = useRowEdits({
    windowId,
    tab: activeTab,
    setEdits: (tabId, edits) => setTabEdits(tabId, edits),
    result: isTableTab ? result : null,
    table: isTableTab ? activeTable?.table : undefined,
    findTable: (schemaName, name) => allTables(schemaTree).find((t) => t.schema === schemaName && t.name === name)?.table,
    engine: activeConnection ? engineForConnection(activeConnection) : "postgres",
    safeMode: activeConnection?.safe_mode ?? "off",
    enums: schema?.enums ?? NO_ENUMS,
    // A fresh run hides the old rows' marks; a page loading below keeps them (and an open editor).
    shown: resultsView === "data" && (runStartedAt === null || !!activeRun.appending),
    onRefused: (reason) => refuseEdit(reason),
  });
  const rowEditsRef = useRef(rowEdits);
  rowEditsRef.current = rowEdits;

  // ---- Committing staged edits -----------------------------------------

  /** What each table tab's tray says besides its count. */
  const [trays, setTrays] = useState<Record<number, TrayState>>({});
  const trayTimer = useRef<number | undefined>(undefined);
  const setTray = (tabId: number, tray: TrayState | null, forMs?: number) => {
    window.clearTimeout(trayTimer.current);
    setTrays(({ [tabId]: _old, ...rest }) => (tray ? { ...rest, [tabId]: tray } : rest));
    if (tray && forMs) trayTimer.current = window.setTimeout(() => setTray(tabId, null), forMs);
  };
  /** Confirm writes held a commit: the SafetyBar shows its statements until ⇧⌘↵ or Esc. */
  const [heldEdits, setHeldEdits] = useState<Record<number, { sql: string; hold: SafetyHold; summary: string }>>({});
  const [review, setReview] = useState<{ tabId: number; sql: string | null; error: string | null; cards: ReviewCard[] | null } | null>(null);
  /** Quick Look's row while it is open (the grid reports it), for the inspector. */
  const [qlView, setQlView] = useState<QuickLookView | null>(null);
  const qlViewRef = useRef(qlView);
  qlViewRef.current = qlView;
  // Quick Look opening takes the column from Review SQL.
  const qlOpen = !!qlView;
  useEffect(() => {
    if (qlOpen) setReview(null);
  }, [qlOpen]);
  const setTabEdits = (
    tabId: number,
    next: EditBuffer | undefined | ((cur: EditBuffer | undefined) => EditBuffer | undefined),
  ) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const edits = typeof next === "function" ? next(t.edits) : next;
        return { ...t, edits, preview: edits ? false : t.preview };
      }),
    );
    // Edits moved: a held commit is no longer what they say, a failure no longer current.
    setHeldEdits(({ [tabId]: _gone, ...rest }) => rest);
    setTrays(({ [tabId]: old, ...rest }) => (old && old.kind !== "failed" ? { ...rest, [tabId]: old } : rest));
  };
  /** ↵ where nothing can be edited: the tray says why for 4 s. */
  const refuseEdit = (reason: string) => setTray(activeTabId, { kind: "refused", reason }, 4000);
  const editTarget = () => {
    const buffer = rowEdits.buffer;
    if (!activeTab || !buffer || !activeTable || !activeConnection) return null;
    return { tab: activeTab, buffer, table: editTableOf(activeTab.schema ?? activeTable.schema, activeTable.table) };
  };
  /** `3 statements on public.kiosks: INSERT 1 · UPDATE 1 · DELETE 1` */
  const editSummary = (buffer: EditBuffer, target: string) => {
    const changes = bufferChanges(buffer);
    const verbs = (["insert", "update", "delete"] as const)
      .map((op) => [op, changes.filter((c) => c.op === op).length] as const)
      .filter(([, n]) => n > 0)
      .map(([op, n]) => `${op.toUpperCase()} ${n}`);
    return `${changes.length} ${changes.length === 1 ? "statement" : "statements"} on ${target}: ${verbs.join(" · ")}`;
  };
  /**
   * Commit ⌘S: one transaction on the tab's session (core's apply_changes).
   * Off commits at once; Confirm writes holds it in the SafetyBar until
   * ⇧⌘↵ sends back the SQL it showed; any row count but 1 rolls it all back
   * and the tray names the row. `confirmed` is the exact text the user saw.
   */
  /** Tabs whose commit is on its way: a second ⌘S, ⇧⌘↵ or Review Commit waits for it. */
  const committing = useRef(new Set<number>());
  const commitEdits = async (confirmed?: string) => {
    const target = editTarget();
    if (!target || committing.current.has(target.tab.id)) return;
    committing.current.add(target.tab.id);
    try {
      await commitBuffer(target, confirmed);
    } finally {
      committing.current.delete(target.tab.id);
    }
  };
  const commitBuffer = async (target: NonNullable<ReturnType<typeof editTarget>>, confirmed?: string) => {
    const { tab, buffer, table } = target;
    setTray(tab.id, { kind: "committing" });
    let out;
    try {
      out = await applyChanges(windowId, tab.id, table, bufferChanges(buffer), confirmed);
    } catch (e) {
      return setTray(tab.id, { kind: "failed", message: String(e) });
    }
    if (out.status === "held") {
      if (out.hold.action === "refuse") return setTray(tab.id, { kind: "refused", reason: "Read-only connection · Change safe mode…" }, 4000);
      setTray(tab.id, null);
      const where = `${tab.schema ?? table.schema}.${table.table}`;
      setHeldEdits((prev) => ({ ...prev, [tab.id]: { sql: out.sql, hold: out.hold, summary: editSummary(buffer, where) } }));
      return;
    }
    if (out.status === "rolled_back") return setTray(tab.id, { kind: "failed", message: out.message });
    // Only what was sent is done: an edit staged while it ran stays staged.
    setTabEdits(tab.id, (cur) => withoutCommitted(cur, buffer));
    const done = [
      out.updated && `Updated ${out.updated}`,
      out.inserted && `Inserted ${out.inserted}`,
      out.deleted && `Deleted ${out.deleted}`,
      formatMs(out.elapsed_ms),
    ].filter(Boolean);
    setTray(tab.id, { kind: "done", text: done.join(" · ") }, 1600);
    // The rows as the database has them now (new rows get their keys).
    void runTable({ ...tab, edits: undefined });
  };
  const commitEditsRef = useRef(commitEdits);
  commitEditsRef.current = commitEdits;
  const heldEdit = heldEdits[activeTabId] ?? null;
  const dropHeldEdit = () => setHeldEdits(({ [activeTabId]: _gone, ...rest }) => rest);
  const heldEditRef = useRef({ held: heldEdit, drop: dropHeldEdit });
  heldEditRef.current = { held: heldEdit, drop: dropHeldEdit };
  /** Review SQL ⇧⌘P: the transaction core would run, built by core. */
  const openReview = () => {
    const target = editTarget();
    if (!target || !activeConnection) return;
    const tabId = target.tab.id;
    // One inspector: Review SQL takes the column from Quick Look.
    qlViewRef.current?.close();
    setReview({ tabId, sql: null, error: null, cards: null });
    const buffer = target.buffer;
    reviewChanges(engineForConnection(activeConnection), target.table, bufferChanges(buffer)).then(
      (r) =>
        setReview((cur) =>
          cur?.tabId === tabId ? { ...cur, sql: r.sql, cards: reviewCards(buffer, target.table.table, r.statements ?? [], r.sql) } : cur,
        ),
      (e) => setReview((cur) => (cur?.tabId === tabId ? { ...cur, error: String(e) } : cur)),
    );
  };
  /** Discard: the buffer goes at once; Undo (⌥⌘Z) puts it back. */
  const discardEdits = () => {
    const tab = activeTab;
    const prev = tab?.edits;
    const n = changeCount(prev);
    if (!tab || !n) return;
    setTabEdits(tab.id, undefined);
    setTray(tab.id, null);
    showUndoToast(`Discarded ${n} ${n === 1 ? "edit" : "edits"}`, undefined, {
      undo: () => setTabEdits(tab.id, prev),
    });
  };
  const trayUp = isTableTab && resultsView === "data" && (rowEdits.count > 0 || !!trays[activeTabId]);
  const editKeysRef = useRef({ review: openReview });
  editKeysRef.current = { review: openReview };
  /** Review SQL in the inspector: what Esc, ⌘S and ⇧⌘↵ do while it shows. */
  const reviewShown = review && review.tabId === activeTabId ? review : null;
  const commitReview = () => {
    const sql = reviewShown?.sql;
    if (!sql) return;
    setReview(null);
    // The review showed exactly this text: it is the confirmation.
    void commitEdits(sql);
  };
  const reviewKeysRef = useRef({ open: false, close: () => {}, commit: () => {} });
  reviewKeysRef.current = { open: !!reviewShown, close: () => setReview(null), commit: commitReview };

  /** COMMENT ON COLUMN of the table the result reads: header tooltips, Quick Look. */
  const commentsByColumn = useMemo(
    () => columnComments(resultTableKey ? findTable(schemaTree, resultTableKey)?.table : undefined),
    [resultTableKey, schemaTree],
  );

  // Quick Look labels a foreign key with the row it points at, read on the
  // window's own Quick Look session so it never touches a tab's session or
  // transaction. The lookups a row asks for in one go travel as one call.
  const followCache = useRef(new Map<string, Promise<string | null>>());
  /** Labels that have landed, read during render (`peek`). */
  const followLabels = useRef(new Map<string, string | null>());
  useEffect(() => {
    followCache.current.clear();
    followLabels.current.clear();
  }, [schemaTree]);
  const followBatch = useRef<{ lookup: FollowLookup; resolve: (label: string | null) => void }[]>([]);
  const resultTableItem = resultTableKey ? findTable(schemaTree, resultTableKey) : undefined;
  // Sensitive columns (marked on the Agents page or from a header): the ones
  // of the database this window shows, as the MCP server keys them.
  const marksDb = activeConnection
    ? activeConnection.kind === "postgres"
      ? (session.database ?? activeConnection.database)
      : "main"
    : null;
  const allMarks = activeConnection?.masked_columns;
  const dbMarks = marksDb ? allMarks?.[marksDb] : undefined;
  const markTable = isTableTab && resultTableItem ? resultTableItem : null;
  const markedSet = useMemo(
    () => (dbMarks?.length ? markedNames(dbMarks, markTable && { schema: markTable.schema, name: markTable.name }) : null),
    [dbMarks, markTable?.schema, markTable?.name],
  );
  const hiddenSet = presenting ? markedSet : null;
  const markColumn = (column: string, marked: boolean) => {
    if (!activeConnection || !marksDb || !markTable) return;
    const name = `${markTable.schema}.${markTable.name}.${column}`;
    actions.setMaskedColumns(activeConnection.id, withMasked(allMarks, marksDb, [name], marked));
    showToast(marked ? "Marked as sensitive" : "No longer sensitive", column);
  };
  const resultTable = resultTableItem?.table;
  /** Our single-column foreign keys, by column: what Quick Look and ⌘↵ follow. */
  const outgoing = useMemo(() => {
    const map = new Map<string, KeyTarget>();
    for (const f of resultTable?.foreign_keys ?? []) {
      if (f.columns.length === 1) map.set(f.columns[0], { schema: f.ref_schema, table: f.ref_table, column: f.ref_columns[0] });
    }
    return map;
  }, [resultTable]);
  const followKeyOf = (column: string, value: Value) => {
    const fk = outgoing.get(column);
    const literal = sqlLiteral(value);
    return fk && literal !== null ? { fk, key: `${fk.schema}.${fk.table}.${fk.column}=${literal}` } : null;
  };
  const followKeyOfRef = useRef(followKeyOf);
  followKeyOfRef.current = followKeyOf;
  const followKey = useMemo<FollowKey | undefined>(() => {
    if (!outgoing.size || !activeConnection) return undefined;
    const flush = () => {
      const batch = followBatch.current;
      followBatch.current = [];
      followKeys(
        windowId,
        batch.map((b) => b.lookup),
      ).then(
        (rows) =>
          batch.forEach((b, i) => {
            const found = rows[i];
            b.resolve(found ? followLabel(found, b.lookup.column) : null);
          }),
        () => batch.forEach((b) => b.resolve(null)),
      );
    };
    return (column, value) => {
      const k = followKeyOfRef.current(column, value);
      if (!k) return Promise.resolve(null);
      let hit = followCache.current.get(k.key);
      if (!hit) {
        hit = new Promise<string | null>((resolve) => {
          if (followBatch.current.length === 0) queueMicrotask(flush);
          followBatch.current.push({
            lookup: { schema: k.fk.schema, table: k.fk.table, column: k.fk.column, value },
            resolve: (label) => {
              followLabels.current.set(k.key, label);
              resolve(label);
            },
          });
        });
        followCache.current.set(k.key, hit);
      }
      return hit;
    };
  }, [outgoing, activeConnection, windowId]);

  // Speculative labels: 80 ms after a cell selection settles, every key of its
  // row is looked up in one call (one in flight; a newer row waits and
  // supersedes any that waited before it), so Space opens filled.
  const [keyCell, setKeyCell] = useState<{ column: string; value: Value } | null>(null);
  const speculation = useRef<{ timer?: number; busy: boolean; next: unknown[] | null }>({ busy: false, next: null });
  const speculate = useRef((_values: unknown[]) => {});
  speculate.current = (values: unknown[]) => {
    const spec = speculation.current;
    if (spec.busy) {
      spec.next = values;
      return;
    }
    const columns = result?.columns ?? [];
    const asked = followKey
      ? columns.flatMap((c, i) => {
          const v = values[i] as Value | null | undefined;
          return v && !("Null" in v) && outgoing.has(c.name) ? [followKey(c.name, v)] : [];
        })
      : [];
    if (!asked.length) return;
    spec.busy = true;
    void Promise.all(asked).finally(() => {
      spec.busy = false;
      const next = spec.next;
      spec.next = null;
      if (next) speculate.current(next);
    });
  };
  const onCellSelect = useCallback(
    (cell: { row: number; column: string; values: unknown[] } | null) => {
      const spec = speculation.current;
      window.clearTimeout(spec.timer);
      const columns = result?.columns ?? [];
      const at = cell ? columns.findIndex((c) => c.name === cell.column) : -1;
      const value = cell && at >= 0 ? (cell.values[at] as Value | null) : null;
      setKeyCell(cell && value && !("Null" in value) && outgoing.has(cell.column) ? { column: cell.column, value } : null);
      if (!cell) return;
      spec.timer = window.setTimeout(() => speculate.current(cell.values), SPECULATE_MS);
    },
    [result?.columns, outgoing],
  );
  useEffect(() => () => window.clearTimeout(speculation.current.timer), []);

  // Tables whose single-column keys point at the result's table: Incoming.
  const incomingRefs = useMemo<IncomingRef[]>(() => {
    if (!resultTableItem) return [];
    const out: IncomingRef[] = [];
    for (const t of allTables(schemaTree)) {
      for (const f of t.table.foreign_keys ?? []) {
        if (f.columns.length !== 1 || f.ref_schema !== resultTableItem.schema || f.ref_table !== resultTableItem.name) continue;
        out.push({ schema: t.schema, table: t.name, column: f.columns[0], refColumn: f.ref_columns[0] });
      }
    }
    return out;
  }, [schemaTree, resultTableItem]);

  /** Bumped to open Quick Look in the grid (⌘K, a follow landing). */
  const [quickLookAsk, setQuickLookAsk] = useState(0);
  /** A follow waiting for its rows, to open Quick Look on them. */
  const lookOnLand = useRef<{ tableKey: string; stale: QueryResultDto | null } | null>(null);
  useEffect(() => {
    const want = lookOnLand.current;
    if (!want || activeTab?.tableKey !== want.tableKey) return;
    if (runStartedAt != null || !result || result === want.stale || result.error) return;
    lookOnLand.current = null;
    if (result.row_count > 0) setQuickLookAsk((n) => n + 1);
  }, [result, runStartedAt, activeTab?.tableKey]);

  const followToRef = useRef((_target: KeyTarget, _value: Value, _own: boolean) => {});
  const quickLookLinks = useMemo<QuickLookLinks | null>(
    () =>
      activeConnection && resultTableItem
        ? {
            outgoing,
            incoming: incomingRefs,
            peek: (column, value) => {
              const k = followKeyOfRef.current(column, value);
              return k ? followLabels.current.get(k.key) : undefined;
            },
            follow: (target, value, own) => followToRef.current(target, value, own),
            countIncoming: (lookups) => countIncoming(windowId, lookups),
          }
        : null,
    [activeConnection, resultTableItem, outgoing, incomingRefs, windowId],
  );

  const setActiveViewRef = useRef(setActiveView);
  setActiveViewRef.current = setActiveView;

  /** Focuses the table filter, showing the sidebar first if it is hidden. */
  const focusFilter = () => {
    if (!sidebarHidden) return filterRef.current?.focus();
    actions.toggleSidebar();
    requestAnimationFrame(() => filterRef.current?.focus());
  };
  const focusFilterRef = useRef(focusFilter);
  focusFilterRef.current = focusFilter;
  const heldRef = useRef<TabRun["held"]>(null);
  const dropHeldRef = useRef(() => {});
  const confirmHeldRef = useRef(() => {});
  const closeActiveTabRef = useRef(() => {});
  const refreshSchemaRef = useRef(() => {});
  refreshSchemaRef.current = () => {
    if (connState === "connected") actions.refreshSchema(windowId, true);
  };
  // ⌘W (Ctrl+W): the shown query tab, or the window when its connection was
  // used last (closeScope.ts). A window with no connection has no tab to close.
  closeActiveTabRef.current = () => {
    if (closeScope() === "connection" || (!activeId && windowCount > 1)) actions.closeWindow();
    else closeTab(activeTabId);
  };
  // Opening or switching a query tab (a table picked in the schema column
  // too, even into the same preview tab) makes it what ⌘W closes next.
  // Showing another window doesn't.
  const shownTabKey = `${activeTabId}:${activeTab?.kind}:${activeTab?.title}`;
  const scopeTabKey = useRef(shownTabKey);
  useEffect(() => {
    if (scopeTabKey.current === shownTabKey) return;
    scopeTabKey.current = shownTabKey;
    if (active) setCloseScope("tab");
  }, [shownTabKey, active]);

  useEffect(() => {
    if (!active || keysBlocked) return;
    const onKey = (e: KeyboardEvent) => {
      // Something nearer the focus (⌘K, a keymap's swapped chord) took the key.
      // History's Alt+←/→ still steps when the grid's arrow moved its ring too.
      const historyKey = isMacPlatform()
        ? e.metaKey && (e.key === "[" || e.key === "]")
        : e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight");
      if (e.defaultPrevented && !historyKey) return;
      // ⌃⌘ chords belong to macOS (⌃⌘F full screen, ⌃⌘Space characters, ⌃⌘Q lock):
      // none of these is a ⌘ chord, and preventing one keeps it from the menu bar.
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // ⌥⌘↵ (Ctrl+Alt+↵ elsewhere): Run All Statements, from the editor or anywhere in the window.
      if (mod && e.altKey && !e.shiftKey && e.key === "Enter" && !isTableTabRef.current) {
        e.preventDefault();
        runCommandRef.current("run-all");
        return;
      }
      // ⌥⌘1 / ⌥⌘2 (Ctrl+Alt elsewhere): Data / Structure. e.code, since ⌥ changes e.key.
      if (mod && e.altKey && !e.shiftKey && /^Digit[12]$/.test(e.code)) {
        e.preventDefault();
        setActiveViewRef.current(e.code === "Digit1" ? "data" : "structure");
        retireTip("view-keys");
        return;
      }
      // Ctrl+W closes the query tab or the window (closeScope.ts), never the app.
      // On macOS ⌘W comes from the menu bar instead (File > Close Tab,
      // `rowkery:command`, see main.tsx).
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        e.code === "KeyW" &&
        !isMacPlatform() &&
        !paletteOpen
      ) {
        e.preventDefault();
        closeActiveTabRef.current();
        return;
      }
      // ⌘R (Ctrl+R): reload the schema, e.g. after a migration run elsewhere;
      // on a window whose connection failed, connect again. ⌘E there opens
      // the connection's settings with the field that failed marked.
      // ⇧⌘R (Ctrl+Shift+R) on a table tab: its rows again.
      if (mod && !e.altKey && e.shiftKey && e.code === "KeyR" && isTableTabRef.current) {
        e.preventDefault();
        refreshRowsRef.current();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        if (failedRef.current) retryRef.current();
        else refreshSchemaRef.current();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyE" && failedRef.current) {
        e.preventDefault();
        editFailedRef.current();
        return;
      }
      // ⌘[ ⌘] (Alt+← Alt+→ elsewhere: Ctrl+[ is Esc in some toolkits): history.
      const back = isMacPlatform()
        ? e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && (e.key === "[" || e.key === "]")
        : e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight");
      if (back) {
        e.preventDefault();
        goHistoryRef.current(e.key === "[" || e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // ⌘⇧T (Ctrl+Shift+T): reopen the most recently closed tab.
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyT") {
        e.preventDefault();
        reopenClosedTabRef.current();
        return;
      }
      // ⇧⌘E (Ctrl+Shift+E): Export… the shown result, all of it.
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyE") {
        e.preventDefault();
        void exportWholeRef.current("file");
        return;
      }
      // Table tabs: ⌘E opens the query in a query tab, ⌘F focuses the filter.
      if (mod && !e.altKey && !e.shiftKey && isTableTabRef.current) {
        if (e.code === "KeyE") {
          e.preventDefault();
          void openInQueryTabRef.current();
          return;
        }
        if (e.code === "KeyF") {
          e.preventDefault();
          focusTableFilterRef.current();
          return;
        }
      }
      // Query tabs: ⌘E explains the statement under the caret (an estimate).
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyE" && !isTableTabRef.current) {
        e.preventDefault();
        runCommandRef.current("explain");
        return;
      }
      // The inspector's Review SQL: ⌘S or ⇧⌘↵ commits the text it shows, Esc closes it
      // (after a menu, the cell editor and a chip draft, which take Esc first).
      const rv = reviewKeysRef.current;
      if (rv.open) {
        if (e.key === "Escape") {
          e.preventDefault();
          rv.close();
          return;
        }
        if (mod && !e.altKey && ((e.code === "KeyS" && !e.shiftKey) || (e.key === "Enter" && e.shiftKey))) {
          e.preventDefault();
          rv.commit();
          return;
        }
      }
      // Quick Look with the focus outside the grid (the grid takes its own Esc).
      if (e.key === "Escape" && qlViewRef.current && !isTypingTarget(e.target)) {
        e.preventDefault();
        qlViewRef.current.close();
        return;
      }
      // Table tabs: ⌘S commits the tray, ⇧⌘P reviews its SQL.
      if (mod && !e.altKey && isTableTabRef.current && rowEditsRef.current.count > 0) {
        if (e.code === "KeyS" && !e.shiftKey) {
          e.preventDefault();
          void commitEditsRef.current();
          return;
        }
        if (e.code === "KeyP" && e.shiftKey) {
          e.preventDefault();
          editKeysRef.current.review();
          return;
        }
      }
      // Confirm writes held a commit: ⇧⌘↵ sends exactly what it shows, Esc keeps editing.
      const heldCommit = heldEditRef.current.held;
      if (heldCommit && !paletteOpen && !e.defaultPrevented) {
        if (e.key === "Escape") {
          e.preventDefault();
          heldEditRef.current.drop();
          return;
        }
        if (e.key === "Enter" && mod && e.shiftKey && !e.altKey) {
          e.preventDefault();
          void commitEditsRef.current(heldCommit.sql);
          return;
        }
      }
      // Table tabs: ⌘I stages a new row, ⌘D copies the selected rows as new ones.
      if (mod && !e.altKey && !e.shiftKey && isTableTabRef.current && !isTypingTarget(e.target) && !e.defaultPrevented) {
        const edits = rowEditsRef.current;
        if (e.code === "KeyI" && edits.rowsEditable) {
          e.preventDefault();
          edits.insertRow();
          return;
        }
        if (e.code === "KeyD" && edits.cellEditable) {
          e.preventDefault();
          edits.duplicateSelected();
          return;
        }
      }
      // Query tabs: ⌘I formats the statement under the caret (or the selected
      // ones); on a table tab it inserts a row, above.
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyI" && !isTableTabRef.current) {
        e.preventDefault();
        runCommandRef.current("format-sql");
        return;
      }
      // Query tabs: ⌘F finds in the rows the result loaded.
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyF" && !isTableTabRef.current) {
        e.preventDefault();
        openFindRef.current();
        return;
      }
      // # on a table tab: count the rows exactly (the ≈ in the SQL line).
      if (e.key === "#" && !mod && !isTypingTarget(e.target) && isTableTabRef.current) {
        e.preventDefault();
        void countExactRef.current();
        return;
      }
      if (e.key === "/" && !mod && !isTypingTarget(e.target)) {
        e.preventDefault();
        focusFilterRef.current();
        return;
      }
      // ⌘. (Ctrl+.) always cancels the shown tab's query.
      if (mod && !e.altKey && !e.shiftKey && e.code === "Period" && runStartedAt !== null) {
        e.preventDefault();
        void onCancelRef.current();
        return;
      }
      if (
        e.key === "Escape" &&
        runStartedAt !== null &&
        !paletteOpen &&
        !e.defaultPrevented &&
        !escLeftSelection.has(e)
      ) {
        e.preventDefault();
        void onCancelRef.current();
        return;
      }
      // Safe mode: Esc drops a held write, ⇧⌘↵ (Ctrl+Shift+Enter) runs it.
      if (heldRef.current && !paletteOpen && !e.defaultPrevented) {
        if (e.key === "Escape") {
          e.preventDefault();
          dropHeldRef.current();
          return;
        } else if (e.key === "Enter" && mod && e.shiftKey && !e.altKey) {
          e.preventDefault();
          confirmHeldRef.current();
        }
      }
      // Esc, last (2026-10-13): with no cell open, no query running
      // and nothing else to dismiss, it discards the tab's pending edits; the
      // toast offers Undo, so there is no confirm. (A staged cell under the
      // ring reverts alone first, in the grid.)
      if (
        e.key === "Escape" &&
        !paletteOpen &&
        !e.defaultPrevented &&
        !isTypingTarget(e.target) &&
        !escLeftSelection.has(e) &&
        isTableTabRef.current &&
        rowEditsRef.current.count > 0
      ) {
        e.preventDefault();
        runCommandRef.current("discard-edits");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, keysBlocked, runStartedAt, paletteOpen]);

  // Menu bar picks (main.tsx), run like a ⌘K command. On the Agents page they
  // still run (#208: Help > Report an Issue… did nothing there): a sheet opens
  // over the page; anything else works on the window, so the page goes first.
  // ⌘W is App's (it closes the page), and a query never starts unseen.
  const agentsOpenRef = useRef(agentsOpen);
  agentsOpenRef.current = agentsOpen;
  const onToggleAgentsRef = useRef(onToggleAgents);
  onToggleAgentsRef.current = onToggleAgents;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const onCloseSettingsRef = useRef(onCloseSettings);
  onCloseSettingsRef.current = onCloseSettings;
  useEffect(() => {
    if (!active || commandsBlocked) return;
    const onCommand = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string") return;
      if (agentsOpenRef.current || settingsOpenRef.current) {
        if (id === "close-tab" || id === "run" || id === "run-all") return;
        if (!opensOverPage(id)) {
          if (settingsOpenRef.current) onCloseSettingsRef.current?.();
          else onToggleAgentsRef.current?.();
          return void requestAnimationFrame(() => runCommandRef.current(id));
        }
        return runCommandRef.current(id);
      }
      // The menu's ⌘W picks what to close; ⌘K's own Close query tab doesn't.
      // With ⌘K open, App closes it instead.
      if (id === "close-tab") return void (paletteOpen || closeActiveTabRef.current());
      runCommandRef.current(id);
    };
    window.addEventListener("rowkery:command", onCommand);
    return () => window.removeEventListener("rowkery:command", onCommand);
  }, [active, commandsBlocked, paletteOpen]);

  const anyRunning = Object.values(runs).some((r) => r.startedAt !== null);
  // Connect to start stays through the connect begun from it, then leaves in
  // one 100 ms fade as the first schema lands (or the failure shows).
  const [emptyHeld, setEmptyHeld] = useState(!activeId);
  const emptyPose = emptyWindowPose({
    connectionId: activeId,
    state: connState,
    running: anyRunning,
    hasData: !!schema,
    heldFromEmpty: emptyHeld,
  });
  if (!!emptyPose !== emptyHeld) setEmptyHeld(!!emptyPose);
  const failure = useConnectFailure({
    connectionId: activeId,
    error: connState === "error" ? session.error : null,
    cause: explained?.cause ?? null,
    connecting: connState === "connecting",
    running: anyRunning,
    hasData: schemaTree.length > 0,
  });
  const runningCount = Object.values(runs).filter((r) => r.startedAt !== null).length;
  useEffect(() => {
    onRunningChange?.(windowId, runningCount);
  }, [onRunningChange, windowId, runningCount]);
  // Elapsed times tick in `Elapsed` alone (the run clock above): a running
  // query never re-renders the workspace or the grid.

  // Cancel asks the server; pressed again (Force stop, or Esc twice) core
  // stops the run outright. Core also does that by itself after 3 s, since
  // a dead connection never answers a cancel.
  const onCancel = async () => {
    if (runStartedAt === null) return;
    const tabId = activeTabId;
    patchRun(tabId, { cancelling: true });
    try {
      await cancelQuery(windowId, tabId);
    } catch (e) {
      flash(String(e));
    }
  };
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  /** The statement `runStatements` runs next, and where it starts in the editor. */
  const nextStatement = useRef<{ at: number | null } | null>(null);

  /**
   * `remember: false` keeps sidebar/palette browses out of Recent queries;
   * `tableKey` names the table a browse reads, for its key column icons.
   * `tabId` is the tab to run in: a tab opened this tick isn't active yet here.
   */
  const onRun = async (
    sqlText?: string,
    remember = true,
    tableKey?: string,
    tabId = activeTabId,
    /** The user confirmed this exact SQL on a Confirm writes connection. */
    confirmed = false,
    /** Table tabs: `page` rows per fetch; `append` adds a page to the rows shown. */
    paging?: { page: number; append?: boolean },
    /** A table tab's browse: core builds and runs its SQL (`sqlText` is a label). */
    browse?: BrowseRequest,
    /**
     * A table tab's browse (from `runTable`): what the tab was (`key`) and
     * whether that is still what it wants when the answer lands. An outdated
     * answer is dropped, never shown over a newer state.
     */
    tableRun?: { key: string; tableKey: string; current: () => boolean },
  ): Promise<RunEnd> => {
    const text = sqlText ?? sqlEditorRef.current?.getSqlToRun() ?? activeSql;
    // Set by `runStatements` for each statement it runs.
    const part = nextStatement.current;
    nextStatement.current = null;
    // `runTable` keeps a table tab to one run at a time (and its queued run
    // may start before a render shows the last one ended).
    if ((!tableRun && runsRef.current[tabId]?.startedAt != null) || !text.trim()) return "skipped";
    // Where the statement starts in the editor: error positions count from there.
    const target = !browse && !paging ? sqlEditorRef.current?.getRunTarget() : undefined;
    // A selection of several statements (a script with BEGIN … COMMIT) runs
    // as Run All does: a server prepares one statement at a time.
    if (!browse && !paging && !tableRun && !confirmed && !part) {
      const ranges = sqlStatementRanges(text);
      if (ranges.length > 1)
        return runStatements(text, ranges, target && target.sql === text ? target.start : null, tabId);
    }
    const runStart = part ? part.at : target && target.sql === text ? target.start : null;
    patchRun(tabId, (prev) => ({
      error: null,
      cancelling: false,
      waiting: false,
      outcome: null,
      elapsedMs: null,
      held: null,
      plan: paging?.append ? prev.plan : null,
      startedAt: Date.now(),
      appending: !!paging?.append,
      runNo: paging?.append ? prev.runNo : (prev.runNo ?? 0) + 1,
      errorMark: paging?.append ? prev.errorMark : null,
      // A run of its own ends the last run's statement list; the next of a
      // run keeps the one shown until now as it is (rows Load more added).
      ...(paging?.append ? {} : part ? keepShownStatement(prev) : { statements: null, statementAt: undefined }),
    }));
    setNotice(null);
    if (remember && !confirmed) {
      setHistory((prev) => recordHistory(activeId, prev, text));
      recordKeywords(text);
    }
    let outcome: TabRun["outcome"] = "done";
    let end: RunEnd = "done";
    const started = performance.now();
    // The database's own timing when it answered, else what the wait took.
    let elapsedMs: number | null = null;
    const timing = startQuery(windowId, tabId, text);
    // Rows show as they stream; a result that lands whole gets the reveal.
    let streamed = false;
    try {
      // A page appended to a table tab is small; it lands whole.
      const onProgress = paging?.append
        ? undefined
        : (partial: QueryResultDto) => {
              if (tableRun && !tableRun.current()) return;
              streamed = true;
              patchRun(tabId, { result: partial, streaming: true });
          };
      // Every connection is busy: the tab says it waits, rather than look stuck.
      const onWaiting = (waiting: boolean) => {
        if (tableRun && !tableRun.current()) return;
        patchRun(tabId, { waiting });
      };
      // A query runs as written, every row it returns (up to the cap a tab
      // holds): its own LIMIT says how many it wants.
      const res = browse
        ? await browseTable(windowId, tabId, browse, onProgress, onWaiting)
        : await runQuery(windowId, tabId, text, { confirmed, onProgress, onWaiting });
      if (!res.hold) timing.rows(res.row_count, res.elapsed_ms, res.first_row_ms ?? null);
      // The tab changed while this ran: the run `runTable` queued shows instead.
      if (tableRun && !tableRun.current()) {
        outcome = null;
        return "skipped";
      }
      // A table tab's first page: the SQL line shows exactly what ran.
      if (browse && !paging?.append && "sql" in res && typeof res.sql === "string") {
        const ran = { sql: res.sql, filter: browse.filter ?? "", tableKey: tableRun?.tableKey ?? "", key: tableRun?.key ?? "" };
        setLineSql((prev) => {
          const was = prev[tabId];
          return was && was.sql === ran.sql && was.filter === ran.filter && was.key === ran.key
            ? prev
            : { ...prev, [tabId]: ran };
        });
        const clause = pendingWash.current[tabId];
        if (clause) {
          delete pendingWash.current[tabId];
          setLineWash((w) => ({ tabId, clause, n: (w?.n ?? 0) + 1 }));
        }
      }
      if (res.hold) {
        // Nothing ran: keep the last results (faded) under the bar.
        patchRun(tabId, {
          held: { sql: text, hold: res.hold, tableKey: tableKey ?? null, statement: part ?? undefined },
          startedAt: null,
          outcome: null,
          elapsedMs: null,
        });
        return "held";
      }
      if (res.cancelled) outcome = null;
      else if (res.error) outcome = "error";
      end = res.cancelled ? "cancelled" : res.error ? "error" : "done";
      elapsedMs = res.elapsed_ms;
      const answered = !res.error && !res.cancelled;
      // At the cap a tab stops loading: no Load more, and a toast says so.
      const capAt = (more: boolean, loaded: number) => {
        if ((more && atCap(loaded)) || res.capped) {
          if (answered) showToast(CAPPED_MESSAGE);
          return false;
        }
        return more;
      };
      if (paging?.append) {
        // A failed page leaves the rows already loaded in place.
        if (answered) {
          const hasMore = capAt(
            paging.page > 0 && res.row_count >= paging.page,
            (runsRef.current[tabId]?.result?.rows.length ?? 0) + res.rows.length,
          );
          patchRun(tabId, (prev) => ({
            hasMore,
            result: prev.result
              ? {
                  ...prev.result,
                  rows: ResultRows.concat(prev.result.rows, res.rows),
                  row_count: prev.result.row_count + res.row_count,
                  elapsed_ms: res.elapsed_ms,
                }
              : res,
          }));
        } else if (res.error) flash(res.error);
      } else {
        // A query's new rows cascade in when the tab next shows them.
        if (answered && !paging && !streamed) markReveal(res);
        const patch: Partial<TabRun> = {
          result: res,
          hasMore: capAt(
            !!paging && paging.page > 0 && answered && res.row_count >= paging.page,
            res.rows.length,
          ),
          ranSql: browse ? undefined : text,
        };
        // A table tab names its table; a query's own SQL says which it read.
        // A failed or cancelled run keeps what the tab showed before.
        if (tableKey !== undefined) patch.tableKey = tableKey;
        else if (answered) patch.tableKey = readTableKey(text);
        // The server pointed at a token: underline it, put the caret there,
        // and find the name it probably meant.
        if (res.error && !res.cancelled && res.error_position && runStart !== null) {
          const editorText = tabsRef.current.find((t) => t.id === tabId)?.sql ?? "";
          const at = runStart + positionToOffset(text, res.error_position);
          const token = tokenAt(editorText, at);
          patch.errorMark = { ...token, suggestion: suggestName(res.error, res.sqlstate ?? null, text) };
          if (tabId === activeTabIdRef.current) requestAnimationFrame(() => sqlEditorRef.current?.jumpTo(at));
        }
        if (part) {
          // A statement of a run of several joins its list, and shows.
          patchRun(tabId, (prev) => {
            const statements = [...(prev.statements ?? []), shownStatement({ ...prev, ...patch })];
            return { ...patch, statements, statementAt: statements.length - 1 };
          });
        } else patchRun(tabId, patch);
      }
    } catch (e) {
      outcome = "error";
      end = "error";
      patchRun(tabId, { error: String(e) });
    } finally {
      patchRun(tabId, {
        startedAt: null,
        appending: false,
        cancelling: false,
        waiting: false,
        streaming: false,
        outcome,
        elapsedMs: elapsedMs ?? Math.round(performance.now() - started),
      });
      // New or changed tables should complete (and show) right away. A tab
      // keeps its session, so DDL inside BEGIN only shows once it commits.
      if (outcome !== null) {
        if (CHANGES_SCHEMA.test(text)) {
          ddlTabs.current.add(tabId);
          actions.refreshSchema(windowId);
        } else if (ENDS_TRANSACTION.test(text) && ddlTabs.current.delete(tabId)) {
          actions.refreshSchema(windowId);
        }
      }
    }
    return end;
  };

  /**
   * Each of `ranges` (statements of `text`) in turn on the tab's session, as
   * ⌘↵ on each would (a server runs one statement per query, so the whole
   * text can't go as one). Stops at the first that fails, is cancelled or is
   * held by safe mode. Each keeps its result, listed beside the grid, and the
   * results show the last that ran. `at` is where `text` starts in the
   * editor, so an error marks its statement.
   */
  const runStatements = async (text: string, ranges: CharRange[], at: number | null, tabId: typeof activeTabId) => {
    if (runsRef.current[tabId]?.startedAt != null) return "skipped";
    patchRun(tabId, { statements: [], statementAt: undefined });
    let end: RunEnd = "skipped";
    for (const range of ranges) {
      nextStatement.current = { at: at === null ? null : at + range.start };
      end = await onRun(text.slice(range.start, range.end), true, undefined, tabId);
      if (end !== "done") return end;
      // onRun refuses while the tab shows a run: wait for the render that ends this one.
      while (runsRef.current[tabId]?.startedAt != null) await new Promise((r) => setTimeout(r, 16));
    }
    return end;
  };

  /**
   * ⌘E: the plan of the statement under the caret (or the selection), in
   * place of the results. An estimate runs nothing; `timed` runs it once
   * with ANALYZE (Postgres), a write only after safe mode lets it, and
   * rolled back. `sqlText` re-explains what the plan or a held write showed.
   */
  const onExplain = async (timed: boolean, sqlText?: string, confirmed = false, tabId = activeTabId) => {
    const text = (sqlText ?? sqlEditorRef.current?.getSqlToRun() ?? activeSql).trim();
    if (!text || runsRef.current[tabId]?.startedAt != null) return;
    if (sqlStatementRanges(text).length > 1) return flash("Explain works on one statement at a time.");
    patchRun(tabId, { error: null, cancelling: false, held: null, outcome: null, startedAt: Date.now() });
    setNotice(null);
    let outcome: TabRun["outcome"] = "done";
    const started = performance.now();
    try {
      const out = await explainStatement(windowId, tabId, text, timed, confirmed);
      if (out.kind === "held") {
        outcome = null;
        patchRun(tabId, { held: { sql: text, hold: out.hold, tableKey: null, explain: true } });
      } else if (out.kind === "cancelled") {
        outcome = null;
      } else {
        patchRun(tabId, { plan: { plan: out.plan, sql: text, elapsedMs: out.elapsed_ms } });
      }
    } catch (e) {
      outcome = "error";
      patchRun(tabId, { error: String(e), plan: null });
    } finally {
      patchRun(tabId, {
        startedAt: null,
        cancelling: false,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
      });
    }
  };

  /**
   * Shows statement `index` of the tab's last run of several; the one shown
   * until now keeps what it has.
   */
  const showStatement = (tabId: typeof activeTabId, index: number) =>
    patchRun(tabId, (prev) => {
      const list = prev.statements;
      if (!list?.[index] || prev.startedAt != null || index === prev.statementAt) return {};
      const statements = keepShownStatement(prev).statements ?? list;
      return { ...statements[index], statements, statementAt: index };
    });

  /** Run All Statements: every statement of the editor. */
  const runAll = async () => {
    const text = activeSql;
    await runStatements(text, sqlStatementRanges(text), 0, activeTabId);
  };

  /**
   * "Did you mean name?": for an unknown column (42703) the columns of the
   * tables the statement names, for an unknown table (42P01) every table;
   * the nearest within two edits.
   */
  const suggestName = (message: string, sqlstate: string | null, sqlText: string): string | null => {
    if (sqlstate !== "42703" && sqlstate !== "42P01") return null;
    const name = quotedName(message);
    if (!name) return null;
    const tables = schemaTree.flatMap((s) => [...s.tables, ...s.views]);
    if (sqlstate === "42P01") return nearestName(name, tables.map((t) => t.name));
    const words = new Set(sqlText.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []);
    const named = tables.filter((t) => words.has(t.name.toLowerCase()));
    const columns = (named.length ? named : tables).flatMap((t) => (t.table.columns ?? []).map((c) => c.name));
    return nearestName(name, new Set(columns));
  };

  /** Replace and run (↵ in the token, or the button): one undo step, then ⌘↵. */
  const applySuggestion = (): boolean => {
    const mark = runsRef.current[activeTabId]?.errorMark;
    if (!mark?.suggestion || !sqlEditorRef.current) return false;
    const plain = /^[a-z_][a-z0-9_$]*$/.test(mark.suggestion);
    sqlEditorRef.current.replaceRange(mark.start, mark.end, plain ? mark.suggestion : sqlIdent(mark.suggestion));
    // After the edit lands, run the statement the caret is in.
    requestAnimationFrame(() => void onRunRef.current());
    return true;
  };

  /** The catalog table a SELECT reads when it reads exactly one. */
  const readTableKey = (sqlText: string): string | null => {
    if (!schema || !completionEngine) return null;
    const rel = tableRead(sqlText, completionIndexFor(schema, completionEngine));
    return rel ? (keyBySchemaName.get(`${rel.schema}\0${rel.name}`) ?? null) : null;
  };

  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // A connection string pasted into the editor stays as text; the toast
  // offers to connect instead (↵ takes the text back out and opens the sheet).
  const pasteConnectionRef = useRef(actions.pasteConnection);
  pasteConnectionRef.current = actions.pasteConnection;
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const ta = e.target;
      if (!(ta instanceof HTMLTextAreaElement) || !ta.classList.contains("sql-editor")) return;
      if (!mainRef.current?.contains(ta)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!parsePostgresUrl(text)) return;
      const from = Math.min(ta.selectionStart, ta.selectionEnd);
      const replaced = ta.value.slice(from, Math.max(ta.selectionStart, ta.selectionEnd));
      showOfferToast("Looks like a connection URL", "Connect", "Esc keeps the text", {
        scope: ta,
        run: () => {
          if (ta.value.slice(from, from + text.length) === text)
            sqlEditorRef.current?.replaceRange(from, from + text.length, replaced);
          pasteConnectionRef.current(text);
        },
      });
    };
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
  }, [active]);

  // A hidden window keeps its boxes (`content-visibility: hidden`, App.css),
  // which not every engine treats as leaving focus: let go of it here, as
  // `display: none` did, so keys never land in a window that isn't shown.
  const workspaceRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && workspaceRef.current?.contains(focused)) focused.blur();
  }, [active]);

  // The sample's Getting started: its statement has run by the time the
  // window paints its schema, so the first screen already holds rows.
  const ranOnConnect = useRef(false);
  useEffect(() => {
    if (!runOnConnect || ranOnConnect.current || connState !== "connected") return;
    ranOnConnect.current = true;
    const tab = tabs.find((t) => t.id === activeTabId);
    const first = tab ? sqlStatementRanges(tab.sql)[0] : undefined;
    if (tab && first) void onRunRef.current(tab.sql.slice(first.start, first.end), false, undefined, tab.id);
  }, [runOnConnect, connState]);

  // Safe mode: the active tab's held write, run or dropped from the bar or keys.
  const held = activeRun.held;
  heldRef.current = runStartedAt === null ? held : null;
  const dropHeld = () => patchRun(activeTabId, { held: null });
  const confirmHeld = () => {
    if (!held || held.hold.action !== "confirm") return;
    if (held.explain) void onExplain(true, held.sql, true);
    else {
      if (held.statement) nextStatement.current = held.statement;
      void onRun(held.sql, true, held.tableKey ?? undefined, activeTabId, true);
    }
    sqlEditorRef.current?.focus();
  };
  dropHeldRef.current = () => {
    dropHeld();
    sqlEditorRef.current?.focus();
  };
  confirmHeldRef.current = confirmHeld;

  // ---- Table tabs -------------------------------------------------------

  /**
   * What a table tab asks the core for: filter, sort, page. With a primary
   * key core orders by it last and the next page starts after the last row
   * loaded (keyset); without one it pages by OFFSET.
   */
  /**
   * Every column of a table tab's table, in table order: the catalog's, else
   * the columns its last unhidden browse showed (`fullColumns`).
   */
  const fullColumns = useRef<Record<string, string[]>>({});
  const tableColumnsOf = (tab: QueryTab): string[] => {
    const cols = tab.tableKey ? findTable(schemaTree, tab.tableKey)?.table.columns : undefined;
    if (cols?.length) return cols.map((c) => c.name);
    return (tab.tableKey && fullColumns.current[tab.tableKey]) || [];
  };

  const browseOptions = (tab: QueryTab, append: boolean): BrowseOptions => {
    const pk = tab.tableKey ? findTable(schemaTree, tab.tableKey)?.table.primary_key : undefined;
    const loaded = append ? runsRef.current[tab.id]?.result : null;
    const last = loaded ? loaded.rows.length - 1 : -1;
    return {
      columns: visibleColumns(tableColumnsOf(tab), tab.hidden ?? []),
      filter: tab.filter,
      order: tab.sort ?? [],
      key: pk ?? [],
      // All is everything up to the cap (`runTable` stops before a page of 0).
      limit: nextFetchRows(tab.pageSize ?? DEFAULT_PAGE, loaded ? loaded.rows.length : 0),
      offset: loaded ? loaded.rows.length : 0,
      after:
        loaded && last >= 0
          ? Object.fromEntries(loaded.columns.map((c, i) => [c.name, loaded.rows.get(last, i)]))
          : undefined,
    };
  };

  /** Runs (or, with `append`, loads the next page of) a table tab. */
  /**
   * One run at a time per table tab. A filter, sort, page size, hide or
   * history step made while one runs is queued (`queued`, the newest wins)
   * and runs as soon as the one in flight ends, whose answer is then dropped
   * if it no longer matches the tab. The run isn't cancelled: core doesn't
   * park a cancelled session, and a cancel that lands late could hit the
   * next run. A Load more asked for mid-run is dropped (scrolling asks
   * again), and one whose rows no longer match the tab loads a first page.
   */
  const runKey = (t: QueryTab) =>
    JSON.stringify([t.tableKey, t.filter ?? "", t.sort ?? [], t.pageSize ?? DEFAULT_PAGE, t.hidden ?? []]);
  const loading = useRef(new Map<number, string>());
  const queued = useRef(new Map<number, QueryTab>());
  /** What each table tab's rows were loaded for (`runKey`). */
  const shownKey = useRef<Record<number, string>>({});
  const runTable = async (tab: QueryTab, append = false): Promise<void> => {
    if (!activeConnection || !tab.tableKey || !tab.table) return;
    const key = runKey(tab);
    if (loading.current.has(tab.id)) {
      if (!append) queued.current.set(tab.id, tab);
      return;
    }
    if (append && shownKey.current[tab.id] !== key) append = false;
    // At the cap: nothing more to ask for (a limit of 0 would be every row).
    const page = nextFetchRows(tab.pageSize ?? DEFAULT_PAGE, append ? (runsRef.current[tab.id]?.result?.rows.length ?? 0) : 0);
    if (page === 0) {
      patchRun(tab.id, { hasMore: false });
      showToast(CAPPED_MESSAGE);
      return;
    }
    loading.current.set(tab.id, key);
    // Current while nothing different is queued behind it.
    const current = () => {
      const next = queued.current.get(tab.id);
      return !next || runKey(next) === key;
    };
    let ran = false;
    try {
      // One call: core builds the SELECT and runs it.
      await onRun(
        `browse ${tab.schema ?? ""}.${tab.table}`,
        false,
        tab.tableKey,
        tab.id,
        false,
        { page, append },
        {
          engine: engineForConnection(activeConnection),
          schema: tab.schema ?? "",
          table: tab.table,
          ...browseOptions(tab, append),
        },
        { key, tableKey: tab.tableKey, current },
      );
      ran = current();
      if (ran && !append) shownKey.current[tab.id] = key;
    } catch (e) {
      patchRun(tab.id, { error: String(e) });
    } finally {
      loading.current.delete(tab.id);
      const next = queued.current.get(tab.id);
      queued.current.delete(tab.id);
      // The newest state of the tab, unless what just landed already is it.
      if (next && tabsRef.current.some((t) => t.id === tab.id) && (!ran || append || runKey(next) !== key))
        void runTable(next);
    }
  };

  // Hover prefetch (the connection's switch, off by default): 120 ms on a
  // panel row reads the first page its click would browse, on the window's
  // prefetch session, and the click continues that cursor. Leaving the row
  // cancels it. Skipped where a click wouldn't browse fresh rows (its tab is
  // open), for views and partitioned parents, and for tables with no key.
  const hover = useRef<{ timer?: number; key: string | null; inflight: boolean }>({ key: null, inflight: false });
  const hoverTable = (t: SidebarTable | null) => {
    const h = hover.current;
    window.clearTimeout(h.timer);
    if (!t || t.key !== h.key) {
      if (h.inflight) void cancelPrefetch(windowId).catch(() => {});
      h.inflight = false;
      h.key = null;
    }
    if (!t || activeConnection?.kind !== "postgres" || connState !== "connected") return;
    if (!prefetchOn(activeConnection.id)) return;
    const keyed = !!t.table.primary_key?.length || !!t.table.indexes?.some((i) => i.unique);
    if (!keyed || isView(t) || t.partitions.length > 0) return;
    if (tabsRef.current.some((x) => x.kind === "table" && x.tableKey === t.key)) return;
    const engine = engineForConnection(activeConnection);
    h.timer = window.setTimeout(() => {
      // The tab its click would open, so the SQL matches the click's exactly.
      const tab: QueryTab = { id: 0, kind: "table", title: t.name, sql: "", tableKey: t.key, schema: t.schema, table: t.name, filter: "", sort: [] };
      h.key = t.key;
      h.inflight = true;
      mark("prefetch", { window: windowId, table: t.key });
      prefetchTable(windowId, { engine, schema: t.schema, table: t.name, ...browseOptions(tab, false) })
        .catch(() => false)
        .finally(() => {
          if (h.key === t.key) h.inflight = false;
        });
    }, PREFETCH_HOVER_MS);
  };
  useEffect(() => () => window.clearTimeout(hover.current.timer), []);

  // A restored table tab (or one whose rows went with a reconnect) browses
  // its table when it's shown on a connected window, once.
  const autoBrowsed = useRef(new Set<number>());

  /**
   * The connection and database the tabs belong to. When the window moves to
   * another one, a table tab whose table the new catalog doesn't have goes to
   * Recently closed (⇧⌘T or the Undo puts it back) instead of browsing a
   * table that isn't there (`relation "main.players" does not exist`).
   * Closing beats a "table not found" tab: nothing on screen is broken, and
   * moving back to the old connection and reopening restores it as it was.
   * The first connect only binds: restored tabs are this window's own.
   */
  const boundTo = useRef<string | null>(null);
  const boundKey = connState === "connected" && schema ? `${activeId}\0${session.database ?? ""}` : null;
  useEffect(() => {
    if (boundKey === null || boundTo.current === boundKey) return;
    const first = boundTo.current === null;
    boundTo.current = boundKey;
    if (first) return;
    const list = tabsRef.current;
    const gone = list.filter((t) => t.kind === "table" && (!t.tableKey || !findTable(schemaTree, t.tableKey)));
    if (!gone.length) return;
    const entries: ClosedTab[] = gone.map((tab) => ({ tab, run: undefined, index: list.indexOf(tab) }));
    closedTabs.current = [...closedTabs.current, ...entries].slice(-MAX_CLOSED_TABS);
    setClosedCount(closedTabs.current.length);
    const goneIds = new Set(gone.map((t) => t.id));
    for (const id of goneIds) {
      void closeQueryTab(windowId, id).catch(() => {});
      queued.current.delete(id);
    }
    setRuns((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !goneIds.has(Number(id)))));
    let rest = list.filter((t) => !goneIds.has(t.id));
    let nextActive = activeTabId;
    if (rest.length === 0) {
      const fresh = nextTabId.current++;
      rest = [queryTab(fresh, "Query 1", "")];
      nextActive = fresh;
    } else if (goneIds.has(activeTabId)) {
      const at = list.findIndex((t) => t.id === activeTabId);
      nextActive = (rest.find((t) => list.indexOf(t) > at) ?? rest[rest.length - 1]).id;
    }
    // Synchronously too: the auto-browse below must not see the closed tabs.
    tabsRef.current = rest;
    setTabs(rest);
    setActiveTabId(nextActive);
    const where = session.database ?? activeConnection?.name ?? "this connection";
    showUndoToast(
      gone.length === 1
        ? `Closed ${gone[0].title}: not in ${where}`
        : `Closed ${gone.length} table tabs not in ${where}`,
      undefined,
      { undo: () => entries.forEach((e) => reopenTabRef.current(e)) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundKey, schemaTree]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (!active || connState !== "connected" || !tab || tab.kind !== "table") return;
    // Not before the tabs are checked against this connection's catalog (above).
    if (boundKey === null || boundTo.current !== boundKey) return;
    const run = runs[tab.id];
    if (run?.result || run?.error || run?.startedAt != null || autoBrowsed.current.has(tab.id)) return;
    autoBrowsed.current.add(tab.id);
    void runTable(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connState, activeTabId, tabs, runs, boundKey]);

  const patchTab = (id: number, patch: Partial<QueryTab>) =>
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /**
   * The one way to open a table. Goes to the table's own tab; else retargets
   * the preview tab (a sidebar click); else opens a new tab. `keep` (⌘-click,
   * double-click, ⌘K) makes the tab a normal one. Never touches a query tab.
   */
  const openTable = (
    table: SidebarTable,
    o: {
      keep?: boolean;
      view?: ResultsView;
      /** A history entry's filter, sort and page size to show it with. */
      state?: { filter: string; chips?: FilterChip[]; sort: SortState[]; pageSize?: number };
      /** Record the step in history (not when history itself moves). */
      history?: boolean;
    } = {},
  ) => {
    if (!activeConnection) return;
    mark("browse-click", { window: windowId, table: table.key });
    // Keeping a table in its own tab is what the Preview tip teaches.
    if (o.keep) retireTip("preview-reused");
    const now = entryOf(tabsRef.current.find((t) => t.id === activeTabId));
    const record = (tab: QueryTab) => {
      const entry = entryOf(tab);
      if (entry && o.history !== false) setNavHistory((h) => pushHistory(h, entry, now));
    };
    const list = tabsRef.current;
    const existing = list.find((t) => t.kind === "table" && t.tableKey === table.key);
    if (existing) {
      setActiveTabId(existing.id);
      const patch: Partial<QueryTab> = {};
      if (o.view) patch.view = o.view;
      if (o.keep) patch.preview = false;
      const st = o.state;
      const changed =
        !!st &&
        (st.filter !== (existing.filter ?? "") ||
          JSON.stringify(st.sort) !== JSON.stringify(existing.sort ?? []) ||
          st.pageSize !== existing.pageSize);
      if (st && changed)
        Object.assign(patch, {
          filter: st.filter,
          chips: st.chips ?? chipsFromFilter(st.filter),
          sort: st.sort,
          pageSize: st.pageSize,
        });
      if (Object.keys(patch).length) patchTab(existing.id, patch);
      const next = { ...existing, ...patch };
      record(next);
      if (changed) void runTable(next);
      return;
    }
    const fields: QueryTab = {
      id: 0,
      kind: "table",
      title: table.name,
      sql: "",
      tableKey: table.key,
      schema: table.schema,
      table: table.name,
      filter: o.state?.filter ?? "",
      chips: o.state?.chips ?? chipsFromFilter(o.state?.filter),
      sort: o.state?.sort ?? [],
      pageSize: o.state?.pageSize,
      view: o.view ?? "data",
      preview: !o.keep,
    };
    // A preview tab still loading is kept instead: it can't be retargeted mid-run.
    const previews = list.filter((t) => t.kind === "table" && t.preview);
    const busyPreviews = new Set(
      previews.filter((t) => runsRef.current[t.id]?.startedAt != null).map((t) => t.id),
    );
    const preview = o.keep ? undefined : previews.find((t) => !busyPreviews.has(t.id));
    let tab: QueryTab;
    if (preview) {
      tab = { ...fields, id: preview.id };
      setTabs((prev) => prev.map((t) => (t.id === preview.id ? tab : t)));
      // The last table's SQL and rows aren't this one's: the line and Edit SQL wait for the new page.
      setLineSql(({ [preview.id]: _old, ...rest }) => rest);
      delete shownKey.current[preview.id];
      // A panel click retargeting it (history moving it doesn't count).
      if (o.history !== false) noteTrigger("preview-reused");
    } else {
      tab = { ...fields, id: nextTabId.current++ };
      const insert = (prev: QueryTab[]) => {
        const at = prev.findIndex((t) => t.id === activeTabId);
        const rest = prev.map((t) => (busyPreviews.has(t.id) ? { ...t, preview: false } : t));
        return at < 0 ? [...rest, tab] : [...rest.slice(0, at + 1), tab, ...rest.slice(at + 1)];
      };
      setTabs(insert);
      tabsRef.current = insert(tabsRef.current);
    }
    setActiveTabId(tab.id);
    record(tab);
    void runTable(tab);
  };

  /** ‹ (-1), › (+1) or a jump through this window's history. */
  const goHistoryBy = (delta: number) => {
    const now = entryOf(tabsRef.current.find((t) => t.id === activeTabId));
    const next = goHistory(navRef.current, delta, now);
    if (!next) return;
    const entry = next.entries[next.index];
    const table = findTable(schemaTree, entry.tableKey);
    if (!table) return;
    setNavHistory(next);
    openTable(table, {
      view: entry.view,
      state: { filter: entry.filter, chips: entry.chips, sort: entry.sort, pageSize: entry.pageSize },
      history: false,
    });
  };
  const goHistoryRef = useRef(goHistoryBy);
  goHistoryRef.current = goHistoryBy;
  const [historyListAt, setHistoryListAt] = useState<{ x: number; y: number } | null>(null);
  const histBack = navHistory.entries[navHistory.index - 1];
  const histForward = navHistory.entries[navHistory.index + 1];
  const backKey = commandKeys("history-back", macOverlay);
  const forwardKey = commandKeys("history-forward", macOverlay);

  /**
   * Follows a key: `target`'s rows whose column holds `value`, in the Preview
   * tab (a step in history) or, `own`, a tab of their own (no step). Quick
   * Look opens on the rows once they land.
   */
  followToRef.current = (target, value, own) => {
    const db = resultTableItem?.database;
    const t = db ? findTable(schemaTree, tableKey(db, target.schema, target.table)) : undefined;
    if (!t || sqlLiteral(value) === null) return;
    const v = value as Record<string, unknown>;
    const chip: FilterChip = {
      kind: "pred",
      column: target.column,
      type: t.table.columns?.find((c) => c.name === target.column)?.type_name ?? "",
      op: "=",
      value: "Text" in v ? String(v.Text) : "BigInt" in v ? String(v.BigInt) : safeFormatCell(value),
    };
    lookOnLand.current = { tableKey: t.key, stale: result ?? null };
    openTable(t, {
      keep: own,
      history: own ? false : undefined,
      state: { filter: chipsToWhere([chip], chipEngine), chips: [chip], sort: [] },
    });
    if (own) showToast(`Opened ${t.name} in a new tab`);
  };

  const openTableByKey = (key: string) => {
    const item = findTable(schemaTree, key);
    if (item) openTable(item);
  };

  // ---- Filter chips -----------------------------------------------------

  /** The chip editor (⌘F, a chip click, typing on a cell): one at a time. */
  const [chipDraft, setChipDraft] = useState<ChipDraft | null>(null);
  const chipEngine = activeConnection ? engineForConnection(activeConnection) : "postgres";
  /** The table's columns as the catalog has them (the result's until it has them). */
  const chipColumns = useMemo(
    () =>
      (isTableTab && activeTable?.table.columns?.length
        ? activeTable.table.columns
        : (result?.columns ?? [])
      ).map((c) => ({ name: c.name, type_name: c.type_name })),
    [isTableTab, activeTable, result?.columns],
  );
  const chipType = (column: string | null) => chipColumns.find((c) => c.name === column)?.type_name ?? "";
  const activeChipSql = useMemo(() => {
    const chips = activeTab?.chips ?? [];
    return chipFragments(chips, chipEngine).map((sql, i) => ({ sql, kind: chips[i].kind, words: chipWords(chips[i]) }));
  }, [activeTab?.chips, chipEngine]);
  // Under the SQL line: a tip (Tips.ts), or the answer to a key typed before type-to-filter unlocks.
  const lineTip = useTip("sql-line");
  const [lockedHint, setLockedHint] = useState(false);
  const lockedTimer = useRef<number | undefined>(undefined);
  const showLockedHint = () => {
    setLockedHint(true);
    window.clearTimeout(lockedTimer.current);
    lockedTimer.current = window.setTimeout(() => setLockedHint(false), 4000);
  };

  /** New chips: `filter` follows them, the page reruns, and the first one unlocks type-to-filter. */
  const setChips = (tab: QueryTab, chips: FilterChip[], explicit = true) => {
    const filter = chipsToWhere(chips, chipEngine);
    patchTab(tab.id, { chips, filter, preview: false });
    // The WHERE (its chips) washes once the new page lands; removing the last chip has nothing to wash.
    if (chips.length > 0) pendingWash.current[tab.id] = "where";
    void runTable({ ...tab, chips, filter, preview: false });
    if (explicit && chips.length > 0) {
      if (readKey(TYPE_TO_FILTER_KEY) !== true) {
        writeKey(TYPE_TO_FILTER_KEY, true);
        setLockedHint(false);
      }
      // Earned by the first chip; a later one shows it when that day already had a tip.
      noteTrigger("type-to-filter");
    }
  };
  const addChip = (chip: FilterChip) => {
    if (!activeTab || activeTab.kind !== "table") return;
    setChipDraft(null);
    setChips(activeTab, [...(activeTab.chips ?? []), chip]);
  };

  /** Opens the chip editor: for chip `index`, else a new chip on `column` (null: any text column). */
  const openChipEditor = (o: { index?: number; column?: string | null; value?: string } = {}) => {
    if (!activeTab || activeTab.kind !== "table") return;
    const anyText = textColumns(chipColumns).length > 0;
    const fallback = anyText ? null : (chipColumns[0]?.name ?? null);
    const chip = o.index !== undefined ? activeTab.chips?.[o.index] : undefined;
    let draft: Omit<ChipDraft, "tabId" | "index">;
    if (chip?.kind === "pred") {
      const value = chip.op === "BETWEEN" ? `${chip.value} AND ${chip.value2 ?? ""}` : chip.value;
      draft = { column: chip.column, op: chip.op, value };
    } else if (chip?.kind === "any") {
      draft = { column: null, op: "ILIKE", value: chip.value };
    } else if (chip?.kind === "expr") {
      draft = { column: fallback, op: fallback === null ? "ILIKE" : defaultOp(chipType(fallback)), value: chip.sql };
    } else {
      const column = o.column !== undefined && (o.column !== null || anyText) ? o.column : fallback;
      draft = { column, op: column === null ? "ILIKE" : defaultOp(chipType(column)), value: o.value ?? "" };
    }
    setChipDraft({ ...draft, tabId: activeTab.id, index: chip && o.index !== undefined ? o.index : null });
    // A new editor focuses its value as it mounts (ChipEditor); this is for one
    // that was already open. Not once the value has focus: the user may have
    // typed since, and moving the caret back would split what they typed.
    requestAnimationFrame(() => {
      if (!document.activeElement?.closest("[data-chip-editor]")) sqlEditorRef.current?.jumpTo(draft.value.length);
    });
  };

  /** ↵ in the chip editor: a fragment is a chip, other SQL an expression chip, else a value for the column. */
  const applyChipDraft = () => {
    const d = chipDraft;
    if (!d || !activeTab || activeTab.id !== d.tabId) return;
    // `balance > 500` on a table with `balance_cents`: say so before the
    // server does, and ↵ again takes the column it meant.
    const nullTest = d.column !== null && (d.op === "IS NULL" || d.op === "IS NOT NULL");
    const unknown = nullTest ? null : unknownColumn(d.value, chipColumns);
    if (unknown) {
      const fixed = renameFragmentColumn(d.value, unknown.name, unknown.suggestion);
      showOfferToast(`No column ${unknown.name}`, `Use ${unknown.suggestion}`, undefined, {
        run: () => commitChipDraft({ ...d, value: fixed }),
        tone: "error",
      });
      return;
    }
    commitChipDraft(d);
  };

  const commitChipDraft = (d: NonNullable<typeof chipDraft>) => {
    if (!activeTab || activeTab.id !== d.tabId) return;
    const text = d.value.trim();
    let chip: FilterChip | null = null;
    if (d.column !== null && (d.op === "IS NULL" || d.op === "IS NOT NULL")) {
      chip = { kind: "pred", column: d.column, type: chipType(d.column), op: d.op, value: "" };
    } else if (text) {
      chip = parseFragment(text, chipColumns);
      if (!chip && d.column === null) {
        const cols = textColumns(chipColumns);
        chip = cols.length ? { kind: "any", columns: cols, value: text } : { kind: "expr", sql: text };
      } else if (!chip && d.column !== null) {
        const [a, b] = d.op === "BETWEEN" ? text.split(/\s+and\s+|\s*,\s*/i) : [text];
        chip = { kind: "pred", column: d.column, type: chipType(d.column), op: d.op, value: a ?? "", value2: b };
      }
    }
    if (chip && !chipComplete(chip)) return;
    const chips = [...(activeTab.chips ?? [])];
    if (d.index !== null) {
      if (chip) chips[d.index] = chip;
      else chips.splice(d.index, 1);
    } else if (chip) chips.push(chip);
    setChipDraft(null);
    if (chip || d.index !== null) setChips(activeTab, chips);
  };

  /** Esc in the chip editor: the draft goes, the chips stay. */
  const escapeChipDraft = (): boolean => {
    setChipDraft(null);
    (document.activeElement as HTMLElement | null)?.blur();
    return true;
  };

  const removeChip = (index: number) => {
    if (!activeTab || activeTab.kind !== "table") return;
    const chips = (activeTab.chips ?? []).filter((_, i) => i !== index);
    if (chipDraft?.index === index) setChipDraft(null);
    setChips(activeTab, chips, false);
  };

  /** A printable key on a selected cell: the chip editor for that column, once unlocked. */
  const typeToFilter = (column: string, key: string) => {
    if (readKey(TYPE_TO_FILTER_KEY) !== true) {
      showLockedHint();
      return;
    }
    retireTip("type-to-filter");
    openChipEditor({ column: chipColumns.some((c) => c.name === column) ? column : null, value: key });
  };

  /** ⌘F on a query tab: find in the loaded rows (client-side; nothing reruns). */
  const [find, setFind] = useState<{ tabId: number; query: string; index: number } | null>(null);
  const [findCount, setFindCount] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const openFind = () => {
    if (!activeTab || activeTab.kind !== "query") return;
    setFind((f) => (f?.tabId === activeTab.id ? f : { tabId: activeTab.id, query: "", index: 0 }));
    requestAnimationFrame(() => findRef.current?.select());
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  const findShown = !!find && find.tabId === activeTabId;
  const findAt = find && findCount ? ((find.index % findCount) + findCount) % findCount : 0;

  /** The grid's cell menu, profile segments and histogram drags add chips. */
  const gridFilter = (column: string, op: ChipDraft["op"], value = "", value2?: string) =>
    addChip({ kind: "pred", column, type: chipType(column), op, value, value2 });

  /**
   * Query tabs sort the rows they loaded on the client (nothing reruns); a
   * new run of the tab drops it.
   */
  const [clientSorts, setClientSorts] = useState<Record<number, { runNo: number; keys: SortKey[] }>>({});
  const clientSortEntry = clientSorts[activeTabId];
  const activeClientSort =
    !isTableTab && clientSortEntry && clientSortEntry.runNo === (activeRun.runNo ?? 0) ? clientSortEntry.keys : null;
  const shownResult = useMemo(
    () => (result && activeClientSort?.length && !result.error ? sortResult(result, activeClientSort) : result),
    [result, activeClientSort],
  );

  /** Applies new sort keys: a table tab reruns its first page, a query tab re-sorts its rows. */
  const applySort = (sort: SortState[]) => {
    if (!activeTab) return;
    if (activeTab.kind === "query") {
      setClientSorts((prev) => ({ ...prev, [activeTab.id]: { runNo: activeRun.runNo ?? 0, keys: sort } }));
      return;
    }
    patchTab(activeTab.id, { sort, preview: false });
    pendingWash.current[activeTab.id] = "order";
    void runTable({ ...activeTab, sort, preview: false });
  };
  const currentSort = (): SortState[] => (isTableTab ? (activeTab?.sort ?? []) : (activeClientSort ?? []));

  /** Header click: ascending, then descending, then unsorted; ⇧-click adds a secondary key. */
  const sortBy = (column: string, secondary = false) => applySort(cycleSort(currentSort(), column, secondary));
  /** Header menu: Sort ascending / descending / Clear sort on one column. */
  const sortColumn = (column: string, desc: boolean | null) =>
    applySort(setSortDirection(currentSort(), column, desc));

  /** Rewrites a table tab's SELECT list without some columns and reruns it. */
  const setHidden = (tab: QueryTab, hidden: string[]) => {
    const next = { ...tab, hidden, preview: false };
    patchTab(tab.id, { hidden, preview: false });
    pendingWash.current[tab.id] = "select";
    void runTable(next);
  };

  /** Header menu: Hide column. The grip left in the header (or Undo) shows it again. */
  const hideColumn = (column: string) => {
    const tab = activeTab;
    const tableKey = tab?.tableKey;
    if (!tab || tab.kind !== "table" || !tableKey) return;
    const before = tab.hidden ?? [];
    if (before.includes(column)) return;
    // Without catalog columns, the columns shown now are the table's.
    if (!findTable(schemaTree, tableKey)?.table.columns?.length && before.length === 0 && result)
      fullColumns.current[tableKey] = result.columns.map((c) => c.name);
    const shown = visibleColumns(tableColumnsOf(tab), [...before, column]);
    if (shown.length === 0) {
      flash("A table tab shows at least one column");
      return;
    }
    setHidden(tab, [...before, column]);
    showUndoToast(`Hid ${column}`, undefined, {
      undo: () => {
        const cur = tabsRef.current.find((t) => t.id === tab.id);
        if (cur) setHidden(cur, (cur.hidden ?? []).filter((c) => c !== column));
      },
    });
  };

  /** A hidden-column grip's menu: one column back, or all of them ("*"). */
  const showColumn = (column: string) => {
    if (!activeTab || activeTab.kind !== "table") return;
    setHidden(activeTab, column === "*" ? [] : (activeTab.hidden ?? []).filter((c) => c !== column));
  };

  /** Where hidden columns were, for the grips in the grid header. */
  const activeGrips = useMemo(
    () =>
      isTableTab && activeTab?.hidden?.length ? hiddenGrips(tableColumnsOf(activeTab), activeTab.hidden) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTableTab, activeTab?.hidden, activeTab?.tableKey, schemaTree],
  );

  /** Cell menu on a query result that reads one table: that table, in a table tab with no filter. */
  const openResultAsTable = () => {
    if (!resultTableKey) return;
    const table = findTable(schemaTree, resultTableKey);
    if (table) openTable(table, { keep: true, state: { filter: "", sort: [] } });
  };

  const loadMore = () => {
    if (activeTab?.kind !== "table") return;
    if (activeTab.preview) patchTab(activeTab.id, { preview: false });
    void runTable({ ...activeTab, preview: false }, true);
  };
  /** The grid scrolled to its last rows: the next page, when there is one. */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const onNearEnd = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    const run = tab && runsRef.current[tab.id];
    if (tab && run?.hasMore && run.startedAt == null) loadMoreRef.current();
  }, [activeTabId]);

  /** Page size menu: reloads the tab's first page at the new size. */
  const setPageSize = (pageSize: number) => {
    if (activeTab?.kind !== "table") return;
    const next = { ...activeTab, pageSize, preview: false };
    patchTab(next.id, { pageSize, preview: false });
    pendingWash.current[next.id] = "limit";
    void runTable(next);
  };

  /** ⌘E: the SQL this table tab shows, in a new query tab (not run). */
  const openInQueryTab = async () => {
    if (!activeConnection || !activeTab || activeTab.kind !== "table" || !activeTab.table) return;
    try {
      // Exactly the SQL line; before the first page ran, core builds it.
      const ran = lineSql[activeTab.id];
      // What ran, only if it ran for the tab exactly as it is now (not a
      // retargeted Preview tab's last table, nor a sort still loading).
      const sql = ran && ran.key === runKey(activeTab) ? ran.sql : await browseTableSql(
        engineForConnection(activeConnection),
        activeTab.schema ?? "",
        activeTab.table,
        { ...browseOptions(activeTab, false), filter: activeTab.filter },
      );
      patchTab(activeTab.id, { preview: false });
      openSqlInTab(sql, activeTab.table, activeTab.id);
      requestAnimationFrame(() => requestAnimationFrame(() => sqlEditorRef.current?.focus()));
    } catch (e) {
      flash(String(e));
    }
  };
  // ⌘K MCP activity's Open in tab: the agent's SQL in a new tab here, not run.
  const openSqlInTabRef = useRef(openSqlInTab);
  openSqlInTabRef.current = openSqlInTab;
  useEffect(() => {
    const onOpenSql = (e: Event) => {
      const d = (e as CustomEvent<{ windowId: string; sql: string; title?: string }>).detail;
      if (d?.windowId !== windowId) return;
      openSqlInTabRef.current(d.sql, d.title, tabsRef.current[tabsRef.current.length - 1]?.id);
      requestAnimationFrame(() => requestAnimationFrame(() => sqlEditorRef.current?.focus()));
    };
    window.addEventListener("rowkery:open-sql", onOpenSql);
    return () => window.removeEventListener("rowkery:open-sql", onOpenSql);
  }, [windowId]);
  const openInQueryTabRef = useRef(openInQueryTab);
  openInQueryTabRef.current = openInQueryTab;

  // The SQL line: the first page's SQL as core ran it (browse_table returns
  // it, so no extra call), the WHERE editor while ⌘F is open, the exact
  // count once asked, and what a selected block adds up to.
  const [exactCounts, setExactCounts] = useState<Record<number, { key: string; value: number | null; counting: boolean }>>({});
  const [selStats, setSelStats] = useState<SelectionStats | null>(null);
  useEffect(() => setSelStats(null), [activeTabId]);
  const lineKey = (t: QueryTab) =>
    JSON.stringify([t.schema, t.table, t.filter ?? "", t.sort ?? [], t.pageSize ?? DEFAULT_PAGE]);
  const activeLineKey = isTableTab && activeTab ? lineKey(activeTab) : null;

  /** # or a click on ≈: count every row the WHERE matches, on its own session. */
  const countExact = async () => {
    if (!activeConnection || !activeTab || activeTab.kind !== "table" || !activeTab.table) return;
    const tab = activeTab;
    const key = lineKey(tab);
    setExactCounts((prev) => ({ ...prev, [tab.id]: { key, value: null, counting: true } }));
    try {
      const value = await countRows(
        windowId,
        engineForConnection(activeConnection),
        tab.schema ?? "",
        tab.table!,
        tab.filter?.trim() ? tab.filter : null,
      );
      setExactCounts((prev) => ({ ...prev, [tab.id]: { key, value, counting: false } }));
    } catch (e) {
      setExactCounts((prev) => ({ ...prev, [tab.id]: { key, value: null, counting: false } }));
      flash(String(e));
    }
  };
  const countExactRef = useRef(countExact);
  countExactRef.current = countExact;
  const activeExact = activeTab && exactCounts[activeTab.id]?.key === activeLineKey ? exactCounts[activeTab.id] : null;

  const focusTableFilter = () => openChipEditor();
  /** ↻ in the SQL line or ⇧⌘R: the table tab's first page again, as it is now. */
  const refreshRows = () => {
    if (!activeTab || activeTab.kind !== "table" || runStartedAt !== null) return;
    // The rows may have changed: an exact count from before no longer holds.
    setExactCounts((prev) => {
      const { [activeTab.id]: _gone, ...rest } = prev;
      return rest;
    });
    void runTable({ ...activeTab });
  };

  const refreshRowsRef = useRef(refreshRows);
  refreshRowsRef.current = refreshRows;

  const focusTableFilterRef = useRef(focusTableFilter);
  focusTableFilterRef.current = focusTableFilter;
  const isTableTabRef = useRef(isTableTab);
  isTableTabRef.current = isTableTab;

  // A table tab that has nothing to show (new connection wiped its runs, or
  // it was never shown) loads when it becomes the active tab.
  const activeHasRun = busy || !!activeRun.result || !!activeRun.error;
  useEffect(() => {
    if (!active || connState !== "connected" || !isTableTab || activeHasRun) return;
    // Not before the tabs are checked against this connection's catalog, nor a tab that check closed.
    if (boundKey === null || boundTo.current !== boundKey || !tabsRef.current.some((t) => t.id === activeTabId)) return;
    void runTable(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connState, activeTabId, isTableTab, activeHasRun, boundKey]);

  useSlidingThumb(viewTrackRef, viewThumbRef, [resultsView, !!activeTable]);
  const queryThumbRef = useRef<HTMLSpanElement>(null);
  useSlidingThumb(queryTabsRef, queryThumbRef, [activeTabId, tabs.map((t) => t.id).join(" ")]);
  // The tab row folds by need, whatever took the room (an inspector, a
  // narrow window): Data | Structure drops its words (2), tabs may shrink
  // (3). The fold is the least that lets every tab show whole; App.css
  // styles `.app-frame[data-fold]`.
  const headerRef = useRef<HTMLDivElement>(null);
  const switchWidths = useRef({ words: 190, icons: 72 });
  // Which tabs there are and their titles, not their SQL: measuring forces a
  // layout, and on every keystroke that laid out a 5,000-line editor inside
  // the key's own commit. A tab that changes width (status, time) is the
  // ResizeObserver's.
  const tabTitles = tabs.map((t) => `${t.id}\u0000${t.title}`).join("\u0001");
  useLayoutEffect(() => {
    const header = headerRef.current;
    const row = queryTabsRef.current;
    const frame = header?.closest<HTMLElement>(".app-frame");
    if (!active || !header || !row || !frame) return;
    // The header's right padding. ⌘K moved to the title bar (2026-10-13), so
    // folds 1 and 2 differ only by Data | Structure's words.
    const PAD = [16, 16, 16, 16];
    const measure = () => {
      const fold = Number(frame.dataset.fold ?? 0);
      let need = 0;
      for (const tab of row.querySelectorAll<HTMLElement>('[data-testid="query-tab"]')) {
        const title = tab.querySelector<HTMLElement>('[data-testid="query-tab-title"]');
        // The tab as wide as it would be unshrunk (a title ellipsises past 160 px).
        need += tab.offsetWidth - (title?.clientWidth ?? 0) + Math.min(title?.scrollWidth ?? 0, 160) + 2;
      }
      need += row.querySelector<HTMLElement>('[data-testid="query-tab-add"]')?.offsetWidth ?? 0;
      const sw = header.querySelector<HTMLElement>(':scope > [data-testid="view-switch"]');
      if (sw) switchWidths.current[fold >= 2 ? "icons" : "words"] = sw.offsetWidth;
      let others = 16;
      for (const el of header.children) {
        if (el === row || el === sw || !(el instanceof HTMLElement) || getComputedStyle(el).position === "absolute") continue;
        others += el.offsetWidth + 4;
      }
      const room = (f: number) =>
        header.clientWidth - PAD[f] - others -
        (sw ? (f >= 2 ? switchWidths.current.icons : switchWidths.current.words) + 4 : 0);
      const next = [0, 1, 2].find((f) => need <= room(f)) ?? 3;
      if (next) frame.dataset.fold = String(next);
      else delete frame.dataset.fold;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    row.querySelectorAll('[data-testid="query-tab"]').forEach((t) => ro.observe(t));
    return () => ro.disconnect();
  }, [active, tabTitles, activeTabId, isTableTab, sidebarHidden]);

  // A narrow tab row scrolls: the shown tab is always in view, never under the switch.
  useEffect(() => {
    const row = queryTabsRef.current;
    const tab = row?.querySelector<HTMLElement>('[data-testid="query-tab"][data-on]');
    if (!row || !tab) return;
    const l = tab.offsetLeft;
    const r = l + tab.offsetWidth;
    const reveal = () => {
      // While the shown tab fits from the start, the first tab stays in view.
      if (r <= row.clientWidth) row.scrollLeft = 0;
      else if (l < row.scrollLeft) row.scrollLeft = l;
      else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth;
    };
    reveal();
    // The window narrowing can push it out too.
    const ro = new ResizeObserver(reveal);
    ro.observe(row);
    return () => ro.disconnect();
  }, [activeTabId, tabs.length]);

  // While the shown tab runs: the time and Cancel (Force stop). In the
  // results header on a query tab, at the SQL line's end on a table tab.
  // ⌘E's plan shows in place of the results on a query tab.
  const shownPlan = !isTableTab && resultsView !== "structure" ? (activeRun.plan ?? null) : null;
  // A plan stands in for the results, so the statements they came from go too.
  const statementList =
    !isTableTab && !shownPlan && (activeRun.statements?.length ?? 0) > 1
      ? (keepShownStatement(activeRun).statements ?? activeRun.statements!)
      : null;
  const runningMeta = (
              <span data-testid="card-meta" className="card-meta running" data-state="running">
                <span className="spinner" aria-hidden />
                {activeRun.exporting ? (
                  <span data-exporting={activeRun.exporting.rows}>
                    {cancelling ? "Cancelling" : activeRun.exporting.verb} ·{" "}
                    {activeRun.exporting.rows.toLocaleString()} rows
                  </span>
                ) : activeRun.waiting && !cancelling ? (
                  // Every connection is busy: say so, rather than look stuck.
                  <span data-waiting="connection">
                    Waiting for a free connection ·{" "}
                    {runStartedAt !== null && <Elapsed since={runStartedAt} active={active} format={formatMs} />}
                  </span>
                ) : (
                  <>
                    {cancelling ? "Cancelling" : "Running"} ·{" "}
                    {activeRun.streaming && result && <RowsSoFar rows={result.rows} />}
                    {runStartedAt !== null && <Elapsed since={runStartedAt} active={active} format={formatMs} />}
                  </>
                )}
                <button
                  type="button"
                  className="cancel-btn"
                  data-cancel={cancelling ? "force" : "cancel"}
                  title={cancelling ? "Stop it now, without waiting for the server" : undefined}
                  onClick={() => void onCancel()}
                >
                  {cancelling ? "Force stop" : "Cancel"} <span className="cancel-key">esc</span>
                </button>
              </span>
  );

  // Tips under the tab row and under the Data | Structure thumb (Tips.ts).
  const rowTip = useTip("tab-row");
  const viewTip = useTip("view-switch");
  const viewSwitch = activeTable && (
    <div
      data-testid="view-switch"
      className="view-switch"
      role="tablist"
      aria-label="Results view"
      ref={viewTrackRef}
    >
      <span className="view-switch-thumb" ref={viewThumbRef} aria-hidden />
      {viewTip && (
        <span className="tip-line tip-view" data-tip={viewTip.id} role="status">
          {viewTip.text}
        </span>
      )}
      {(["data", "structure"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={resultsView === v}
          aria-label={v === "data" ? "Data" : "Structure"}
          data-on={resultsView === v ? "" : undefined}
          data-view={v}
          title={
            v === "data"
              ? commandTip("show-data", "Show the rows", macOverlay)
              : commandTip("show-structure", "Show columns, indexes and keys", macOverlay)
          }
          onClick={() => {
            setActiveView(v);
            noteTrigger("view-keys");
          }}
        >
          {v === "data" ? <GridIcon size={13} /> : <BlocksIcon size={13} />}
          <span className="view-switch-label">{v === "data" ? "Data" : "Structure"}</span>
        </button>
      ))}
    </div>
  );

  const connected = connState === "connected";
  const sessions = useSessions(
    windowId,
    active && isSessionsTab && connected && activeConnection?.kind === "postgres",
  );
  const tabLabels = useMemo(() => tabs.map((t) => ({ id: t.id, title: t.title })), [tabs]);
  const running = runStartedAt !== null;
  // No tip while the shown tab runs; one earned meanwhile waits for the rows.
  useEffect(() => {
    if (active) setQueryRunning(running);
  }, [active, running]);
  const filterKeys = commandKeys("filter-rows", macOverlay);
  const hasRows = !!result && result.columns.length > 0;

  const stripRetired = useStripState().retired.length > 0;
  const tipsOff = useTipsHidden();
  const themeSetting = useTheme().setting;
  const scopeNow = useSyncExternalStore(subscribeCloseScope, closeScope);
  const commandState = useMemo(
    (): CommandState => ({
      connected,
      busy,
      running,
      tableTab: isTableTab,
      sessionsTab: isSessionsTab,
      tabCount: tabs.length,
      hasSchema: !!schema,
      sidebarHidden,
      hasConnectionId: !!activeId,
      connection: activeConnection
        ? {
            postgres: activeConnection.kind === "postgres",
            environment: activeConnection.environment ?? null,
            safeMode: activeConnection.safe_mode ?? "off",
            allowMcp: mcpShared(activeConnection),
          }
        : null,
      windowCount,
      hasResult: !!result,
      hasRows,
      hasActiveTable: isTableTab && !!activeTable,
      resultsView,
      failed: connState === "error",
      loadedRows: result?.row_count ?? 0,
      moreRows: !!activeRun.hasMore,
      closedTabs: closedCount,
      historyBack: navHistory.index > 0,
      historyForward: navHistory.index < navHistory.entries.length - 1,
      hasSample: connections.some((c) => c.kind === "sqlite" && !!c.sample),
      hintsRetired: stripRetired,
      tipsHidden: tipsOff,
      theme: themeSetting,
      presenting,
      cellFollowable: !!keyCell && isTableTab && resultsView === "data",
      rowsEditable: rowEdits.rowsEditable,
      cellEditable: rowEdits.cellEditable,
      cellNullable: rowEdits.cellNullable,
      rowsSelected: rowEdits.rowsSelected,
      pendingEdits: rowEdits.count,
      writeHeld: !!activeRun.held || !!heldEdit || !!review,
      connectionForm: !!connectionForm,
      closeScope: scopeNow,
    }),
    [
      connectionForm,
      scopeNow,
      stripRetired,
      tipsOff,
      themeSetting,
      presenting,
      connected,
      busy,
      running,
      isTableTab,
      isSessionsTab,
      tabs.length,
      schema,
      sidebarHidden,
      activeId,
      activeConnection,
      windowCount,
      result,
      hasRows,
      activeTable,
      resultsView,
      activeRun.hasMore,
      closedCount,
      navHistory,
      connState,
      connections,
      keyCell,
      rowEdits.rowsEditable,
      rowEdits.cellEditable,
      rowEdits.cellNullable,
      rowEdits.rowsSelected,
      rowEdits.count,
      activeRun.held,
      heldEdit,
      review,
    ],
  );

  // The menu bar follows the shown window: disabled, not hidden (macOS),
  // with the keymap's accelerators. keyTracker reads the same state.
  const keymap = useKeymap();
  useEffect(() => {
    if (!active) return;
    syncMenu(commandState);
    setShownState(commandState);
  }, [active, commandState, keymap]);

  /** ⌘K Timings: the measured marks against their budgets. */
  const [timingsOpen, setTimingsOpen] = useState(false);
  /** ⌘K picks per command (config.json): the most used lead the list. */
  const [uses, setUses] = useState(commandUses);
  // Only commands that can run right now are listed (commands.ts), with
  // the keymap's keycaps.
  const commandItems = useMemo(
    () =>
      availableCommands(commandState, macOverlay).map((c) =>
        item(
          "commands",
          `cmd:${c.id}`,
          c.title,
          { kind: "command", id: c.id },
          { keys: c.keys, syn: c.synonyms?.map((w) => w.toLowerCase()), uses: uses[c.id] },
        ),
      ),
    [commandState, macOverlay, uses, keymap],
  );

  const connectionItems = useMemo(
    () =>
      connections.map((c) =>
        item(
          "connections",
          `conn:${c.id}`,
          c.name,
          { kind: "connection", id: c.id },
          {
            detail: c.environment
              ? `${c.environment} · ${connectionLine(c, presenting)}`
              : connectionLine(c, presenting),
            meta: c.id === activeId && connected ? "Connected" : undefined,
          },
        ),
      ),
    [connections, activeId, connected, presenting],
  );

  const historyItems = useMemo(() => {
    const now = Date.now();
    return history.map((h) =>
      item(
        "queries",
        `q:${h.at}:${h.sql.length}`,
        queryLabel(h.sql),
        { kind: "query", sql: h.sql },
        {
          meta: timeAgo(h.at, now),
        },
      ),
    );
  }, [history]);

  const paletteGroups = useMemo(
    (): Record<PaletteGroup, PaletteItem[]> => ({
      tables: paletteOpen ? tableIndex.get() : [],
      queries: historyItems,
      connections: connectionItems,
      commands: commandItems,
    }),
    [paletteOpen, tableIndex, historyItems, connectionItems, commandItems],
  );

  const copyResults = async (format: "csv" | "tsv") => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(resultsToText(result, format));
      const n = result.row_count;
      showToast(`Copied ${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`, format.toUpperCase());
    } catch (e) {
      showToast("Couldn't copy", String(e), "error");
    }
  };

  /**
   * The SQL that gives this tab's whole result: a table tab's browse without
   * its page limit, or the statement a query tab last ran.
   */
  const wholeResultSql = async (tab: QueryTab): Promise<string | null> => {
    if (tab.kind === "table") {
      if (!activeConnection || !tab.table) return null;
      return browseTableSql(engineForConnection(activeConnection), tab.schema ?? "", tab.table, {
        ...browseOptions(tab, false),
        limit: 0,
      });
    }
    return runsRef.current[tab.id]?.ranSql ?? null;
  };

  /**
   * Export… (⇧⌘E) and Copy all: core streams the whole result (not just the
   * loaded rows) to a file or the clipboard; the tab shows the count with
   * Cancel meanwhile.
   */
  const exportWhole = async (kind: "file" | "csv" | "tsv") => {
    const tab = activeTab;
    if (!tab || !activeConnection || runsRef.current[tab.id]?.startedAt != null) return;
    const sql = await wholeResultSql(tab);
    if (!sql) return;
    const tabId = tab.id;
    const verb = kind === "file" ? "Exporting" : "Copying";
    const progress = (rows: number) => patchRun(tabId, { exporting: { verb, rows } });
    const start = () =>
      patchRun(tabId, { startedAt: Date.now(), cancelling: false, exporting: { verb, rows: 0 } });
    try {
      let done;
      if (kind === "file") {
        // INSERTs go into the table the result reads, else "results".
        const read = resultTableKey ? findTable(schemaTree, resultTableKey) : undefined;
        const req = {
          sql,
          engine: engineForConnection(activeConnection),
          schema: (tab.kind === "table" ? tab.schema : read?.schema) ?? "",
          table: (tab.kind === "table" ? tab.table : read?.name) ?? "results",
        };
        // The dialog comes first: the tab shows as busy once rows are written.
        let shown = false;
        done = await exportResults(windowId, tabId, req, (rows) => {
          if (!shown) start();
          shown = true;
          progress(rows);
        });
        if (done === null) return;
      } else {
        start();
        done = await copyAllResults(windowId, tabId, sql, kind, progress);
      }
      if (done.cancelled) showToast(kind === "file" ? "Export cancelled" : "Copy cancelled");
      else if (done.error) showToast(kind === "file" ? "Couldn't export" : "Couldn't copy", done.error, "error");
      else if (kind === "file")
        showToast(`Exported ${done.rows.toLocaleString()} ${done.rows === 1 ? "row" : "rows"}`, done.path?.split(/[\\/]/).pop());
      else showToast(`Copied ${done.rows.toLocaleString()} ${done.rows === 1 ? "row" : "rows"}`, kind.toUpperCase());
    } catch (e) {
      showToast(kind === "file" ? "Couldn't export" : "Couldn't copy", String(e), "error");
    } finally {
      patchRun(tabId, { startedAt: null, cancelling: false, exporting: null });
    }
  };
  const exportWholeRef = useRef(exportWhole);
  exportWholeRef.current = exportWhole;

  const formatEditorSql = async () => {
    const error = await sqlEditorRef.current?.format(activeConnection?.kind === "sqlite" ? "sqlite" : "postgresql");
    if (error) showToast("Couldn't format", error, "error");
  };

  const runCommand = (id: string) => {
    if (id.startsWith("theme:")) return setThemeSetting(id.slice(6) as ThemeSetting);
    if (id === "mcp:on" || id === "mcp:off") return actions.setAllowMcp(id === "mcp:on");
    if (id === "agents") return actions.openMcp("page");
    if (id === "review-proposals") return actions.reviewProposals();
    if (id === "mcp-connect") return actions.openMcp("connect");
    if (id === "mcp-activity") return actions.openMcp("activity");
    if (id === "mcp-access") return actions.openMcp("access");
    if (id === "mcp-edit-access") return actions.openMcp("edit");
    if (id === "change-safe-mode") return openShieldMenu();
    if (id === "reopen-closed-tab") return reopenClosedTab();
    if (id === "retry-connect") return actions.retryConnect();
    if (id === "edit-failed-connection") return editFailed();
    if (id === "open-sample") return actions.openSample(false);
    if (id === "open-sqlite-file") return actions.openSqliteFile();
    if (id === "keyboard-shortcuts") return actions.openShortcuts();
    if (id === "third-party-notices") return actions.openNotices();
    if (id === "check-updates") return actions.checkForUpdates();
    if (id === "settings") return actions.openSettings();
    if (id === "show-key-hints") return showKeyHints();
    if (id === "find-results") return openFind();
    if (id === "reset-sample") return actions.openSample(true);
    if (id === "all-tables") return openAllTables();
    if (id === "timings") return setTimingsOpen(true);
    if (id === "history-back") return goHistoryBy(-1);
    if (id === "history-forward") return goHistoryBy(1);
    if (id === "quick-look") return setQuickLookAsk((n) => n + 1);
    if (id === "window-controls") return void toggleNativeDecorations();
    if (id === "hide-tips") {
      hideTips();
      return showToast("Tips hidden");
    }
    if (id.startsWith("safe:")) {
      return actions.setSafeMode(id.slice(5) as SafeMode);
    }
    if (id.startsWith("env:")) {
      const env = id.slice(4);
      return actions.setEnvironment(env === "none" ? null : (env as ConnectionEnv));
    }
    switch (id) {
      case "refresh":
        return activeTab && void runTable({ ...activeTab });
      case "open-in-query":
        return void openInQueryTab();
      case "filter-rows":
        return focusTableFilter();
      case "refresh-rows":
        return refreshRows();
      case "run":
        return void onRun();
      case "run-all":
        return void runAll();
      case "explain":
      case "explain-timed":
        if (commandById(id)?.canRun(commandState)) void onExplain(id === "explain-timed");
        return;
      case "cancel":
        return void onCancel();
      case "stop-all-queries":
        return void stopAllQueries().catch((e) => flash(String(e)));
      case "new-tab":
        return addTab();
      case "close-tab":
        return closeTab(activeTabId);
      case "next-tab":
        return cycleTab(1);
      case "prev-tab":
        return cycleTab(-1);
      case "focus-editor":
        return sqlEditorRef.current?.focus();
      case "format-sql":
        if (commandById(id)?.canRun(commandState)) void formatEditorSql();
        return;
      case "filter-schema":
        return focusFilter();
      case "toggle-sidebar":
        return actions.toggleSidebar();
      case "presenting":
        return setPresenting(!presentingOn());
      case "show-sessions":
        return showSessions();
      case "new-connection":
        return actions.newConnection();
      case "report-issue":
        return reportIssue();
      case "edit-connection":
        return activeConnection && actions.editConnection(activeConnection.id);
      case "switch-connection":
        return actions.openConnectionSwitcher();
      case "switch-database":
        return actions.openDatabaseSwitcher();
      case "new-window":
        return actions.newWindow();
      case "close-window":
        return actions.closeWindow();
      case "next-window":
        return actions.cycleWindow(1);
      case "prev-window":
        return actions.cycleWindow(-1);
      case "refresh-schema":
        return refreshSchemaRef.current();
      case "reconnect":
        return actions.reconnect();
      case "copy-tsv":
        return void copyResults("tsv");
      case "copy-csv":
        return void copyResults("csv");
      case "copy-all-csv":
        return void exportWhole("csv");
      case "copy-all-tsv":
        return void exportWhole("tsv");
      case "export":
        return void exportWhole("file");
      // A keymap's swapped chord or a menu pick does what the tip teaches too.
      case "show-data":
        retireTip("view-keys");
        return setActiveView("data");
      case "show-structure":
        retireTip("view-keys");
        return setActiveView("structure");
      case "commit-edits":
        return void commitEdits();
      case "review-sql":
        return openReview();
      case "discard-edits":
        return discardEdits();
      case "insert-row":
        return rowEdits.insertRow();
      case "duplicate-row":
        return rowEdits.duplicateSelected();
      case "clear-results":
        patchRun(activeTabId, { result: null, error: null, tableKey: null, outcome: null });
        return;
    }
  };

  // Right-click a tab: keep, Edit SQL, close, close the others, reopen.
  const tabMenu = useContextMenu<number>();
  const menuTab = tabs.find((t) => t.id === tabMenu.target);
  const pickTabMenu = (id: string) => {
    if (!menuTab) return;
    if (id === "keep") {
      retireTip("preview-reused");
      return patchTab(menuTab.id, { preview: false });
    }
    if (id === "edit-sql") return void openInQueryTab();
    if (id === "refresh-rows") return refreshRows();
    if (id === "new-tab") return addTab();
    if (id === "close") return closeTab(menuTab.id);
    if (id === "close-others") return closeOtherTabs(menuTab.id);
    if (id === "reopen") return reopenClosedTab();
  };

  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  latencyHooks.current = { tree: schemaTree, openTable };

  /** ⌥↵ from ⌘K: into the editor, or on a table tab into the chip editor's value (opened first). */
  const insertAtCaret = (text: string) => {
    if (isTableTab && activeTab && chipDraft?.tabId !== activeTab.id) {
      openChipEditor();
      requestAnimationFrame(() => requestAnimationFrame(() => sqlEditorRef.current?.insertText(text)));
      return;
    }
    sqlEditorRef.current?.insertText(text);
  };
  const onPalettePick = (picked: PaletteItem, mode: PickMode) => {
    const insert = mode === "insert";
    const t = picked.target;
    switch (t.kind) {
      case "table":
        if (insert) {
          insertAtCaret(tableIdent(t.table.schema, t.table.name));
        } else {
          openTable(t.table, {
            keep: true,
            view: mode === "structure" ? "structure" : "data",
          });
        }
        return;
      case "query":
        if (insert) insertAtCaret(t.sql);
        else openSqlInTab(t.sql);
        return;
      case "connection":
        if (t.id !== activeId || connState !== "connected") {
          actions.selectConnection(t.id);
        }
        return;
      case "command":
        setUses(recordCommandUse(t.id));
        return runCommand(t.id);
      case "connection-url":
        return actions.pasteConnection(t.url, true);
      case "sqlite-path":
        return actions.openSqlitePath(t.path);
    }
  };

  const closePalette = () => {
    onPaletteClose();
    // Hand focus back to the editor unless the command moved it elsewhere.
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (!el || el === document.body) sqlEditorRef.current?.focus();
    });
  };


  // The safe-mode shield in the shown window's pill and its three-item menu
  // (never a cycler: a misclick can't change the mode).
  const currentSafeMode: SafeMode = activeConnection?.safe_mode ?? "off";
  const safeLabel = SAFE_MODES.find((m) => m.value === currentSafeMode)?.label ?? "Off";
  const shieldRef = useRef<HTMLButtonElement>(null);
  const [shieldAt, setShieldAt] = useState<{ x: number; y: number } | null>(null);
  // Whether the menu was open when the shield was pressed: that press's
  // mousedown closes it, and its click must not open it again.
  const shieldWasOpen = useRef(false);
  const closeShield = useCallback(() => setShieldAt(null), []);
  /** Opens under the shield, in the title bar's pill. */
  const openShieldMenu = () => {
    const anchor = shieldRef.current?.getBoundingClientRect();
    setShieldAt(anchor ? { x: anchor.left, y: anchor.bottom + 6 } : { x: 120, y: 56 });
  };
  const openShieldMenuRef = useRef(openShieldMenu);
  openShieldMenuRef.current = openShieldMenu;
  const shield = activeConnection && connState === "connected" && (
    <button
      ref={shieldRef}
      type="button"
      className="win-shield"
      data-shield={currentSafeMode}
      title={`Safe mode: ${safeLabel} · Change…`}
      aria-label={`Safe mode: ${safeLabel}. Change…`}
      aria-haspopup="menu"
      aria-expanded={!!shieldAt}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={() => {
        shieldWasOpen.current = !!shieldAt;
      }}
      onClick={() => {
        if (shieldWasOpen.current) shieldWasOpen.current = false;
        else openShieldMenu();
      }}
    >
      <ShieldModeIcon mode={currentSafeMode} size={13} />
    </button>
  );

  // Whether agents can read this connection: the Agents button's dot.
  const mcpOn = !!activeConnection && mcpShared(activeConnection);

  // One inspector column at the right: Review SQL, else Quick Look. The main
  // column gives it its width (App.css, --inspector-right).
  const inspectorKind: InspectorKind | null = emptyPose
    ? null
    : reviewShown
      ? "review"
      : isSessionsTab && sessions.picked
        ? "session"
        : qlView
          ? "quicklook"
          : null;

  return (
    <div
      ref={workspaceRef}
      data-testid="workspace"
      className="workspace"
      hidden={!active}
      data-conn-state={connState}
      data-inspector={inspectorKind ?? undefined}
      data-empty-pose={emptyPose ? "" : undefined}
      data-tray-up={trayUp ? "" : undefined}
    >
      {/* The safe mode shield sits in the shown window's pill (2026-10-17). */}
      {active && titlebarTools && shield && createPortal(shield, titlebarTools)}
      {/* Clips the panel at the window's left edge, so ⌘B slides it out. */}
      <div className="sidebar-clip" data-close-scope="connection">
        <Sidebar
          ref={filterRef}
          connectionId={activeId}
          schemas={schemaTree}
          connecting={connState === "connecting"}
          failed={!!failure}
          selectedKey={activeTable?.key ?? null}
          onOpenTable={(t, keep) => openTable(t, { keep })}
          onTableStructure={(t) => openTable(t, { view: "structure" })}
          onInsertName={(t) => insertAtCaret(tableIdent(t.schema, t.name))}
          onHoverTable={hoverTable}
          onRefresh={connState === "connected" ? () => refreshSchemaRef.current() : undefined}
          refreshing={session.refreshing}
          head={switchers}
          sub={
            activeConnection && connState !== "idle" && !presenting ? (
              activeConnection.kind === "sqlite" ? (
                // SQLite has one database: the head names its file; this line, its folder.
                <span className="sb-db-file" title={activeConnection.path}>
                  {activeConnection.path.replace(/[\\/][^\\/]*$/, "") || "/"}
                </span>
              ) : (
                // Where it points; the database is the head's name (2026-10-13).
                <span className="sb-sub" data-sb-sub title={connectionSubtitle({ ...activeConnection, database: session.database ?? activeConnection.database })}>
                  {activeConnection.cloud_sql
                    ? instanceShortName(activeConnection.cloud_sql.instance)
                    : `${activeConnection.host}:${activeConnection.port}${activeConnection.ssh ? " · ssh" : ""}`}
                </span>
              )
            ) : null
          }
          envTag={activeConnection?.environment ? <EnvTag env={activeConnection.environment} /> : null}
          foot={
            <SidebarFoot
              mcpOn={mcpOn}
              agentsOpen={agentsOpen}
              proposals={proposalCount}
              onAgents={() => (onToggleAgents ? onToggleAgents() : runCommand("agents"))}
              settingsOpen={settingsOpen}
              onSettings={(section) => actions.openSettings(section)}
            />
          }
          menu={active && <ZoneMenu zone="panel" state={commandState} onRun={runCommand} />}
          keyStrip={active && <KeyStrip zone="panel" state={commandState} />}
          status={
            activeConnection && connState !== "idle" ? (
              <span
                data-testid="sb-status"
                className={`sb-status ${connState}`}
                data-state={connState}
                title={[
                  session.serverVersion ? `${ENGINES[activeConnection.kind].label} ${session.serverVersion}` : null,
                  activeConnection.kind === "postgres" && activeConnection.ssh ? "over SSH" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <span className={`conn-dot ${connState}`} />
                {connState === "connected" && session.connectMs !== null
                  ? formatMs(session.connectMs)
                  : null}
              </span>
            ) : null
          }
        />
      </div>
      <main data-testid="main" data-close-scope="tab" className={`main${emptyPose || failure ? " empty" : ""}`} ref={mainRef}>
        {/* No connection: Connect to start, in place of the editor and results. */}
        <Presence open={!!emptyPose}>
          <EmptyWindow
            connecting={!!activeId}
            keysLive={active && !activeId && !keysBlocked && !paletteOpen}
            onNewConnection={actions.newConnection}
            onOpenFile={actions.openSqliteFile}
            onPaste={() => actions.pasteConnection(undefined, true)}
            onOpenSample={() => actions.openSample(false)}
            onConnectFound={actions.connectFound}
            connections={connections}
            onPickConnection={actions.selectConnection}
            onShowAll={actions.openConnectionSwitcher}
          />
        </Presence>
        {/* Couldn't connect: the same column, the penguin Tilted. */}
        {failure && !emptyPose && (
          <ConnectFailed
            failure={failure}
            onRetry={connState === "error" ? actions.retryConnect : undefined}
            onEdit={connState === "error" && activeId ? editFailed : undefined}
            onReport={() => reportIssue(true)}
          />
        )}
        <div
          data-testid="editor-card"
          className={`card editor-card${isTableTab || isSessionsTab ? " table-mode" : ""}`}
          style={isTableTab || isSessionsTab ? undefined : { flex: `0 0 ${editorSplitPct}%` }}
        >
          <div data-testid="editor-header" className="editor-header" data-tauri-drag-region ref={headerRef}>
            {/* The panel is hidden: which connection and database this is,
                and its environment, at the tab row's left. */}
            <Presence open={(sidebarHidden || !activeId) && !!identity}>
              <div className="identity" data-identity>
                <span className="identity-switchers">{identity}</span>
                <EnvTag env={activeConnection?.environment} />
              </div>
            </Presence>
            <div className="history-nav" data-history={`${navHistory.index + 1}/${navHistory.entries.length}`}>
              <button
                type="button"
                className="history-btn"
                data-history-back
                data-hint-cmd="history-back"
                disabled={!histBack}
                title={histBack ? `Back to ${historyLabel(histBack)}  ${backKey}` : "Nothing to go back to"}
                aria-label="Back"
                onClick={() => goHistoryBy(-1)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!navHistory.entries.length) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setHistoryListAt({ x: r.left, y: r.bottom + 6 });
                }}
              >
                <ChevronLeftIcon size={14} />
              </button>
              <button
                type="button"
                className="history-btn"
                data-history-forward
                data-hint-cmd="history-forward"
                disabled={!histForward}
                title={histForward ? `Forward to ${historyLabel(histForward)}  ${forwardKey}` : "Nothing to go forward to"}
                aria-label="Forward"
                onClick={() => goHistoryBy(1)}
              >
                <ChevronRightIcon size={14} />
              </button>
            </div>
            <div data-testid="query-tabs" className="query-tabs" role="tablist" ref={queryTabsRef} data-tauri-drag-region>
              <span data-testid="query-tab-thumb" className="query-tab-thumb" ref={queryThumbRef} aria-hidden />
              {tabRows.map(({ item: tab, exiting }) =>
                exiting ? (
                  <div
                    key={tab.id}
                    ref={tabRef(String(tab.id))}
                    data-testid="query-tab"
                    className="query-tab"
                    aria-hidden
                    inert
                  >
                    {tab.kind === "table" && <TableIcon size={12} className="query-tab-icon" />}
                    <span data-testid="query-tab-title" className="query-tab-title">{tab.title}</span>
                    <span data-testid="query-tab-close" className="query-tab-close">
                      <CloseIcon size={9} />
                    </span>
                  </div>
                ) : (
                  <div
                    key={tab.id}
                    ref={tabRef(String(tab.id))}
                    role="tab"
                    tabIndex={0}
                    aria-selected={tab.id === activeTabId}
                    data-testid="query-tab"
                    className={`query-tab${tab.id === activeTabId ? " selected" : ""}${tab.preview ? " preview" : ""}`}
                    data-on={tab.id === activeTabId ? "" : undefined}
                    data-preview={tab.preview ? "" : undefined}
                    data-title={tab.title}
                    data-reorder-key={tab.id}
                    onPointerDown={dragQueryTab(String(tab.id))}
                    onClick={() => setActiveTabId(tab.id)}
                    onDoubleClick={() => {
                      if (!tab.preview) return;
                      patchTab(tab.id, { preview: false });
                      retireTip("preview-reused");
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1) closeTab(tab.id);
                    }}
                    onContextMenu={(e) => {
                      // Selected first, so the menu's keys act on this tab.
                      setActiveTabId(tab.id);
                      tabMenu.open(e, tab.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveTabId(tab.id);
                      }
                    }}
                  >
                    <TabStatus
                      run={runs[tab.id]}
                      table={tab.kind === "table"}
                      active={active}
                    >
                      {tab.title}
                    </TabStatus>
                    <button
                      type="button"
                      data-testid="query-tab-close"
                      className="query-tab-close"
                      data-no-drag
                      aria-label={`Close ${tab.title}`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                    >
                      <CloseIcon size={9} />
                    </button>
                  </div>
                ),
              )}
              <button
                type="button"
                data-testid="query-tab-add"
                data-hint-cmd="new-tab"
                className="query-tab-add"
                aria-label="New query tab"
                onClick={addTab}
              >
                <PlusIcon size={13} />
              </button>
            </div>
            {/* A table tab's Data | Structure, at the tab row's right (Paper, 2026-10-10). */}
            {isTableTab && viewSwitch}
            {active && rowTip && (
              <div className="tip-line tip-tab-row" data-tip={rowTip.id} role="status">
                {rowTip.text}
              </div>
            )}
          </div>
          {isTableTab && activeTab ? (
            <SqlLine
              // The last SQL only while it is this table's (a retargeted Preview tab's is not).
              sql={lineSql[activeTab.id]?.tableKey === activeTab.tableKey ? lineSql[activeTab.id].sql : null}
              ranFilter={lineSql[activeTab.id]?.tableKey === activeTab.tableKey ? lineSql[activeTab.id].filter : ""}
              filter={activeTab.filter ?? ""}
              chips={activeChipSql}
              editingChip={chipDraft?.tabId === activeTab.id ? chipDraft.index : null}
              filterEditor={
                chipDraft?.tabId === activeTab.id ? (
                  <ChipEditor
                    key={`${activeTabId}:${chipDraft.index ?? "new"}`}
                    ref={sqlEditorRef}
                    draft={chipDraft}
                    columns={chipColumns}
                    anyText={textColumns(chipColumns).length > 0}
                    lead={chipDraft.index === null && activeTab.chips?.length ? "AND" : ""}
                    onDraft={setChipDraft}
                    onApply={applyChipDraft}
                    onEscape={escapeChipDraft}
                    readOnly={busy}
                    completion={filterCompletion}
                  />
                ) : undefined
              }
              onChipEdit={(i) => openChipEditor({ index: i })}
              onChipRemove={removeChip}
              onChipsClear={() => activeTab.kind === "table" && setChips(activeTab, [], false)}
              onFilter={focusTableFilter}
              rows={result && result.columns.length > 0 && !result.error ? result.row_count : null}
              estimate={!activeTab.filter?.trim() && activeTable?.rows != null ? activeTable.rows : null}
              exact={activeExact?.value ?? null}
              counting={!!activeExact?.counting}
              onCount={() => void countExact()}
              onCancelCount={() => void cancelCount(windowId).catch(() => {})}
              hasMore={activeRun.hasMore}
              elapsedMs={result?.elapsed_ms ?? null}
              stats={selStats}
              running={runStartedAt !== null ? runningMeta : undefined}
              error={!!(result?.error && !result.cancelled) || !!activeRun.error}
              notice={notice}
              pageSize={activeTab.pageSize ?? DEFAULT_PAGE}
              pageSizes={PAGE_SIZES}
              onPageSize={setPageSize}
              onLoadMore={() => loadMore()}
              noKey={!!activeTable && !activeTable.table.primary_key?.length}
              onEditSql={() => void openInQueryTab()}
              wash={lineWash?.tabId === activeTab.id ? lineWash : null}
              sorted={!!activeTab.sort?.length}
              onClearSort={() => applySort([])}
              menu={active && <ZoneMenu zone="results" state={commandState} onRun={runCommand} />}
              tip={lockedHint ? `${filterKeys} filters · typing filters after your first filter` : (lineTip?.text ?? null)}
              tipId={lockedHint ? "locked" : lineTip?.id}
              onRefresh={refreshRows}
            />
          ) : isSessionsTab ? (
            <SessionsBar model={sessions} />
          ) : (
            <SqlEditor
              key={activeTabId}
              ref={sqlEditorRef}
              value={activeSql}
              onChange={setActiveSql}
              onRun={(sql) => void onRun(sql)}
              readOnly={busy}
              completion={completion}
              mark={activeRun.errorMark ?? null}
              onMarkEnter={applySuggestion}
            />
          )}
          {!isTableTab && !isSessionsTab && (
            // Run sits at the editor's foot, like a composer's send button.
            <div data-testid="composer" className="composer">
              {active && <KeyStrip zone="editor" state={commandState} />}
              <button
                type="button"
                data-testid="run-btn"
                className={`run-btn${running ? " running" : ""}`}
                disabled={busy || connState !== "connected"}
                onClick={() => void onRun()}
                data-waiting={running && activeRun.waiting ? "connection" : undefined}
                title={running && activeRun.waiting ? "Waiting for a free connection" : undefined}
              >
                <PlayIcon size={10} />
                {/* Run counts the time while its query runs; says when it waits for a connection. */}
                <span data-testid="run-label" className="run-label">
                  {running && activeRun.waiting ? (
                    "Waiting"
                  ) : running && runStartedAt !== null ? (
                    <Elapsed since={runStartedAt} active={active} format={formatMs} />
                  ) : (
                    "Run"
                  )}
                </span>
                <kbd className="run-shortcut"><Keys text={keysFor("run", macOverlay).replace("+", " ")} /></kbd>
              </button>
              {/* After Run, at the stable right end: the strip's coming and going never moves it. */}
              {active && <ZoneMenu zone="editor" state={commandState} onRun={runCommand} />}
            </div>
          )}
        </div>
        <div
          data-testid="pane-splitter"
          className={`pane-splitter${running && !isTableTab && !isSessionsTab ? " sweeping" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor and the results"
          onMouseDown={(e) => {
            e.preventDefault();
            if (!isTableTab && !isSessionsTab) startSplitDrag(e.currentTarget);
          }}
          onDoubleClick={() => {
            if (isTableTab || isSessionsTab) return;
            setEditorSplitPct(DEFAULT_EDITOR_SPLIT);
            writeKey(SPLIT_KEY, null);
          }}
        />
        <div
          data-testid="results-card"
          className={`card results-card${held?.hold.action === "confirm" && resultsView !== "structure" ? " held" : ""}`}
          data-held={held?.hold.action === "confirm" && resultsView !== "structure" ? "" : undefined}
        >
          {isSessionsTab ? (
            <SessionsGrid model={sessions} tabs={tabLabels} windowId={windowId} />
          ) : (
          <>
          {!isTableTab && (
          <div data-testid="card-toolbar" className="card-toolbar">
            {/* A query can join several tables, so it has no one table's Data / Structure. */}
            <span data-testid="card-title" className="card-title">
              {shownPlan ? "Plan" : "Results"}
            </span>
            {findShown && find && !shownPlan && (
              <span className="find-bar" data-find>
                <input
                  ref={findRef}
                  data-find-input
                  value={find.query}
                  placeholder="Find in results"
                  spellCheck={false}
                  onChange={(e) => setFind({ ...find, query: e.target.value, index: 0 })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setFind({ ...find, index: find.index + (e.shiftKey ? -1 : 1) });
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setFind(null);
                    }
                  }}
                />
                <span className="find-count" data-find-count={find.query ? findCount : ""}>
                  {find.query ? (findCount ? `${findAt + 1} of ${findCount.toLocaleString()}` : "No matches") : `↵ next · ${isMacPlatform() ? "⇧↵" : "Shift+↵"} previous`}
                </span>
              </span>
            )}
            {notice && <span className="card-notice">{notice}</span>}
            {resultsView === "structure" ? null : held && runStartedAt === null ? (
              <span data-testid="card-meta" className="card-meta">Not run</span>
            ) : runStartedAt !== null ? (
              runningMeta
            ) : shownPlan ? (
              <span data-testid="card-meta" className="card-meta" data-plan-meta>
                {shownPlan.plan.timed ? (
                  <>
                    <b>Ran in {formatMs(shownPlan.plan.executionMs ?? shownPlan.elapsedMs)}</b>
                    {shownPlan.plan.rows !== null &&
                      `${shownPlan.plan.rows.toLocaleString()} ${shownPlan.plan.rows === 1 ? "row" : "rows"}`}
                  </>
                ) : (
                  "Estimate"
                )}
                <button type="button" className="results-export" data-plan-copy onClick={() => void copyPlanText(planText(shownPlan.plan), "plan")}>
                  Copy as text
                </button>
                {commandById("explain-timed")?.canRun(commandState) && (
                  <button
                    type="button"
                    className="results-export"
                    data-plan-timed
                    onClick={() => void onExplain(true, shownPlan.sql)}
                  >
                    {shownPlan.plan.timed ? "Run again" : "Run with timings"}
                  </button>
                )}
              </span>
            ) : result?.cancelled ? (
              <span data-testid="card-meta" className="card-meta cancelled" data-state="cancelled">
                <span className="conn-dot" />
                Query cancelled · {formatMs(result.elapsed_ms)}
              </span>
            ) : result?.error ? (
              <span data-testid="card-meta" className="card-meta error" data-state="error">
                <span className="conn-dot error" />
                Error
              </span>
            ) : (
              result &&
              result.columns.length > 0 && (
                <span data-testid="card-meta" className="card-meta">
                  <span className="conn-dot connected" />
                  <b>{`${result.row_count.toLocaleString()} ${result.row_count === 1 ? "row" : "rows"}`}</b>
                  {formatMs(result.elapsed_ms)}
                </span>
              )
            )}
            {/* Paper: Export as a bordered button ahead of
                the zone's …, running the registry's export command. */}
            {resultsView !== "structure" && !shownPlan && result && result.columns.length > 0 && (
              <button
                type="button"
                data-testid="results-export"
                className="results-export"
                title={commandTip("export", "Export results")}
                disabled={!commandById("export")?.canRun(commandState)}
                onClick={() => runCommand("export")}
              >
                Export
              </button>
            )}
            {active && <ZoneMenu zone="results" state={commandState} onRun={runCommand} />}
          </div>
          )}
          {held?.hold.action === "confirm" && resultsView !== "structure" && (
            <SafetyBar
              hold={held.hold}
              connection={activeConnection}
              database={session.database}
              catalog={schema}
              mac={macOverlay}
              onConfirm={confirmHeld}
              onCancel={() => dropHeldRef.current()}
            />
          )}
          {heldEdit && isTableTab && resultsView !== "structure" && (
            <SafetyBar
              hold={heldEdit.hold}
              connection={activeConnection}
              database={session.database}
              catalog={schema}
              mac={macOverlay}
              edits={{ summary: heldEdit.summary, sql: heldEdit.sql }}
              onConfirm={() => void commitEdits(heldEdit.sql)}
              onCancel={dropHeldEdit}
            />
          )}
          {/* After a run of several statements, the list of them sits beside the grid. */}
          <div className="results-body" data-statements={statementList ? "" : undefined}>
            {statementList && (
              <StatementList
                statements={statementList}
                at={activeRun.statementAt ?? statementList.length - 1}
                disabled={busy}
                onPick={(index) => showStatement(activeTabId, index)}
              />
            )}
            <div className="results-main">
              {resultsView === "structure" && activeTable ? (
                <TableStructure
                  key={activeTable.key}
                  table={activeTable}
                  schemas={schemaTree}
                  onOpenTable={openTableByKey}
                  loadIndexes={loadIndexes}
                />
              ) : held?.hold.action === "refuse" ? (
                <SafetyRefusal
                  hold={held.hold}
                  onChangeMode={() => openShieldMenuRef.current()}
                />
              ) : renderError ? (
                <div className="results-error">{renderError}</div>
              ) : shownPlan ? (
                <PlanView key={`${activeTabId}:${shownPlan.sql}:${shownPlan.plan.timed}`} plan={shownPlan.plan} />
              ) : result?.error && !result.cancelled && !isTableTab ? (
                <QueryErrorView
                  message={result.error}
                  sqlstate={result.sqlstate ?? null}
                  sql={activeRun.ranSql ?? null}
                  position={result.error_position ?? null}
                  suggestion={activeRun.errorMark?.suggestion ?? null}
                  onReplace={applySuggestion}
                  onReport={() => reportIssue(true)}
                />
              ) : (
                <RenderErrorBoundary
                  fallback={(err) => (
                    <div className="results-error">
                      {err.message || String(err)}
                    </div>
                  )}
                >
                  <ResultsGrid
                    result={shownResult}
                    editing={rowEdits.editing}
                    columnWidths={columnWidths}
                    onColumnWidthsChange={setColumnWidths}
                    keyColumns={keyColumns}
                    columnComments={commentsByColumn}
                    sort={isTableTab ? (activeTab?.sort ?? []) : (activeClientSort ?? [])}
                    sortMode={isTableTab ? "server" : "client"}
                    onSort={sortBy}
                    onSortColumn={sortColumn}
                    onHideColumn={isTableTab ? hideColumn : undefined}
                    hiddenGrips={activeGrips}
                    onShowColumn={showColumn}
                    onOpenAsTable={!isTableTab && resultTable ? openResultAsTable : undefined}
                    onSelectionStats={isTableTab ? setSelStats : undefined}
                    onFilter={isTableTab ? gridFilter : undefined}
                    onTypeKey={isTableTab ? typeToFilter : undefined}
                    find={!isTableTab && find?.tabId === activeTabId ? find : null}
                    onFindCount={setFindCount}
                    commandState={commandState}
                    onFilterColumn={isTableTab ? (column) => openChipEditor({ column }) : undefined}
                    onStructure={isTableTab && activeTable ? () => setActiveView("structure") : undefined}
                    markedColumns={markedSet}
                    hiddenColumns={hiddenSet}
                    onMarkColumn={markTable ? markColumn : undefined}
                    tableName={resultTable?.name}
                    quickLookLinks={quickLookLinks}
                    quickLookAsk={quickLookAsk}
                    onQuickLook={setQlView}
                    onCellSelect={onCellSelect}
                    onNearEnd={activeRun.hasMore ? onNearEnd : undefined}
                    scrollKey={`${activeTabId}:${activeRun.runNo ?? 0}`}
                    emptyNote={
                      isTableTab && activeTab?.filter?.trim() ? (
                        <>
                          No rows match.{" "}
                          <button
                            type="button"
                            className="rg-empty-link"
                            data-clear-filters
                            onClick={() => activeTab.kind === "table" && setChips(activeTab, [], false)}
                          >
                            Clear filters
                          </button>
                          {/* No paging here, so a new row has its place under the note. */}
                          {rowEdits.rowsEditable && (
                            <button
                              type="button"
                              className="rg-add-row"
                              data-add-row
                              title={commandTip("insert-row", "Add a row")}
                              onClick={() => runCommand("insert-row")}
                            >
                              <PlusIcon size={11} />
                              Add row
                            </button>
                          )}
                        </>
                      ) : busy ? undefined : (
                        // A finished run with no rows says so, so it doesn't read as still loading.
                        <span data-empty-rows>No records</span>
                      )
                    }
                  />
                </RenderErrorBoundary>
              )}
            </div>
          </div>
          </>
          )}
          {/* The edits bar sits at the grid's foot, where the strip would; it prints its own keys. */}
          {active && !trayUp && !isSessionsTab && <KeyStrip zone="grid" state={commandState} />}
          <Presence open={trayUp}>
            <EditTray
              count={rowEdits.count}
              counts={
                rowEdits.buffer
                  ? {
                      edited: Object.keys(rowEdits.buffer.updates).length,
                      deleted: Object.keys(rowEdits.buffer.deletes).length,
                      inserted: rowEdits.buffer.inserts.length,
                    }
                  : undefined
              }
              state={trays[activeTabId] ?? { kind: "pending" }}
              onReview={openReview}
              onDiscard={discardEdits}
              onCommit={() => void commitEdits()}
              onChangeMode={() => openShieldMenuRef.current()}
              held={!!heldEdit}
            />
          </Presence>
        </div>
      </main>
      {/* The inspector column: Review SQL, else Quick Look (Paper, 2026-10-10). */}
      {/* One aside across the kinds: switching glides its width; only opening slides in. */}
      <Presence open={!!inspectorKind}>
        <Inspector
          kind={inspectorKind ?? "quicklook"}
          aria-label={inspectorKind === "review" ? "Review SQL" : inspectorKind === "session" ? "Session" : "Quick Look"}
          data-quicklook={inspectorKind === "quicklook" ? "" : undefined}
          data-review-sql={inspectorKind === "review" ? "" : undefined}
          data-deleted={inspectorKind === "quicklook" && qlView?.edit?.mark === "delete" ? "" : undefined}
        >
          {inspectorKind === "review" && reviewShown ? (
            <ReviewSql
              sql={reviewShown.sql}
              cards={reviewShown.cards}
              error={reviewShown.error}
              connection={activeConnection}
              onClose={() => setReview(null)}
              onCommit={commitReview}
            />
          ) : inspectorKind === "session" ? (
            <SessionDetail model={sessions} tabs={tabLabels} windowId={windowId} onGoToTab={setActiveTabId} />
          ) : inspectorKind === "quicklook" && qlView ? (
            <QuickLook
              columns={qlView.columns}
              row={qlView.row}
              rowNumber={qlView.rowIndex + 1}
              rowCount={qlView.rowCount}
              tableName={resultTable?.name}
              keyColumns={keyColumns}
              comments={commentsByColumn}
              followKey={followKey}
              links={quickLookLinks}
              column={qlView.column}
              edit={qlView.edit}
              onPrev={qlView.prev}
              onNext={qlView.next}
              onClose={qlView.close}
              onCopyJson={qlView.copyJson}
              onToggleDelete={isTableTab ? qlView.toggleDelete : undefined}
            />
          ) : null}
        </Inspector>
      </Presence>
      {active && (
        <GridMenu
          name="tab"
          label="Tab"
          at={tabMenu.at}
          items={menuTab ? tabMenuRows({ table: menuTab.kind === "table", preview: !!menuTab.preview, tabCount: tabs.length, closedTabs: closedCount }) : []}
          onPick={pickTabMenu}
          onClose={tabMenu.close}
        />
      )}
      {active && (
        <GridMenu
          name="history"
          label="History"
          at={historyListAt}
          items={navHistory.entries
            .map((entry, i) => ({
              id: String(i),
              label: `${entry.view === "structure" ? "⌗" : "▦"}  ${historyLabel(entry)}`,
              checked: i === navHistory.index,
            }))
            .reverse()}
          onPick={(id) => goHistoryBy(Number(id) - navHistory.index)}
          onClose={() => setHistoryListAt(null)}
        />
      )}
      {active && (
        <GridMenu
          name="safe-mode"
          label="Safe mode"
          at={shieldAt}
          items={SAFE_MODES.map((m) => ({ id: m.value, label: m.label, checked: m.value === currentSafeMode }))}
          footer="The database enforces Read-only. Environment never changes this."
          onPick={(id) => {
            if (id !== currentSafeMode) actions.setSafeMode(id as SafeMode);
          }}
          onClose={closeShield}
        />
      )}
      {active && (
        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          groups={paletteGroups}
          emptyGroups={PALETTE_EMPTY_GROUPS}
          connectionName={connected ? (activeConnection?.name ?? null) : null}
          onPick={onPalettePick}
        />
      )}
      <Presence open={timingsOpen && active}>
        {timingsOpen && active && (
          <TimingsSheet
            windowId={windowId}
            where={
              activeConnection
                ? [activeConnection.name, session.database].filter(Boolean).join(" / ")
                : null
            }
            tabTitle={(id) => tabsRef.current.find((t) => t.id === id)?.title}
            onClose={() => {
              setTimingsOpen(false);
              requestAnimationFrame(() => sqlEditorRef.current?.focus());
            }}
          />
        )}
      </Presence>
    </div>
  );
}
