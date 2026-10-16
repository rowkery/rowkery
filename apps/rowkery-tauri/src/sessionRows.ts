import type { ServerSessionRow } from "./api";

/**
 * The Sessions tab's rows: what needs you first (sessions blocking others,
 * then those waiting on a lock, then the longest running), idle sessions
 * hidden unless asked for, and how long each has been at what it's doing.
 */

/** Seconds the row has been at what it's doing, `secsLater` after it was read. */
export function sessionAge(row: ServerSessionRow, secsLater = 0): number | null {
  const state = row.state ?? "";
  const base = state === "active" ? row.query_secs : state.startsWith("idle in transaction") ? row.xact_secs : row.state_secs;
  return base === null ? null : base + secsLater;
}

/** 0.4s, 38.2s, 4m 12s, 2h 03m. */
export function formatAge(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return "";
  const s = Math.max(0, secs);
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** How many sessions wait on each pid. */
export function blockingCounts(rows: ServerSessionRow[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of rows) for (const pid of r.blocked_by) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  return counts;
}

/** Every session waiting, directly or down the chain, on `pid`. */
export function blockedChain(rows: ServerSessionRow[], pid: number): number[] {
  const out: number[] = [];
  const seen = new Set([pid]);
  let frontier = [pid];
  while (frontier.length) {
    const next: number[] = [];
    for (const r of rows) {
      if (seen.has(r.pid) || !r.blocked_by.some((b) => frontier.includes(b))) continue;
      seen.add(r.pid);
      out.push(r.pid);
      next.push(r.pid);
    }
    frontier = next;
  }
  return out;
}

const isIdle = (r: ServerSessionRow) => r.state === "idle";

/** The rows shown, in order; `total` counts them all. */
export function shownSessions(rows: ServerSessionRow[], showIdle: boolean): ServerSessionRow[] {
  const blocking = blockingCounts(rows);
  const rank = (r: ServerSessionRow) => ((blocking.get(r.pid) ?? 0) > 0 ? 0 : r.blocked_by.length ? 1 : 2);
  return rows
    .filter((r) => showIdle || !isIdle(r))
    .sort((a, b) => rank(a) - rank(b) || (sessionAge(b) ?? -1) - (sessionAge(a) ?? -1) || a.pid - b.pid);
}

/** The application without a Rowkery session's tag: `Rowkery 0a1b2c3d` reads `Rowkery`. */
export function applicationName(row: ServerSessionRow): string {
  return row.rowkery_tag ? row.application.slice(0, -row.rowkery_tag.length - 1) : row.application;
}

/** `alice · psql`; just the one that's known. */
export function whoLabel(row: ServerSessionRow): string {
  return [row.user, applicationName(row)].filter(Boolean).join(" · ");
}

/** The query on one line. */
export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
