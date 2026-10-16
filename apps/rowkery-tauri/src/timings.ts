import { invoke } from "@tauri-apps/api/core";

/**
 * Latency marks, measured from process start (the Rust `main`), and the last
 * 50 queries per window. Every mark is also a `performance.mark`, so DevTools
 * shows them. When the app runs with `ROWKERY_TIMINGS_OUT=<file>` the ledger is
 * appended there as JSON lines (`write_timings`), which
 * `scripts/latency-proof.sh` reads; budgets live in `scripts/budgets.json`.
 * Recording costs a `performance.now()` and an array push; nothing here runs
 * on a timer.
 */

export interface LedgerLine {
  mark: string;
  /** ms since process start. */
  t: number;
  /** ms, for spans (palette-open, window-switch). */
  dur?: number;
  window?: string;
  tab?: number;
  [extra: string]: unknown;
}

export interface QueryTiming {
  window: string;
  tab: number;
  /** First 80 characters of the SQL. */
  sql: string;
  /** ms since process start. */
  runSent: number;
  firstFrame: number | null;
  firstFramePainted: number | null;
  allRows: number | null;
  rows: number | null;
  /** The database's own `elapsed_ms`. */
  elapsedMs: number | null;
  /** Server-side first row, once the done frame carries it (phase 1). */
  firstRowMs: number | null;
}

/** What `timings_origin` returns. */
interface Origin {
  /** Unix epoch ms when the process started. */
  process_start_ms: number;
  /** ROWKERY_TIMINGS_OUT is set: flush the ledger to it. */
  recording: boolean;
  /** Proof automation from the environment (latency-proof.sh). */
  proof: ProofEnv | null;
}

export interface ProofEnv {
  /** ROWKERY_AUTO_RUN_SQL: statements run one after another once connected. */
  run_sql: string[];
  /** ROWKERY_AUTO_BROWSE_TABLE: `schema.table` browsed after the SQL. */
  browse_table: string | null;
}

const MAX_QUERIES = 50;

/** `performance.now()` of process start; 0 (page start) until the origin is known. */
let processStart = 0;
let recording = false;
let proofEnv: ProofEnv | null = null;
let ready: Promise<void> | null = null;
/** `processStart` is known; until then marks wait in `raw`. */
let originKnown = false;
/** Marks taken before the origin was known keep their raw `performance.now()`. */
const raw: { mark: string; at: number; extra: Record<string, unknown> }[] = [];
const ledger: LedgerLine[] = [];
let flushed = 0;
const queries = new Map<string, QueryTiming[]>();
const spans = new Map<string, number>();

const now = () => performance.now();
const since = (at: number) => Math.round((at - processStart) * 10) / 10;

function push(mark: string, at: number, extra: Record<string, unknown> = {}) {
  try {
    performance.mark(mark, { startTime: at, detail: extra });
  } catch {
    // An old webview without mark options: the ledger still has it.
  }
  if (!originKnown) raw.push({ mark, at, extra });
  else ledger.push({ mark, t: since(at), ...extra });
}

/**
 * Reads the process start from Rust (no-op outside Tauri) and back-dates the
 * `process-start` mark. Marks taken before this resolves are rebased on it.
 */
export function initTimings(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if ("__TAURI_INTERNALS__" in window) {
      try {
        const o = await invoke<Origin>("timings_origin");
        processStart = o.process_start_ms - performance.timeOrigin;
        recording = o.recording;
        proofEnv = o.proof;
      } catch {
        // An older backend: marks stay relative to page start.
      }
    }
    ledger.push({ mark: "process-start", t: 0 });
    // index.html's inline script marks when the page starts parsing.
    const webview = performance.getEntriesByName("webview-ready")[0];
    if (webview) ledger.push({ mark: "webview-ready", t: since(webview.startTime) });
    for (const r of raw.splice(0)) ledger.push({ mark: r.mark, t: since(r.at), ...r.extra });
    ledger.sort((a, b) => a.t - b.t);
    originKnown = true;
  })();
  return ready;
}

/** Proof automation the app was started with, once `initTimings` resolved. */
export function proofAutomation(): ProofEnv | null {
  return proofEnv;
}

/** A point in time: `shell-painted`, `socket-warm`, … */
export function mark(name: string, extra: Record<string, unknown> = {}) {
  push(name, now(), extra);
}

const once = new Set<string>();

/** A mark taken only the first time (StrictMode runs effects twice in dev). */
export function markOnce(name: string, extra: Record<string, unknown> = {}) {
  if (once.has(name)) return;
  once.add(name);
  mark(name, extra);
}

/** Starts a span (`palette-open`); `endSpan` records it with its duration. */
export function startSpan(name: string) {
  spans.set(name, now());
}

/**
 * Ends a span after the frame it changed has painted: one animation frame,
 * then a task, so `dur` includes React's commit, style, layout, paint and the
 * wait for the next vsync. `commit_ms` stops at the commit, the UI thread's
 * own work, which is what a browser proof can budget.
 */
export function endSpanAfterPaint(name: string, extra: Record<string, unknown> = {}) {
  const start = spans.get(name);
  if (start === undefined) return;
  spans.delete(name);
  // Called from the commit's effect: the UI thread's own cost so far.
  const commit = Math.round((now() - start) * 10) / 10;
  afterPaint(() => {
    const end = now();
    push(name, end, { dur: Math.round((end - start) * 10) / 10, commit_ms: commit, ...extra });
  });
}

/** Runs `fn` once the next frame has painted. */
export function afterPaint(fn: () => void) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** Records a query from send to rows painted. Returns callbacks for its stages. */
export function startQuery(windowId: string, tabId: number, sql: string) {
  const q: QueryTiming = {
    window: windowId,
    tab: tabId,
    sql: sql.replace(/\s+/g, " ").trim().slice(0, 80),
    runSent: since(now()),
    firstFrame: null,
    firstFramePainted: null,
    allRows: null,
    rows: null,
    elapsedMs: null,
    firstRowMs: null,
  };
  push("run-sent", now(), { window: windowId, tab: tabId });
  const list = queries.get(windowId) ?? [];
  list.push(q);
  if (list.length > MAX_QUERIES) list.shift();
  queries.set(windowId, list);
  return {
    /** Rows arrived. Today the whole result is one frame, so it is also all rows. */
    rows(rows: number, elapsedMs: number | null, firstRowMs: number | null = null) {
      const at = now();
      q.firstFrame = q.allRows = since(at);
      q.rows = rows;
      q.elapsedMs = elapsedMs;
      q.firstRowMs = firstRowMs;
      push("first-frame", at, { window: windowId, tab: tabId });
      push("all-rows", at, { window: windowId, tab: tabId, rows, elapsed_ms: elapsedMs });
      afterPaint(() => {
        const painted = now();
        q.firstFramePainted = since(painted);
        push("first-frame-painted", painted, {
          window: windowId,
          tab: tabId,
          sent: q.runSent,
          run_ms: Math.round((q.firstFramePainted - q.runSent) * 10) / 10,
        });
        void flushTimings();
      });
    },
  };
}

/** The last queries of a window, oldest first (the ⌘K Timings sheet, phase 5). */
export function queryTimings(windowId: string): readonly QueryTiming[] {
  return queries.get(windowId) ?? [];
}

/** Every mark so far, in the order taken. */
export function ledgerLines(): readonly LedgerLine[] {
  return ledger;
}

/**
 * The marks Rust took (the launch window's `socket-warm`, when its session
 * was ready); empty outside Tauri.
 */
export async function rustMarks(): Promise<LedgerLine[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [];
  try {
    const marks = await invoke<{ mark: string; t: number }[]>("rust_marks");
    return (marks ?? []).map((m) => ({ ...m, source: "rust" }));
  } catch {
    return [];
  }
}

let flushing: Promise<void> | null = null;

/** Appends the marks not yet written to ROWKERY_TIMINGS_OUT; no-op when not recording. */
export async function flushTimings(): Promise<void> {
  await ready;
  if (!recording) return;
  // One write in flight; a flush asked for meanwhile picks up its lines next.
  while (flushing) await flushing;
  const lines = ledger.slice(flushed);
  if (lines.length === 0) return;
  flushed = ledger.length;
  flushing = invoke<void>("write_timings", { lines })
    .catch(() => {})
    .finally(() => {
      flushing = null;
    });
  await flushing;
}

// Proofs and DevTools read the ledger without importing the module.
(window as unknown as { __ROWKERY_TIMINGS__: unknown }).__ROWKERY_TIMINGS__ = {
  ledger: ledgerLines,
  queries: queryTimings,
};
