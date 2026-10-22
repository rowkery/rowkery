import { useSyncExternalStore, type ReactNode } from "react";
import { TableIcon } from "./icons";
import { ResultRows, useResultRows } from "./resultStore";
import type { TabRun } from "./workspaceTabs";

/** "1,400 rows ·" in the results header while a query streams; re-renders on its own. */
export function RowsSoFar({ rows }: { rows: ResultRows }) {
  const n = useResultRows(rows);
  return (
    <span data-rows-so-far={n}>
      {n.toLocaleString()} {n === 1 ? "row" : "rows"} ·{" "}
    </span>
  );
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
export function Elapsed({ since, active, format }: { since: number; active: boolean; format: (ms: number) => string }) {
  const now = useSyncExternalStore(active ? subscribeClock : noSubscribe, clockNow);
  return <>{format(Math.max(0, Math.max(now, since) - since))}</>;
}

const formatRunningTab = (ms: number) => formatTabTime(ms);

/**
 * A query tab's title with its run: a spinner and the elapsed time while it
 * runs, then a green or red dot for how it ended and how long it took, both
 * kept until the next run.
 */
export function TabStatus({
  run,
  table,
  active,
  spinning = false,
  children,
}: {
  run?: TabRun;
  /** The import tab while its import runs (it has no query run). */
  spinning?: boolean;
  table: boolean;
  /** The window is shown: a running tab's time ticks. */
  active: boolean;
  children: ReactNode;
}) {
  const running = spinning || run?.startedAt != null;
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
      {running && run?.startedAt != null ? (
        <span data-testid="query-tab-time" className="query-tab-time">
          <Elapsed since={run.startedAt} active={active} format={formatRunningTab} />
        </span>
      ) : running ? null : (
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
