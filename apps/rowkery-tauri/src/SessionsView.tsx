import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listSessions,
  sessionLocks,
  stopSession,
  type HeldLock,
  type ServerSessionRow,
  type StopKind,
} from "./api";
import { InspectorHead } from "./Inspector";
import { showToast } from "./notify";
import { highlightSqlLines } from "./sqlHighlight";
import {
  blockedChain,
  blockingCounts,
  formatAge,
  oneLine,
  sessionAge,
  shownSessions,
  whoLabel,
} from "./sessionRows";
import "./SessionsView.css";

/**
 * The Sessions tab (2026-10-15: "what's running"): every
 * other client session on the window's Postgres database, what it waits on
 * and who blocks it, refreshed while the tab is in front; pick one to cancel
 * its query or end it. Reads and stops run on a session of the window's own
 * (`Slot::Monitor`), so a tab's transaction is never touched.
 */

/** How often the list refreshes while it shows (decision 1). */
export const REFRESH_MS = 2000;

/** A tab this window has, for "You · fix prices". */
export interface TabLabel {
  id: number;
  title: string;
}

/** A stop waiting for its Review SQL confirmation. */
interface PendingStop {
  pid: number;
  kind: StopKind;
  sql: string;
}

export interface SessionsModel {
  rows: ServerSessionRow[] | null;
  shown: ServerSessionRow[];
  error: string | null;
  showIdle: boolean;
  setShowIdle: (on: boolean) => void;
  /** The row whose details show in the inspector; refresh pauses while one is picked. */
  picked: ServerSessionRow | null;
  pick: (pid: number | null) => void;
  /** The pointer is over the list: refresh waits, so no row moves under a click. */
  setHovering: (on: boolean) => void;
  paused: boolean;
  /** Seconds since the rows were read: ages tick on without a query. */
  secsLater: number;
  locks: HeldLock[] | null;
  pending: PendingStop | null;
  stop: (pid: number, kind: StopKind, confirmed?: boolean) => void;
  cancelPending: () => void;
  stopping: boolean;
}

/** Keeps the list fresh while `live`, and holds what's picked. */
export function useSessions(windowId: string, live: boolean): SessionsModel {
  const [rows, setRows] = useState<ServerSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const [pickedPid, setPickedPid] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const [readAt, setReadAt] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const [locks, setLocks] = useState<HeldLock[] | null>(null);
  const [pending, setPending] = useState<PendingStop | null>(null);
  const [stopping, setStopping] = useState(false);
  const front = useFrontWindow();
  const paused = hovering || pickedPid !== null;
  const reading = useRef(false);

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await listSessions(windowId);
      setRows(next);
      setError(null);
      setReadAt(performance.now());
    } catch (e) {
      setError(String(e));
    } finally {
      reading.current = false;
    }
  }, [windowId]);

  // Every REFRESH_MS while shown, in front and not paused; one read on show.
  const polling = live && front && !paused;
  useEffect(() => {
    if (!polling) return;
    let timer = 0;
    let alive = true;
    const loop = async () => {
      await read();
      if (alive) timer = window.setTimeout(loop, REFRESH_MS);
    };
    void loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [polling, read]);

  // Ages tick each second from the last read.
  useEffect(() => {
    if (!live || !front) return;
    const t = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(t);
  }, [live, front]);

  const picked = useMemo(() => rows?.find((r) => r.pid === pickedPid) ?? null, [rows, pickedPid]);

  // A picked row's table locks, read once when it's picked.
  useEffect(() => {
    setLocks(null);
    if (pickedPid === null || !live) return;
    let alive = true;
    sessionLocks(windowId, pickedPid).then(
      (l) => alive && setLocks(l),
      () => alive && setLocks([]),
    );
    return () => {
      alive = false;
    };
  }, [windowId, pickedPid, live]);

  const pick = useCallback((pid: number | null) => {
    setPickedPid(pid);
    setPending(null);
  }, []);

  const stop = useCallback(
    (pid: number, kind: StopKind, confirmed = false) => {
      setStopping(true);
      stopSession(windowId, pid, kind, confirmed)
        .then((outcome) => {
          if (outcome.status === "held") {
            setPending({ pid, kind, sql: outcome.sql });
            return;
          }
          setPending(null);
          if (outcome.status === "refused") {
            showToast(outcome.message, undefined, "error");
            return;
          }
          const freed = rows ? blockedChain(rows, pid).length : 0;
          const done =
            kind === "end" ? `Ended session ${pid}` : `Cancelled the query in session ${pid}`;
          showToast(
            outcome.gone ? `Session ${pid} had already ended` : done,
            !outcome.gone && freed ? `${freed} unblocked` : undefined,
          );
          if (kind === "end") setPickedPid(null);
          void read();
        })
        .catch((e) => showToast("Couldn't stop the session", String(e), "error"))
        .finally(() => setStopping(false));
    },
    [windowId, rows, read],
  );

  return {
    rows,
    shown: useMemo(() => (rows ? shownSessions(rows, showIdle) : []), [rows, showIdle]),
    error,
    showIdle,
    setShowIdle,
    picked,
    pick,
    setHovering,
    paused,
    secsLater: readAt ? Math.max(0, (now - readAt) / 1000) : 0,
    locks,
    pending,
    stop,
    cancelPending: () => setPending(null),
    stopping,
  };
}

/** The webview is visible and its window hasn't lost focus. */
function useFrontWindow(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return visible && focused;
}

/** The line under the tab row: the idle filter, the count and whether it's live. */
export function SessionsBar({ model }: { model: SessionsModel }) {
  const { rows, shown, showIdle, setShowIdle, paused, error } = model;
  const status = error ? "error" : paused ? "paused" : "live";
  return (
    <div className="sessions-bar" data-sessions-bar>
      <span className="sessions-title">Sessions</span>
      {showIdle ? (
        <button type="button" className="sessions-addchip" data-sessions-hide-idle onClick={() => setShowIdle(false)}>
          Hide idle
        </button>
      ) : (
        <span className="sessions-chip" data-sessions-chip="idle">
          state ≠ idle
          <button type="button" aria-label="Show idle sessions" data-sessions-show-idle onClick={() => setShowIdle(true)}>
            ×
          </button>
        </span>
      )}
      {rows && (
        <span className="sessions-count" data-sessions-count={shown.length}>
          {shown.length === rows.length ? `${rows.length}` : `${shown.length} of ${rows.length}`}
        </span>
      )}
      <span className="sessions-gap" />
      <span className="sessions-live" data-sessions-live={status} title={error ?? undefined}>
        <i aria-hidden />
        {error ? "Couldn't read sessions" : paused ? "Paused while you pick" : "Live"}
      </span>
    </div>
  );
}

/** The list itself. */
export function SessionsGrid({ model, tabs }: { model: SessionsModel; tabs: TabLabel[] }) {
  const { rows, shown, picked, pick, setHovering, secsLater } = model;
  const blocking = useMemo(() => blockingCounts(rows ?? []), [rows]);
  const titleOf = useMemo(() => new Map(tabs.map((t) => [t.id, t.title])), [tabs]);
  const move = (by: number) => {
    if (!shown.length) return;
    const at = picked ? shown.findIndex((r) => r.pid === picked.pid) : -1;
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + by))];
    pick(next.pid);
  };
  return (
    <div
      className="sessions-scroll"
      data-sessions-grid
      tabIndex={0}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Escape" && picked) {
          e.preventDefault();
          e.stopPropagation();
          pick(null);
        }
      }}
    >
      {rows && !shown.length ? (
        <div className="sessions-empty" data-sessions-empty>
          {rows.length ? "Nothing running. Every other session is idle." : "No other sessions on this database."}
        </div>
      ) : (
        <table className="sessions-table">
          <thead>
            <tr>
              <th>pid</th>
              <th>who</th>
              <th>state</th>
              <th className="num">for</th>
              <th>waiting on</th>
              <th>blocked by</th>
              <th className="wide">query</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const ours = r.tab ? titleOf.get(r.tab.tab_id) : undefined;
              const blocks = blocking.get(r.pid) ?? 0;
              const state = r.state ?? "";
              return (
                <tr
                  key={r.pid}
                  data-session-row={r.pid}
                  data-session-picked={picked?.pid === r.pid ? "" : undefined}
                  onClick={() => pick(picked?.pid === r.pid ? null : r.pid)}
                >
                  <td className="num">{r.pid}</td>
                  <td className="who">
                    {ours !== undefined ? (
                      <span className="sessions-tag you" data-session-you>
                        You · {ours}
                      </span>
                    ) : (
                      whoLabel(r)
                    )}
                  </td>
                  <td>
                    {state.startsWith("idle in transaction") ? <span className="sessions-tag idle">{state}</span> : state}
                  </td>
                  <td className="num">{formatAge(sessionAge(r, secsLater))}</td>
                  <td>
                    {r.wait ? (
                      <span className={`sessions-tag ${r.wait.startsWith("Lock") ? "lock" : "wait"}`}>{r.wait}</span>
                    ) : (
                      <span className="sessions-none">·</span>
                    )}
                  </td>
                  <td>
                    {r.blocked_by.length ? (
                      r.blocked_by.map((b) => (
                        <button
                          key={b}
                          type="button"
                          className="sessions-pid"
                          data-session-blocker={b}
                          title={`Show session ${b}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(b);
                          }}
                        >
                          {b}
                        </button>
                      ))
                    ) : blocks ? (
                      <span className="sessions-blocking" data-session-blocking={blocks}>
                        blocking {blocks}
                      </span>
                    ) : (
                      <span className="sessions-none">·</span>
                    )}
                  </td>
                  <td className="wide query" title={r.query ?? undefined}>
                    {r.query === null ? <span className="sessions-none">Not visible to your login</span> : oneLine(r.query)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The inspector's view of the picked session, and the stop confirmation. */
export function SessionDetail({
  model,
  tabs,
  windowId,
  onGoToTab,
}: {
  model: SessionsModel;
  tabs: TabLabel[];
  windowId: string;
  onGoToTab: (tabId: number) => void;
}) {
  const { picked, rows, locks, pending, stop, cancelPending, pick, stopping, secsLater } = model;
  const sqlHtml = useMemo(
    () => (pending ? highlightSqlLines(pending.sql) : picked?.query ? highlightSqlLines(picked.query) : []).join("\n"),
    [pending, picked?.query],
  );
  if (!picked) return null;
  const ourTab = picked.tab?.window_id === windowId ? tabs.find((t) => t.id === picked.tab?.tab_id) : undefined;
  const chain = rows ? blockedChain(rows, picked.pid) : [];
  const xact = picked.xact_secs === null ? null : picked.xact_secs + secsLater;
  const noStop = picked.can_stop ? undefined : "Your login can't stop this session";
  if (pending) {
    const ending = pending.kind === "end";
    return (
      <>
        <InspectorHead onClose={cancelPending}>
          <h2 className="insp-title">Review SQL</h2>
        </InspectorHead>
        <div className="session-detail" data-session-confirm={pending.kind}>
          <pre className="session-sql" dangerouslySetInnerHTML={{ __html: sqlHtml }} />
          <dl className="session-facts">
            <dt>{ending ? "Ends" : "Stops"}</dt>
            <dd>{ourTab ? `your tab “${ourTab.title}”` : whoLabel(picked) || `session ${picked.pid}`}</dd>
            {ending && xact !== null && (
              <>
                <dt>Rolls back</dt>
                <dd>{formatAge(xact)} open transaction</dd>
              </>
            )}
            {chain.length > 0 && (
              <>
                <dt>Unblocks</dt>
                <dd>
                  {chain.length} {chain.length === 1 ? "session" : "sessions"}
                </dd>
              </>
            )}
          </dl>
        </div>
        <footer className="insp-foot">
          <button type="button" className="insp-btn" onClick={cancelPending}>
            Back
          </button>
          <span className="insp-gap" />
          <button
            type="button"
            className="insp-btn ink"
            data-session-confirm-run
            disabled={stopping}
            onClick={() => stop(pending.pid, pending.kind, true)}
          >
            {ending ? "End session" : "Cancel query"}
          </button>
        </footer>
      </>
    );
  }
  return (
    <>
      <InspectorHead onClose={() => pick(null)}>
        <h2 className="insp-title">Session {picked.pid}</h2>
      </InspectorHead>
      <div className="session-detail" data-session-detail={picked.pid}>
        <dl className="session-facts">
          <dt>Who</dt>
          <dd>{ourTab ? `${picked.user ?? "you"} · your tab “${ourTab.title}”` : whoLabel(picked) || "unknown"}</dd>
          {picked.client && (
            <>
              <dt>From</dt>
              <dd>{picked.client}</dd>
            </>
          )}
          <dt>State</dt>
          <dd>{picked.state ?? "unknown"}</dd>
          {xact !== null && (
            <>
              <dt>Transaction</dt>
              <dd>open {formatAge(xact)}</dd>
            </>
          )}
          {picked.wait && (
            <>
              <dt>Waiting on</dt>
              <dd>{picked.wait}</dd>
            </>
          )}
          {picked.blocked_by.length > 0 && (
            <>
              <dt>Blocked by</dt>
              <dd>{picked.blocked_by.join(", ")}</dd>
            </>
          )}
          {chain.length > 0 && (
            <>
              <dt>Blocking</dt>
              <dd data-session-chain={chain.length}>{chain.join(", ")}</dd>
            </>
          )}
          {locks && locks.length > 0 && (
            <>
              <dt>Holds</dt>
              <dd>
                {locks.map((l) => (
                  <div key={`${l.table} ${l.mode}`}>
                    {l.table}, {l.mode}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
        {picked.query === null ? (
          <p className="session-hidden">Your login can't read this session's query.</p>
        ) : (
          <pre className="session-sql" dangerouslySetInnerHTML={{ __html: sqlHtml }} />
        )}
      </div>
      <footer className="insp-foot">
        {ourTab && (
          <button type="button" className="insp-btn" data-session-go onClick={() => onGoToTab(ourTab.id)}>
            Go to tab
          </button>
        )}
        <span className="insp-gap" />
        <button
          type="button"
          className="insp-btn"
          data-session-stop="cancel"
          disabled={!!noStop || stopping || picked.state !== "active"}
          title={noStop ?? (picked.state !== "active" ? "No query is running in this session" : undefined)}
          onClick={() => stop(picked.pid, "cancel")}
        >
          Cancel query
        </button>
        <button
          type="button"
          className="insp-btn ink"
          data-session-stop="end"
          disabled={!!noStop || stopping}
          title={noStop}
          onClick={() => stop(picked.pid, "end")}
        >
          End session
        </button>
      </footer>
    </>
  );
}
