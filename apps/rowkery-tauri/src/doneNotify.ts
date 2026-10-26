import { invoke } from "@tauri-apps/api/core";

/**
 * "Tell me when it's done": a long job that finishes while Rowkery isn't
 * the app in front shows a macOS banner, and a click comes back to its
 * window and tab (`rowkery:notification-open`). The shell shows it only
 * when the window isn't focused and counts it on the dock badge.
 *
 * A banner shows on the lock screen and in screen shares, so it says where
 * and how the job went (connection, tab, rows, time), never the SQL, values
 * or error text.
 */

/** A job shorter than this never gets a banner: the user was likely still watching. */
export const NOTIFY_AFTER_MS = 10_000;

/** What a banner's click opens. */
export interface DoneTarget {
  windowId?: string;
  tabId?: number;
  /** A proposal's id: its review. */
  proposal?: string;
}

export interface DoneBanner {
  title: string;
  body: string;
  target: DoneTarget;
}

/** "48.2 s", "1:12", "1:02:05". */
export function bannerTime(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const rows = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

export interface QueryJob {
  connection: string;
  tab: string;
  ms: number;
  rows: number | null;
  failed: boolean;
  /** Run all: how many statements ran (the last is the one that failed). */
  statements?: number;
  /** A timed plan (Explain with timings). */
  plan?: boolean;
}

/** "Query finished · shop-prd" / "Monthly revenue · 37 rows in 48.2 s". */
export function queryBanner(job: QueryJob, target: DoneTarget): DoneBanner {
  const what = job.plan ? "Timed plan" : "Query";
  const time = bannerTime(job.ms);
  const n = job.statements;
  let body: string;
  if (job.failed) body = n ? `${job.tab} · stopped at statement ${n} after ${time}` : `${job.tab} · stopped after ${time}`;
  else if (n) body = `${job.tab} · ${n} ${n === 1 ? "statement" : "statements"} in ${time}`;
  else body = job.rows === null ? `${job.tab} · ${time}` : `${job.tab} · ${rows(job.rows)} in ${time}`;
  return { title: `${what} ${job.failed ? "failed" : "finished"} · ${job.connection}`, body, target };
}

/** "Import finished · shop-stg" / "120,000 rows into orders in 2:41". */
export function importBanner(
  job: { connection: string; ms: number; rows: number; table: string | null; failed: boolean },
  target: DoneTarget,
): DoneBanner {
  const into = job.table ? ` into ${job.table}` : "";
  return {
    title: `Import ${job.failed ? "failed" : "finished"} · ${job.connection}`,
    body: job.failed ? `Stopped after ${bannerTime(job.ms)}` : `${rows(job.rows)}${into} in ${bannerTime(job.ms)}`,
    target,
  };
}

/** "SQL file finished · shop-stg" / "seed.sql · 1,204 statements in 3:07". */
export function sqlFileBanner(
  job: {
    connection: string;
    file: string;
    ms: number;
    statements: number;
    /** Keep going: the statements that failed along the way (a count, never their text). */
    errors?: number;
    failed: boolean;
    line?: number | null;
  },
  target: DoneTarget,
): DoneBanner {
  const time = bannerTime(job.ms);
  const n = job.statements;
  return {
    title: `SQL file ${job.failed ? "failed" : "finished"} · ${job.connection}`,
    body: job.failed
      ? job.line != null
        ? `${job.file} · stopped at line ${job.line.toLocaleString("en-US")} after ${time}`
        : `${job.file} · stopped after ${time}`
      : `${job.file} · ${n.toLocaleString("en-US")} ${n === 1 ? "statement" : "statements"}${
          job.errors ? `, ${job.errors.toLocaleString("en-US")} failed` : ""
        } in ${time}`,
    target,
  };
}

/** "Export finished · shop-prd" / "Monthly revenue · 37 rows to revenue.csv in 12.0 s". */
export function exportBanner(
  job: { connection: string; tab: string; ms: number; rows: number; copy: boolean; file?: string; failed: boolean },
  target: DoneTarget,
): DoneBanner {
  const where = job.copy ? " on the clipboard" : job.file ? ` to ${job.file}` : "";
  return {
    title: `${job.copy ? "Copy" : "Export"} ${job.failed ? "failed" : "finished"} · ${job.connection}`,
    body: job.failed
      ? `${job.tab} · stopped after ${bannerTime(job.ms)}`
      : `${job.tab} · ${rows(job.rows)}${where} in ${bannerTime(job.ms)}`,
    target,
  };
}

/** "Change to review · shop-prd" / "Claude Code wants to change 29 rows in orders". */
export function proposalBanner(
  job: { connection: string; client: string; table: string | null; rows?: number; count: number },
  id: string,
): DoneBanner {
  let body: string;
  if (job.count > 1) body = `${job.client} proposed ${job.count} changes`;
  else if (job.table) body = `${job.client} wants to change ${job.rows != null ? `${rows(job.rows)} in ` : ""}${job.table}`;
  else body = `${job.client} wants to make a change`;
  return { title: `${job.count > 1 ? "Changes" : "Change"} to review · ${job.connection}`, body, target: { proposal: id } };
}

/**
 * Sends `banner` for a job that took `ms` (null: no threshold, a proposal).
 * The shell drops it while Rowkery is in front.
 */
export function notifyDone(banner: DoneBanner, ms: number | null) {
  // TEMP diagnostics for the Mac test (removed before merge).
  if ("__TAURI_INTERNALS__" in window)
    void invoke("notify_trace", {
      line: `${banner.title} ms=${ms === null ? "-" : Math.round(ms)} visible=${document.visibilityState} focus=${document.hasFocus()}`,
    }).catch(() => {});
  if (ms !== null && ms < NOTIFY_AFTER_MS) return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  void invoke("notify_done", { ...banner }).catch(() => {});
}
