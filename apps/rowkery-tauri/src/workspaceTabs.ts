import type { QueryPlan, WaitingFor } from "./api";
import type { EditBuffer } from "./editBuffer";
import type { FilterChip } from "./filterChips";
import type { HistoryEntry as NavEntry } from "./history";
import type { StatementResult } from "./StatementList";
import type { SortKey } from "./tableSort";
import type { QueryResultDto, SafetyHold } from "./types";

/** A table tab's three views: Data | Structure | Map. */
export type ResultsView = "data" | "structure" | "map";

/** Rows a table tab loads at a time, unless its page size says otherwise. */
export const DEFAULT_PAGE = 1000;
/** The page-size menu; 0 loads every row. */
export const PAGE_SIZES = [1000, 5000, 0];

export type SortState = SortKey;

/**
 * A query tab is a SQL scratchpad. A table tab shows one table (no editor):
 * a filter line, header-click sorting and paged rows. The sidebar only ever
 * opens table tabs, so it can't overwrite a query.
 */
export interface QueryTab {
  id: number;
  /**
   * "sessions": the server's sessions (SessionsView.tsx), Postgres only.
   * "health": the database's health (HealthView.tsx).
   * "import": Import CSV's preview, beside its panel; never saved.
   */
  kind: "query" | "table" | "sessions" | "health" | "import";
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
  /** Edits staged on other connections, by connection id: back when the window is (`bindEdits`). */
  parked?: Record<string, EditBuffer>;
  /** Map: the table it is centred on, when not the tab's own (session only). */
  mapCentre?: { key: string; name: string };
}

/** Where a table tab is, as a history entry (null for query tabs). */
export function entryOf(tab: QueryTab | undefined): NavEntry | null {
  if (!tab || tab.kind !== "table" || !tab.tableKey) return null;
  return {
    tableKey: tab.tableKey,
    name: tab.table ?? tab.title,
    view: tab.view === "structure" || tab.view === "map" ? tab.view : "data",
    centre: tab.view === "map" ? tab.mapCentre : undefined,
    filter: tab.filter ?? "",
    chips: tab.chips,
    sort: tab.sort ?? [],
    pageSize: tab.pageSize,
  };
}

/** A closed tab, kept for Undo and ⌘⇧T until the app quits. */
export interface ClosedTab {
  tab: QueryTab;
  run: TabRun | undefined;
  /** Where it sat in the tab row. */
  index: number;
}

/** Recently closed tabs kept per window (their rows only while the Undo toast is up). */
export const MAX_CLOSED_TABS = 10;

export const queryTab = (id: number, title: string, sql: string): QueryTab => ({
  id,
  kind: "query",
  title,
  sql,
});

/** How one run ended: Run All goes on only after "done". */
export type RunEnd = "done" | "error" | "cancelled" | "held" | "skipped";

/** A query tab's last run. Tabs run independently, several at a time. */
export interface TabRun {
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
  /** A second cancel now is a Force stop: a second after the first (core's `FORCE_ASK_AFTER`). */
  forceReady?: boolean;
  /**
   * The run waits for a free connection ("connection": every one the saved
   * connection may hold, 10, is busy running something or holding a
   * transaction), or for its tab's own ("tab": an earlier run, or a check
   * after a sleep, still has it).
   */
  waiting?: WaitingFor | null;
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
export function keepShownStatement(run: TabRun): Pick<TabRun, "statements"> {
  if (!run.statements || run.statementAt === undefined) return {};
  const statements = run.statements.slice();
  statements[run.statementAt] = shownStatement(run);
  return { statements };
}

/** The statement a tab shows, to keep while it shows another. */
export function shownStatement(run: TabRun): StatementResult {
  const { result, tableKey, ranSql, runNo } = run;
  return { result, tableKey, ranSql, runNo };
}

export const IDLE_RUN: TabRun = {
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

/** Lowest "Query N" not already open, so closing tabs never yields duplicates. */
export function nextTabTitle(tabs: QueryTab[]): string {
  const used = new Set(tabs.map((t) => t.title));
  let n = 1;
  while (used.has(`Query ${n}`)) n++;
  return `Query ${n}`;
}
