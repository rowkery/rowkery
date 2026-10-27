import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { databaseHealth, type HealthCheck, type HealthReport, type SlowQuery } from "./api";
import { RefreshIcon } from "./icons";
import { InspectorHead } from "./Inspector";
import {
  CHECK_NAME,
  CHECK_WHY,
  FIX_NOTE,
  FIX_TITLE,
  SEVERITY_HINT,
  SEVERITY_LABEL,
  findingText,
  fineLabel,
  fixSql,
  formatDate,
  formatQueryMs,
  foundChecks,
  itemLabel,
  itemValue,
  percent,
  pgssSteps,
  soonToast,
} from "./healthText";
import { hasPendingUndo, liveOffer, showOfferToast } from "./notify";
import { readKey, writeKey } from "./persist";
import { oneLine } from "./sessionRows";
import { highlightSqlLines } from "./sqlHighlight";
import { formatBytes, formatRowCount } from "./types";
import "./HealthView.css";

/**
 * The Health tab (2026-10-22 plan, built 2026-10-26): what will hurt soon on
 * the window's database, from the catalog and statistics only. It reads once
 * when the tab first shows and again on Refresh, never on a timer. A finding
 * opens in the inspector with its numbers, how far to trust it and the SQL
 * that fixes it; the SQL only ever opens in a query tab, where safe mode
 * applies.
 */

/** What the inspector shows. A slow query is picked by its text and login, so a Refresh that reorders them keeps it. */
export type HealthPick =
  | { kind: "check"; check: HealthCheck["check"] }
  | { kind: "query"; query: string; user: string | null }
  | { kind: "pgss" };

export interface HealthModel {
  report: HealthReport | null;
  error: string | null;
  reading: boolean;
  /** When the report was read (local time). */
  readAt: Date | null;
  refresh: () => void;
  /** The pick, only while the report still has it (a Refresh can clear a finding). */
  picked: HealthPick | null;
  pick: (p: HealthPick | null) => void;
}

/** The picked slow query in `report`, if it is still listed. */
export function pickedQuery(report: HealthReport, p: HealthPick): SlowQuery | undefined {
  if (p.kind !== "query" || report.slow_queries.state !== "ranked") return undefined;
  return report.slow_queries.queries.find((q) => q.query === p.query && q.user === p.user);
}

/** Whether the report still has what `p` points at. */
function stillThere(report: HealthReport, p: HealthPick): boolean {
  switch (p.kind) {
    case "check":
      return report.checks.some((c) => c.check === p.check && c.state === "found" && c.items.length > 0);
    case "query":
      return !!pickedQuery(report, p);
    case "pgss":
      return report.slow_queries.state === "off";
  }
}

/**
 * Reads once when `live` first turns on for `source` (the window's
 * connection and database), again on `refresh`; a new source starts over.
 */
export function useHealth(windowId: string, live: boolean, source: string): HealthModel {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [picked, setPicked] = useState<HealthPick | null>(null);
  const readFor = useRef<string | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const read = useCallback(() => {
    const asked = sourceRef.current;
    readFor.current = asked;
    setReading(true);
    databaseHealth(windowId)
      .then((next) => {
        if (sourceRef.current !== asked) return;
        setReport(next);
        setError(null);
        setReadAt(new Date());
        setPicked((p) => (p && stillThere(next, p) ? p : null));
      })
      .catch((e) => sourceRef.current === asked && setError(String(e)))
      .finally(() => sourceRef.current === asked && setReading(false));
  }, [windowId]);

  useEffect(() => {
    if (readFor.current === source) return;
    if (readFor.current !== null) {
      setReport(null);
      setError(null);
      setPicked(null);
      setReading(false);
      readFor.current = null;
    }
    if (live) read();
  }, [live, source, read]);

  const shown = report && picked && stillThere(report, picked) ? picked : null;
  return { report, error, reading, readAt, refresh: read, picked: shown, pick: setPicked };
}

/** Connection id → the day (YYYY-MM-DD, local) Health last looked for "Soon". */
const SOON_KEY = "rowkery.healthSoonDay";
/** Lets the window's own reads (the schema, a restored tab) go first. */
const SOON_DELAY_MS = 4000;
/** While an Undo or another offer is on screen, look again this often. */
const SOON_WAIT_MS = 2000;
/** …for a minute at most; the finding is still in the tab after that. */
const SOON_WAITS = 30;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function soonDays(): Record<string, string> {
  const v = readKey(SOON_KEY);
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

/**
 * Decision 2: without opening the tab, Health speaks up only for a "Soon"
 * finding (ids running out, transaction age, a slot filling the disk), and
 * looks at most once a day per connection, a few seconds after the window
 * connects. The day counts only once a read came back. The toast waits for
 * an Undo or another offer to leave, and stays quiet while the Health tab
 * shows. Its button opens the tab; it never takes ↵.
 */
export function useSoonToast(
  windowId: string,
  connectionId: string | null,
  ready: boolean,
  onHealthTab: boolean,
  onShow: () => void,
) {
  const showRef = useRef(onShow);
  showRef.current = onShow;
  const onTabRef = useRef(onHealthTab);
  onTabRef.current = onHealthTab;
  const connRef = useRef(connectionId);
  connRef.current = connectionId;
  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !connectionId || inFlight.current === connectionId) return;
    if (soonDays()[connectionId] === today()) return;
    const timer = window.setTimeout(() => {
      if (soonDays()[connectionId] === today() || inFlight.current === connectionId) return;
      // Started, it runs to the end: going busy or inactive meanwhile doesn't drop it.
      inFlight.current = connectionId;
      databaseHealth(windowId).then(
        (report) => {
          inFlight.current = null;
          const day = today();
          // Only today's entries are worth keeping.
          const kept = Object.fromEntries(Object.entries(soonDays()).filter(([, d]) => d === day));
          writeKey(SOON_KEY, { ...kept, [connectionId]: day });
          const message = report ? soonToast(report) : null;
          if (!message) return;
          let waits = SOON_WAITS;
          const show = () => {
            if (connRef.current !== connectionId || onTabRef.current) return;
            if (hasPendingUndo() || liveOffer()) {
              if (waits-- > 0) window.setTimeout(show, SOON_WAIT_MS);
              return;
            }
            showOfferToast(message, "Show health", undefined, { run: () => showRef.current(), mouseOnly: true });
          };
          show();
        },
        () => {
          inFlight.current = null;
        },
      );
    }, SOON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [windowId, connectionId, ready]);
}

/** The line under the tab row: what was read, when, and Refresh. */
export function HealthBar({ model }: { model: HealthModel }) {
  const { report, readAt, reading, refresh, error } = model;
  const time = readAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="sessions-bar" data-health-bar>
      <span className="sessions-title">Health</span>
      {report && (
        <span className="health-source" data-health-source>
          {report.database} · {report.server}
          {time ? ` · read at ${time}` : ""}
        </span>
      )}
      <span className="sessions-gap" />
      {error && (
        <span className="health-error-word" data-health-error title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        className="insp-btn health-refresh"
        data-health-refresh
        disabled={reading}
        onClick={refresh}
      >
        <RefreshIcon size={13} />
        {reading ? "Reading…" : "Refresh"}
      </button>
    </div>
  );
}

function Tile({ label, value, line, name }: { label: string; value: string; line: string; name: string }) {
  return (
    <div className="health-tile" data-health-tile={name}>
      <span className="health-tile-label">{label}</span>
      <span className="health-tile-value">{value}</span>
      <span className="health-tile-line">{line}</span>
    </div>
  );
}

function Tiles({ report }: { report: HealthReport }) {
  const days =
    report.stats_since === null ? null : Math.max(0, Math.round((Date.now() / 1000 - report.stats_since) / 86_400));
  return (
    <div className="health-tiles">
      {report.size && (
        <Tile
          name="size"
          label="Size"
          value={formatBytes(report.size.total_bytes)}
          line={
            report.size.table_bytes === null || report.size.index_bytes === null
              ? "the whole file"
              : `tables ${formatBytes(report.size.table_bytes)} · indexes ${formatBytes(report.size.index_bytes)}`
          }
        />
      )}
      {report.cache_hit !== null && (
        <Tile name="cache" label="Cache hits" value={percent(report.cache_hit)} line="reads served from memory" />
      )}
      {report.connections && (
        <Tile
          name="connections"
          label="Connections"
          value={`${report.connections.used} / ${report.connections.max}`}
          line={`${report.connections.active} active now`}
        />
      )}
      {report.stats_since !== null && days !== null && (
        <Tile
          name="stats"
          label="Stats since"
          value={formatDate(report.stats_since)}
          line={`${days} ${days === 1 ? "day" : "days"} of usage`}
        />
      )}
    </div>
  );
}

/** The tab's sheet: tiles, what needs attention, the slowest queries, what's fine. */
export function HealthBody({ model }: { model: HealthModel }) {
  const { report, error, picked, pick } = model;
  const found = useMemo(() => (report ? foundChecks(report) : []), [report]);
  if (!report) {
    return (
      <div className="health-scroll" data-health-body>
        <div className="sessions-empty" data-health-empty>
          {error ?? "Reading the catalog…"}
        </div>
      </div>
    );
  }
  const fine = report.checks.filter((c) => c.state === "fine");
  const unchecked = report.checks.filter((c) => c.state === "needs_role" || c.state === "unavailable");
  const slow = report.slow_queries;
  return (
    <div
      className="health-scroll"
      data-health-body
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape" && picked) {
          e.preventDefault();
          e.stopPropagation();
          pick(null);
        }
      }}
    >
      <Tiles report={report} />

      <h3 className="health-h">
        Needs attention <span className="health-count">{found.length}</span>
      </h3>
      {found.length ? (
        <div className="health-cards">
          {found.map((c) => {
            const text = findingText(c, report);
            const on = picked?.kind === "check" && picked.check === c.check;
            return (
              <button
                key={c.check}
                type="button"
                className="health-card"
                data-health-check={c.check}
                data-health-picked={on ? "" : undefined}
                aria-pressed={on}
                onClick={() => pick(on ? null : { kind: "check", check: c.check })}
              >
                <span className={`health-sev ${c.severity}`} title={SEVERITY_HINT[c.severity]}>
                  {SEVERITY_LABEL[c.severity]}
                </span>
                <span className="health-card-text">
                  <span className="health-card-title">{text.title}</span>
                  <span className="health-card-line">{text.line}</span>
                </span>
                <span className="health-card-weight">{text.weight}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="health-quiet" data-health-nothing>
          Nothing needs attention.
        </p>
      )}

      {slow.state !== "none" && (
        <>
          <h3 className="health-h">
            Slowest queries <span className="health-sub">from pg_stat_statements · share of total time</span>
          </h3>
          {slow.state === "ranked" ? (
            slow.queries.length ? (
              <table className="sessions-table health-queries" data-health-queries>
                <thead>
                  <tr>
                    <th className="wide">query</th>
                    <th className="num">mean</th>
                    <th className="num">calls</th>
                    <th>time</th>
                  </tr>
                </thead>
                <tbody>
                  {slow.queries.map((q, i) => {
                    const on = picked?.kind === "query" && picked.query === q.query && picked.user === q.user;
                    const toggle = () => pick(on ? null : { kind: "query", query: q.query, user: q.user });
                    return (
                      <tr
                        key={i}
                        data-health-query={i}
                        data-session-picked={on ? "" : undefined}
                        tabIndex={0}
                        aria-selected={on}
                        onClick={toggle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle();
                          }
                        }}
                      >
                        <td className="wide query" title={q.query}>
                          {oneLine(q.query)}
                        </td>
                        <td className="num">{formatQueryMs(q.mean_ms)}</td>
                        <td className="num">{formatRowCount(q.calls)}</td>
                        <td>
                          <span className="health-bar" role="img" aria-label={percent(q.share)} title={percent(q.share)}>
                            <i style={{ width: `${Math.max(2, Math.round(q.share * 100))}%` }} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="health-quiet">No queries recorded yet.</p>
            )
          ) : slow.state === "off" ? (
            <p className="health-quiet" data-health-pgss-off>
              pg_stat_statements is off on this database.{" "}
              <button type="button" className="health-link" data-health-pgss-how onClick={() => pick({ kind: "pgss" })}>
                How to turn it on
              </button>
            </p>
          ) : (
            <p className="health-quiet" data-health-pgss-hidden>
              {slow.state === "needs_role" ? `Your login needs ${slow.role} to read them.` : slow.message}
            </p>
          )}
          {slow.state === "ranked" && slow.partial && (
            <p className="health-quiet">These are only your login's queries. Seeing every login's needs pg_monitor.</p>
          )}
        </>
      )}

      {fine.length > 0 && (
        <>
          <h3 className="health-h">Fine</h3>
          <ul className="health-fine" data-health-fine>
            {fine.map((c) => (
              <li key={c.check} data-health-fine-check={c.check}>
                {fineLabel(c.check, report)}
              </li>
            ))}
          </ul>
        </>
      )}
      {unchecked.length > 0 && (
        <>
          <h3 className="health-h">Not checked</h3>
          <ul className="health-unchecked" data-health-unchecked>
            {unchecked.map((c) => (
              <li key={c.check} data-health-unchecked-check={c.check}>
                {CHECK_NAME[c.check]}:{" "}
                {c.state === "needs_role" ? `your login needs ${c.role}` : c.state === "unavailable" ? c.message : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Sql({ sql }: { sql: string }) {
  const html = useMemo(() => highlightSqlLines(sql).join("\n"), [sql]);
  return <pre className="session-sql" data-health-sql dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The inspector's view of a finding, a slow query or the pg_stat_statements steps. */
export function HealthDetail({
  model,
  onOpenSql,
  onShowSessions,
}: {
  model: HealthModel;
  onOpenSql: (sql: string, title: string) => void;
  onShowSessions: () => void;
}) {
  const { report, picked, pick } = model;
  if (!report || !picked) return null;
  const close = () => pick(null);

  if (picked.kind === "pgss") {
    const loaded = report.slow_queries.state === "off" && report.slow_queries.loaded;
    const steps = pgssSteps(loaded);
    return (
      <>
        <InspectorHead onClose={close}>
          <h2 className="insp-title">Turn on pg_stat_statements</h2>
        </InspectorHead>
        <div className="session-detail" data-health-detail="pgss">
          <p className="health-why">
            Postgres counts the time each query takes once this extension is on. It adds a little overhead to every
            query.
          </p>
          {steps.map((s) => (
            <div key={s.where} className="health-step">
              <span className="health-step-where">{s.where}</span>
              {s.sql ? <Sql sql={s.how} /> : <span className="health-step-how">{s.how}</span>}
            </div>
          ))}
        </div>
        <footer className="insp-foot">
          <span className="insp-gap" />
          <button
            type="button"
            className="insp-btn"
            data-health-open
            onClick={() => onOpenSql("CREATE EXTENSION pg_stat_statements;", "pg_stat_statements")}
          >
            Open in query tab
          </button>
        </footer>
      </>
    );
  }

  if (picked.kind === "query") {
    const q = pickedQuery(report, picked);
    if (!q) return null;
    return (
      <>
        <InspectorHead onClose={close}>
          <h2 className="insp-title">{percent(q.share)} of query time</h2>
        </InspectorHead>
        <div className="session-detail" data-health-detail="query">
          <dl className="session-facts">
            <dt>Mean</dt>
            <dd>{formatQueryMs(q.mean_ms)}</dd>
            <dt>Calls</dt>
            <dd>{q.calls.toLocaleString("en-US")}</dd>
            <dt>Total</dt>
            <dd>{formatQueryMs(q.total_ms)}</dd>
            <dt>Rows</dt>
            <dd>{q.rows.toLocaleString("en-US")}</dd>
            {q.user && (
              <>
                <dt>Login</dt>
                <dd>{q.user}</dd>
              </>
            )}
          </dl>
          <Sql sql={q.query} />
          <p className="health-trust">
            Values show as $1, $2: fill them in before you run it or look at its plan.
          </p>
        </div>
        <footer className="insp-foot">
          <span className="insp-gap" />
          <button type="button" className="insp-btn" data-health-open onClick={() => onOpenSql(q.query, "Slow query")}>
            Open in query tab
          </button>
        </footer>
      </>
    );
  }

  const check = report.checks.find(
    (c): c is HealthCheck & { state: "found" } => c.check === picked.check && c.state === "found",
  );
  if (!check) return null;
  const text = findingText(check, report);
  const sql = fixSql(check);
  const note = FIX_NOTE[check.check];
  return (
    <>
      <InspectorHead onClose={close}>
        <h2 className="insp-title">{text.title}</h2>
      </InspectorHead>
      <div className="session-detail" data-health-detail={check.check}>
        <p className="health-why">{CHECK_WHY[check.check]}</p>
        <table className="health-items">
          <tbody>
            {check.items.map((item, i) => (
              <tr key={i} data-health-item={itemLabel(item)}>
                <td className="health-item-name" title={itemLabel(item)}>
                  {itemLabel(item)}
                  {item.detail.kind === "duplicate_index" && (
                    <span className="health-item-sub">covered by {item.detail.covered_by}</span>
                  )}
                </td>
                <td className="num">{itemValue(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="health-trust" data-health-trust>
          {check.trust}
        </p>
        {sql && <Sql sql={sql} />}
        {sql && note && <p className="health-note">{note}</p>}
      </div>
      <footer className="insp-foot">
        <span className="insp-gap" />
        {check.check === "long_transactions" && (
          <button type="button" className="insp-btn" data-health-sessions onClick={onShowSessions}>
            Show in Sessions
          </button>
        )}
        {sql && (
          <button
            type="button"
            className="insp-btn"
            data-health-open
            onClick={() => onOpenSql(sql, FIX_TITLE[check.check])}
          >
            Open in query tab
          </button>
        )}
      </footer>
    </>
  );
}
