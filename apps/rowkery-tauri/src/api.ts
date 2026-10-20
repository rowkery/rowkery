import { Channel, invoke } from "@tauri-apps/api/core";
import { ResultRows } from "./resultStore";
import { summarizeRows } from "./columnProfile";
import type { TableCount } from "./rowCounts";
import type {
  Column,
  ConnectionListDto,
  ConnectionRecord,
  ConnectionSecrets,
  QueryResultDto,
  SafetyHold,
  SchemaCatalog,
  TableIndexes,
  Value,
} from "./types";

export async function listConnections(): Promise<ConnectionListDto> {
  return invoke("list_connections");
}

/** Whether a SQLite file is at `path` (`~/` expanded as core opens it). */
export async function sqliteFileExists(path: string): Promise<boolean> {
  return invoke("sqlite_file_exists", { path });
}

export async function saveConnection(
  connection: ConnectionRecord,
  secrets: ConnectionSecrets,
): Promise<void> {
  return invoke("save_connection", { connection, secrets });
}

/**
 * Removes the connection and its keychain entries; with `keepSecrets` the
 * entries stay until `forgetConnectionSecrets` (the delete can be undone).
 */
export async function deleteConnection(id: string, keepSecrets = false): Promise<void> {
  return invoke("delete_connection", { id, keepSecrets });
}

/** The keychain entries a delete with `keepSecrets` left. */
export async function forgetConnectionSecrets(id: string): Promise<void> {
  return invoke("forget_connection_secrets", { id });
}

export interface ProbeResult {
  ok: boolean;
  /** Server version on success (e.g. "PostgreSQL 16.3"), the error otherwise. */
  message: string;
  elapsed_ms: number;
}

/** The Google account a Cloud SQL connection signs in with (`cloudsql::account`). */
export interface CloudSqlAccount {
  kind: "gcloud" | "key";
  /** Unknown when Google won't say. */
  email: string | null;
}

export interface CloudSqlInstance {
  project: string;
  name: string;
  region: string;
  /** `project:region:name`. */
  connection_name: string;
  /** "Postgres 16", "MySQL 8.0". */
  engine: string;
  postgres: boolean;
  /** "running", "stopped", or Google's state in lower case. */
  state: string;
}

export interface CloudSqlInstanceList {
  instances: CloudSqlInstance[];
  /** Projects whose instances couldn't be listed. */
  skipped: string[];
  /** The account sees more projects than were searched. */
  more_projects?: boolean;
}

/** Which login a Cloud SQL call uses: the key picked in the form (its id; the key stays in Rust), else the one saved for `connectionId`. */
export interface CloudSqlLogin {
  credentials: "gcloud" | "key";
  key?: string | null;
  connectionId?: string | null;
}

/** The account the form shows; null when there is no gcloud login (or no key yet). */
export async function cloudsqlAccount(login: CloudSqlLogin): Promise<CloudSqlAccount | null> {
  return invoke("cloudsql_account", { ...login });
}

/** Every Cloud SQL instance the account can see. */
export async function cloudsqlInstances(login: CloudSqlLogin): Promise<CloudSqlInstanceList> {
  return invoke("cloudsql_instances", { ...login });
}

/**
 * Asks for a service account key file (the native dialog) and keeps it in
 * Rust until Save; `key` stands for it in the form. Refuses anything else;
 * null when the dialog was dismissed.
 */
export async function cloudsqlKeyFile(): Promise<{ key: string; account: CloudSqlAccount } | null> {
  return invoke("cloudsql_key_file");
}

/** Test a connection without saving it. */
export async function probeConnection(
  connection: ConnectionRecord,
  secrets: ConnectionSecrets,
): Promise<ProbeResult> {
  return invoke("probe_connection", { connection, secrets });
}

/**
 * ⌘K "Open the sample database" (`reset` false: written only if missing) and
 * "Reset the sample database" (`reset` true: a fresh copy). Its record,
 * put back if it was deleted.
 */
export async function openSample(reset: boolean): Promise<ConnectionRecord> {
  return invoke("open_sample", { reset });
}

/** A Postgres answering on loopback ("Found on this Mac"). */
export interface LocalServer {
  port: number;
  /** The OS user (libpq's default role and database). */
  user: string;
}

export async function probeLocalServers(): Promise<LocalServer[]> {
  return invoke("probe_local_servers");
}

/** The clipboard's text, for ⌘V outside a text field when no paste event came. */
export async function readClipboardText(): Promise<string> {
  return invoke("read_clipboard_text");
}

/** Choose file… : the native open dialog; null when dismissed. */
export async function chooseFile(kind: "sqlite" | "pem" | "key"): Promise<string | null> {
  return invoke("choose_file", { kind });
}

export interface WindowOpened {
  /** Database the window landed on ("main" for SQLite). */
  database: string;
  catalog: SchemaCatalog;
  /** "16.4" for Postgres, the SQLite library's "3.46.0"; null if unknown. */
  server_version: string | null;
  elapsed_ms: number;
  /**
   * True when `catalog` came from the on-disk cache; a `catalog-update` event
   * with this `open_seq` follows once the live catalog was checked.
   */
  cached: boolean;
  open_seq: number;
}

/**
 * Points a window at a connection, on `database` or the saved one, and returns
 * its schema. Calling it again on the same window switches it.
 */
export async function openWindow(
  windowId: string,
  connectionId: string,
  database?: string | null,
): Promise<WindowOpened> {
  return invoke("open_window", { windowId, connectionId, database: database ?? null });
}

/** Why a connection failed: core's error class, a one-line cause, the sheet field to mark. */
export interface ConnectExplanation {
  class: string;
  cause: string | null;
  field: string | null;
}

export async function explainConnectError(
  error: string,
  target: { host: string; port: number; username: string; sshHost: string | null; cloudSql?: string | null },
): Promise<ConnectExplanation> {
  return invoke("explain_connect_error", { error, ...target });
}

/** A SQLite window's row counts, asked for once its catalog is shown. */
export async function tableCounts(windowId: string): Promise<TableCount[]> {
  return invoke("table_counts", { windowId });
}

/** Forgets a window and cancels its running queries. */
export async function closeWindow(windowId: string): Promise<void> {
  return invoke("close_window", { windowId });
}

export interface DatabaseInfo {
  name: string;
  /** Null when the user may not connect to it. */
  size_bytes: number | null;
}

/** Databases on the window's server; empty for SQLite. */
export async function listDatabases(windowId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { windowId });
}

/** Index details for tables whose catalog entry deferred them (Postgres). */
export async function tableIndexes(
  windowId: string,
  schema: string,
  tables: string[],
): Promise<TableIndexes[]> {
  return invoke("table_indexes", { windowId, schema, tables });
}

/** One client session on the server (`pg_stat_activity`), and our tab when it is one. */
export interface ServerSessionRow {
  pid: number;
  user: string | null;
  application: string;
  client: string | null;
  state: string | null;
  /** `Lock: relation`, `IO: DataFileRead`, … */
  wait: string | null;
  xact_secs: number | null;
  query_secs: number | null;
  state_secs: number | null;
  /** Null when this login may not read it. */
  query: string | null;
  blocked_by: number[];
  can_stop: boolean;
  rowkery_tag: string | null;
  tab: { window_id: string; tab_id: number } | null;
}

export interface HeldLock {
  table: string;
  mode: string;
}

export type StopKind = "cancel" | "end";

export type StopOutcome =
  | { status: "stopped"; gone: boolean }
  | { status: "held"; sql: string }
  | { status: "refused"; message: string };

/** The server's other sessions on the window's database (Postgres only). */
export async function listSessions(windowId: string): Promise<ServerSessionRow[]> {
  return invoke("list_sessions", { windowId });
}

/** The table locks session `pid` holds. */
export async function sessionLocks(windowId: string, pid: number): Promise<HeldLock[]> {
  return invoke("session_locks", { windowId, pid });
}

/** Cancels a session's query or ends it; safe mode may hold or refuse it. */
export async function stopSession(
  windowId: string,
  pid: number,
  kind: StopKind,
  confirmed: boolean,
): Promise<StopOutcome> {
  return invoke("stop_session", { windowId, pid, kind, confirmed });
}

/** Reloads a window's schema; unlike `openWindow`, its query tabs keep their sessions. */
export async function reloadWindowSchema(windowId: string): Promise<SchemaCatalog> {
  return invoke("reload_window_schema", { windowId });
}

/**
 * One message on a run's channel: JSON `columns` and `done` (src-tauri
 * `Frame`), and binary rows frames (an ArrayBuffer, `resultStore.ts`). JSON
 * `rows` frames are accepted too (tests, proofs' stubs).
 */
export type Frame =
  | { t: "columns"; query_id: number; columns: Column[] }
  | { t: "waiting"; query_id: number; waiting: boolean }
  | { t: "rows"; query_id: number; seq: number; rows: (Value | null)[][] }
  | ({ t: "done" } & DoneFrame);

export interface DoneFrame {
  query_id: number;
  status: "ok" | "error" | "cancelled" | "held";
  row_count: number;
  affected_rows: number | null;
  elapsed_ms: number;
  first_row_ms: number | null;
  frames: number;
  bytes?: number;
  error: string | null;
  sqlstate: string | null;
  error_position: number | null;
  hold: SafetyHold | null;
  /** The run reached the most rows a tab holds and left the rest out. */
  capped?: boolean;
}

export interface RunOptions {
  /** The user confirmed this run on a Confirm writes connection. */
  confirmed?: boolean;
  /**
   * Called once, when the first rows arrive while the query still runs, with
   * the result they are in. Its `rows` keep growing in place; read them with
   * `useResultRows`. A run whose done frame lands in the same task as its
   * rows (a small, fast result) never calls it.
   */
  onProgress?: (partial: QueryResultDto) => void;
  /**
   * Called with `true` when every connection the saved connection may hold
   * is busy and the run waits for one, and `false` once it has one.
   */
  onWaiting?: (waiting: boolean) => void;
}

const NULL_CELL: Value = { Null: null };

/**
 * Bytes per ms rows frames reach this webview at (Rust stamps `sent_at`);
 * the next run asks for frames that take about 8 ms to arrive.
 */
let bytesPerMs: number | null = null;

function measure(bytes: number, sentAtMs: number) {
  const ms = performance.timeOrigin + performance.now() - sentAtMs;
  // Below ~1 ms the clock can't tell; small frames say nothing about the rate.
  if (!(ms > 1) || bytes < 4096) return;
  const rate = bytes / ms;
  bytesPerMs = bytesPerMs === null ? rate : bytesPerMs * 0.7 + rate * 0.3;
}

/**
 * Runs `sql` in a window's query tab. Rows stream over a channel as the
 * database sends them (no polling, no deadline) into the result's
 * `ResultRows`; the promise resolves with the result when the done frame
 * arrives, or with `hold` when safe mode stopped it. Cancel with `cancelQuery`.
 */
export function runQuery(
  windowId: string,
  tabId: number,
  sql: string,
  opts: RunOptions | boolean = {},
): Promise<QueryResultDto> {
  const { confirmed = false, onProgress, onWaiting } = typeof opts === "boolean" ? { confirmed: opts } : opts;
  return stream<number>(
    "run_query",
    // Every row the query returns (up to the cap a tab holds), never a cursor page.
    { windowId, tabId, sql, confirmed, page: null },
    onProgress,
    onWaiting,
  ).then(([result]) => result);
}

/** A table tab's browse: which table, filtered, sorted and paged how. */
export interface BrowseRequest extends BrowseOptions {
  engine: string;
  schema: string;
  table: string;
}

/**
 * Browses a table in one call: core builds the `SELECT` and runs it in the
 * tab (no `browse_table_sql` round trip first). Resolves with the result and
 * the SQL it ran.
 */
export function browseTable(
  windowId: string,
  tabId: number,
  browse: BrowseRequest,
  onProgress?: RunOptions["onProgress"],
  onWaiting?: RunOptions["onWaiting"],
): Promise<QueryResultDto & { sql: string }> {
  return stream<{ query_id: number; sql: string }>(
    "browse_table",
    {
      windowId,
      tabId,
      engine: browse.engine,
      schema: browse.schema,
      table: browse.table,
      columns: browse.columns?.length ? browse.columns : null,
      filter: browse.filter ?? null,
      order: browse.order ?? null,
      limit: browse.limit ?? null,
      offset: browse.offset ?? null,
      key: browse.key ?? null,
      after: browse.after ?? null,
    },
    onProgress,
    onWaiting,
  ).then(([result, started]) => ({ ...result, sql: started.sql }));
}

/** Runs a streaming command; resolves on its done frame with what `invoke` returned. */
function stream<Started>(
  command: string,
  args: Record<string, unknown>,
  onProgress: RunOptions["onProgress"],
  onWaiting?: RunOptions["onWaiting"],
): Promise<[QueryResultDto, Started]> {
  const result: QueryResultDto = {
    columns: [],
    rows: new ResultRows(),
    row_count: 0,
    elapsed_ms: 0,
    error: null,
    cancelled: false,
  };
  let started: Started | undefined;
  let finished: QueryResultDto | undefined;
  return new Promise((resolve, reject) => {
    // Frames can beat the invoke's reply: resolve once both are in.
    const settle = () => {
      if (finished && started !== undefined) resolve([finished, started]);
    };
    let settled = false;
    let jsonRows = false;
    let progressed = false;
    let scheduled = 0;
    const progress = () => {
      scheduled = 0;
      if (settled || progressed) return;
      progressed = true;
      onProgress?.(result);
    };
    const gotRows = () => {
      // Next frame: a done frame right behind the rows makes it one result.
      if (onProgress && !progressed && !scheduled) scheduled = requestAnimationFrame(progress);
    };
    const channel = new Channel<Frame | ArrayBuffer>();
    channel.onmessage = (frame) => {
      if (settled) return;
      if (frame instanceof ArrayBuffer) {
        const header = result.rows.appendFrame(frame);
        measure(frame.byteLength, header.sentAtMs);
        gotRows();
        return;
      }
      switch (frame.t) {
        case "columns":
          result.columns = frame.columns;
          return;
        case "waiting":
          onWaiting?.(frame.waiting);
          return;
        case "rows":
          jsonRows = true;
          result.rows.appendValues(
            frame.rows.map((row) => row.map((cell) => (cell === null ? NULL_CELL : cell))),
          );
          gotRows();
          return;
        case "done":
          settled = true;
          if (scheduled) cancelAnimationFrame(scheduled);
          // Rows that came as JSON (no binary frames, so no core profiles): summarized once, here.
          if (jsonRows && !result.rows.profiles) result.rows.setProfiles(summarizeRows(result.columns, result.rows));
          finished = {
            ...result,
            row_count: frame.status === "ok" ? frame.row_count : result.rows.length,
            elapsed_ms: frame.elapsed_ms,
            error: frame.error,
            cancelled: frame.status === "cancelled",
            hold: frame.hold,
            affected_rows: frame.affected_rows,
            first_row_ms: frame.first_row_ms,
            frames: frame.frames,
            sqlstate: frame.sqlstate,
            error_position: frame.error_position,
            capped: frame.capped ?? false,
          };
          settle();
      }
    };
    invoke<Started>(command, { ...args, hintBytesPerMs: bytesPerMs, onFrame: channel }).then(
      (value) => {
        started = value;
        settle();
      },
      (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}

/** How an export or a copy-all ended (src-tauri `ExportFrame::Done`). */
export interface ExportDone {
  rows: number;
  error: string | null;
  cancelled: boolean;
  /** The file written (exports). */
  path: string | null;
}

type ExportFrame = { t: "progress"; rows: number } | ({ t: "done" } & ExportDone);

/** Runs an export command; resolves on its done frame (null: nothing started). */
function exportStream(
  command: string,
  args: Record<string, unknown>,
  onProgress?: (rows: number) => void,
): Promise<ExportDone | null> {
  return new Promise((resolve, reject) => {
    let done: ExportDone | null = null;
    let started: boolean | null = null;
    const settle = () => {
      if (started === false) resolve(null);
      else if (started && done) resolve(done);
    };
    const channel = new Channel<ExportFrame>();
    channel.onmessage = (frame) => {
      if (frame.t === "progress") onProgress?.(frame.rows);
      else {
        const { t: _t, ...rest } = frame;
        done = rest;
        settle();
      }
    };
    invoke<number | null>(command, { ...args, onFrame: channel }).then((id) => {
      started = id !== null;
      settle();
    }, reject);
  });
}

/**
 * Export…: the native save dialog asks where (CSV, TSV, JSON or SQL INSERT by
 * extension), then core runs `sql` whole in the tab and writes the file.
 * Resolves null when the dialog was dismissed. `schema` / `table` name the
 * INSERT target.
 */
export function exportResults(
  windowId: string,
  tabId: number,
  req: { sql: string; engine: string; schema: string; table: string },
  onProgress?: (rows: number) => void,
): Promise<ExportDone | null> {
  return exportStream("export_results", { windowId, tabId, ...req }, onProgress);
}

/** Copy all results: core runs `sql` whole and puts it on the clipboard. */
export function copyAllResults(
  windowId: string,
  tabId: number,
  sql: string,
  format: "csv" | "tsv",
  onProgress?: (rows: number) => void,
): Promise<ExportDone> {
  return exportStream("copy_all_results", { windowId, tabId, sql, format }, onProgress).then(
    (d) => d ?? { rows: 0, error: null, cancelled: true, path: null },
  );
}

/** One foreign key for Quick Look to follow (src-tauri `follow_keys`). */
export interface FollowLookup {
  schema: string;
  table: string;
  column: string;
  value: Value;
}

/** The row a key points at, or null where nothing matched. */
export interface FollowRow {
  columns: Column[];
  row: (Value | null)[];
}

/** Follows several keys at once on the window's Quick Look session. */
export async function followKeys(windowId: string, lookups: FollowLookup[]): Promise<(FollowRow | null)[]> {
  return invoke("follow_keys", { windowId, lookups });
}

/**
 * Hover prefetch: the first page of the browse a click on the row would run,
 * read on the window's prefetch session (the click then continues its
 * cursor). Resolves true once cached; false when cancelled or skipped.
 */
export async function prefetchTable(windowId: string, browse: BrowseRequest): Promise<boolean> {
  return invoke("prefetch_table", {
    windowId,
    engine: browse.engine,
    schema: browse.schema,
    table: browse.table,
    columns: browse.columns?.length ? browse.columns : null,
    filter: browse.filter ?? null,
    order: browse.order ?? null,
    limit: browse.limit ?? null,
    key: browse.key ?? null,
  });
}

/** The pointer left the row: cancels the prefetch in flight. */
export async function cancelPrefetch(windowId: string): Promise<void> {
  return invoke("cancel_prefetch", { windowId });
}

/**
 * Quick Look's Incoming: per lookup, how many rows of `schema.table` have
 * `column = value`, counted no further than `INCOMING_CAP + 1` (null where
 * the value can't be matched). Runs on the window's Quick Look session.
 */
export async function countIncoming(windowId: string, lookups: FollowLookup[]): Promise<(number | null)[]> {
  return invoke("count_incoming", { windowId, lookups });
}

/** The table staged edits go to: its columns' catalog types and its key. */
export interface EditTable {
  schema: string;
  table: string;
  columns: { name: string; type_name: string }[];
  /** The primary key's columns, or `["rowid"]` for a SQLite table without one. */
  key: string[];
}

export interface CellValue {
  column: string;
  value: Value | null;
}

/** One staged row change; columns an insert leaves out get their DEFAULT. */
export type RowChange =
  | { op: "insert"; values: CellValue[] }
  | { op: "update"; key: CellValue[]; set: CellValue[] }
  | { op: "delete"; key: CellValue[] };

export interface RowStatement {
  verb: "insert" | "update" | "delete";
  sql: string;
  target: string;
  /** `id = 3` for an UPDATE or DELETE. */
  predicate: string | null;
}

/** What Review SQL shows: the statements and the `BEGIN; … COMMIT;` text. */
export interface ReviewedChanges {
  statements: RowStatement[];
  sql: string;
}

export type ApplyOutcome =
  | { status: "committed"; inserted: number; updated: number; deleted: number; elapsed_ms: number }
  /** Confirm writes (`confirm`) or Read-only (`refuse`): nothing ran. */
  | { status: "held"; hold: SafetyHold; sql: string }
  /** Nothing was kept; `index` and `statement` name the row at fault. */
  | {
      status: "rolled_back";
      index: number | null;
      statement: string | null;
      rows: number | null;
      message: string;
      elapsed_ms: number;
    };

/** The statements staged edits become (`build_row_changes` in core). */
export async function reviewChanges(engine: string, table: EditTable, changes: RowChange[]): Promise<ReviewedChanges> {
  return invoke("review_changes", { engine, table, changes });
}

/**
 * Commits staged edits as one transaction on the tab's session. Every
 * statement must change exactly one row or nothing is kept. On Confirm
 * writes the first call is held; `confirmed` is the held `sql`, so only
 * what the user saw runs.
 */
export async function applyChanges(
  windowId: string,
  tabId: number,
  table: EditTable,
  changes: RowChange[],
  confirmed?: string,
): Promise<ApplyOutcome> {
  // One commit per tab at a time: a second would run the same INSERTs again.
  const key = `${windowId}:${tabId}`;
  if (applying.has(key)) throw new Error("A commit is already running in this tab");
  applying.add(key);
  try {
    return await invoke("apply_changes", { windowId, tabId, table, changes, confirmed: confirmed ?? null });
  } finally {
    applying.delete(key);
  }
}
const applying = new Set<string>();

/** Incoming counts stop one past this: Quick Look prints `100+`. */
export const INCOMING_CAP = 100;

/**
 * Checks the window's idle sessions and replaces dead ones in the background
 * (returns at once). Called when the webview regains focus: the closest thing
 * to a wake-from-sleep signal.
 */
export async function pingIdle(windowId: string): Promise<void> {
  return invoke("ping_idle", { windowId });
}

/** Cancels the tab's query, if any, and closes the connection it kept open. */
export async function closeQueryTab(windowId: string, tabId: number): Promise<void> {
  return invoke("close_query_tab", { windowId, tabId });
}

/** One step of a plan (`rowkery_core::plan::PlanStep`). */
export interface PlanStep {
  depth: number;
  /** `Seq Scan`, `Hash Join`, `Scan` (SQLite). */
  kind: string;
  schema: string | null;
  table: string | null;
  alias: string | null;
  index: string | null;
  /** `by placed_at`, `left`, a CTE's name. */
  note: string | null;
  /** Per loop, as Postgres reports both. */
  expectedRows: number | null;
  actualRows: number | null;
  loops: number | null;
  /** Time in this step itself over all loops (timed plans). */
  ownMs: number | null;
  ownCost: number | null;
  /** How many times off the row guess was, when it's worth a tag. */
  miss: number | null;
  details: { label: string; value: string }[];
}

export interface PlanHint {
  text: string;
  /** To copy: an index, ANALYZE, a SET. Never run for you. */
  sql: string | null;
  step: number | null;
}

export interface QueryPlan {
  steps: PlanStep[];
  timed: boolean;
  executionMs: number | null;
  planningMs: number | null;
  rows: number | null;
  slowest: number | null;
  hint: PlanHint | null;
}

export type ExplainOutcome =
  | { kind: "plan"; plan: QueryPlan; elapsed_ms: number }
  | { kind: "held"; hold: SafetyHold }
  | { kind: "cancelled" };

/**
 * ⌘E: the plan of `sql` (one statement) on the tab's session. An estimate
 * runs nothing; `timed` runs it with ANALYZE, and a write goes through safe
 * mode (`confirmed`) and is rolled back. The tab's Cancel stops it.
 */
export async function explainStatement(
  windowId: string,
  tabId: number,
  sql: string,
  timed: boolean,
  confirmed = false,
): Promise<ExplainOutcome> {
  return invoke("explain_statement", { windowId, tabId, sql, timed, confirmed });
}

/**
 * Cancels the tab's query. Core stops it outright if the server hasn't
 * ended it 3 s later; calling again (Force stop) stops it at once.
 */
export async function cancelQuery(windowId: string, tabId: number): Promise<void> {
  return invoke("cancel_query", { windowId, tabId });
}

/**
 * The SQL line's exact count: `SELECT count(*)` with the tab's WHERE, on a
 * session of its own. Null when cancelled (`cancelCount`).
 */
export async function countRows(
  windowId: string,
  engine: "postgres" | "sqlite",
  schema: string,
  table: string,
  filter: string | null,
): Promise<number | null> {
  return invoke("count_rows", { windowId, engine, schema, table, filter });
}

export async function cancelCount(windowId: string): Promise<void> {
  return invoke("cancel_count", { windowId });
}

/** Stops every running query in every window without waiting for the servers. */
export async function stopAllQueries(): Promise<void> {
  return invoke("stop_all_queries");
}

/** What a table tab shows besides the table itself. */
export interface BrowseOptions {
  /** The columns to select, in order; empty or unset selects `*`. */
  columns?: string[];
  /** The body of a `WHERE`; the core wraps it in parentheses. */
  filter?: string;
  order?: { column: string; desc: boolean }[];
  limit?: number;
  /** Rows already loaded: the next page skips them when it can't use `after`. */
  offset?: number;
  /** The primary key: pages order by it last and continue after `after`. */
  key?: string[];
  /** The last loaded row by column name; the next page starts after it. */
  after?: Record<string, Value>;
}

export async function browseTableSql(
  engine: string,
  schema: string,
  table: string,
  opts: BrowseOptions = {},
): Promise<string> {
  return invoke("browse_table_sql", {
    engine,
    schema,
    table,
    columns: opts.columns?.length ? opts.columns : null,
    filter: opts.filter ?? null,
    order: opts.order ?? null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
    key: opts.key ?? null,
    after: opts.after ?? null,
  });
}

export const TEST_PG_CONNECTION: ConnectionRecord = {
  kind: "postgres",
  id: "pg-docker-test",
  name: "Docker Postgres",
  host: "127.0.0.1",
  port: 54329,
  database: "rowkery",
  username: "rowkery",
  ssl_mode: "disable",
};

export const TEST_PG_SECRETS: ConnectionSecrets = {
  db_password: "rowkery",
};
