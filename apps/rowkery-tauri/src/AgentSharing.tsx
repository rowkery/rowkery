import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { showToast, toastPreview } from "./notify";
import { isMacPlatform } from "./platform";
import { GESTURES, gestureKeys, keysFor } from "./commands";
import { McpConnectSheet } from "./McpConnectSheet";
import {
  MCP_LIMITS,
  bytesLabel,
  clearMcp,
  maskHost,
  mcpSample,
  mcpShared,
  mcpStats,
  shareDuration,
  shareUntil,
  sinceLabel,
  useMcpEntries,
  verdictOf,
  type McpEntry,
  type McpSample,
} from "./mcpActivity";
import {
  accessOf,
  accessSummary,
  columnName,
  looksPersonal,
  withMasked,
  loadedTablesOf,
  ownDatabase,
  closePicker,
  pickDatabases,
  pickTables,
  setTables as withTables,
  sharedCount,
  tableName,
  tableShared,
  type PickDatabase,
  type PickTable,
} from "./mcpAccess";
import { CONNECTION_ENVS, type ConnectionRecord, type MaskedColumns, type McpAccess, type McpDbAccess } from "./types";
import "./AgentsPage.css";
import { Keys } from "./Keys";

/**
 * Settings › Agents (2026-10-17): the one-off half of agents, moved off the
 * Agents page, which keeps the log and the proposed changes. The connection
 * cards (each one's switch, how long, and what it shares), Connect an agent
 * under the head, What can the agent do as a sheet, and the log's upkeep.
 * Edit access takes the cards' place (databases, then tables to tick). Esc
 * closes the sheet, then Edit access, then (Settings') the page.
 */
export function AgentSharing({
  connect,
  onConnect,
  connections,
  editing,
  fillEditing,
  onEdit,
  onSetAllow,
  onStopAll,
  onSetAccess,
  onSetMasked,
}: {
  /** Connect an agent is open under the head. */
  connect: boolean;
  onConnect: (open: boolean) => void;
  connections: ConnectionRecord[];
  /** The connection whose Edit access is open, in the cards' place. */
  editing: string | null;
  /** Sharing was just turned on: Edit access ticks the own database's tables. */
  fillEditing?: boolean;
  onEdit: (connectionId: string | null) => void;
  onSetAllow: (connectionId: string, allow: boolean, until?: number | null) => void;
  /** Stop sharing every shared connection at once. */
  onStopAll: () => void;
  onSetAccess: (connectionId: string, access: McpAccess) => void;
  /** Sensitive columns changed in Edit access: the connection's whole map. */
  onSetMasked: (connectionId: string, masked: MaskedColumns) => void;
}) {
  const entries = useMcpEntries();
  // "12 s ago" stays current while the page is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  const byId = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const shared = connections.filter((c) => mcpShared(c));
  const editConn = editing ? byId.get(editing) : undefined;
  const [canDo, setCanDo] = useState(false);
  const [clearing, setClearing] = useState(false);
  const firstSwitch = useRef<HTMLInputElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Connect an agent owns Esc while it is open (it closes itself); the
    // sheet and Edit access close before Settings does.
    if (connect) return e.stopPropagation();
    if (!canDo && !editing) return;
    e.preventDefault();
    e.stopPropagation();
    if (canDo) setCanDo(false);
    else onEdit(null);
  };

  // The diagram's database: the first shared server, as the agent sees it.
  const host = shared.find((c) => c.kind === "postgres");

  return (
    <div className="ag-sharing" data-testid="agents-sharing" onKeyDown={onKeyDown}>
      <div className="ag-sharing-head">
        <h2 className="st-h2">Agents</h2>
        <span className="mcp-grow" />
        <button type="button" className="mcp-btn quiet" data-ag-can-do aria-haspopup="dialog" onClick={() => setCanDo(true)}>
          What can the agent do
        </button>
        {!connect && (
          <button type="button" className="mcp-btn" data-mcp-connect onClick={() => onConnect(true)}>
            Connect an agent
          </button>
        )}
      </div>
      {connect && (
        <div className="ag-connect" data-testid="ag-connect">
          <McpConnectSheet
            inline
            sharedCount={shared.length}
            onOpenAccess={() => onConnect(false)}
            onClose={() => onConnect(false)}
          />
        </div>
      )}
      {editConn ? (
        <AccessEditor
          key={editConn.id}
          conn={editConn}
          fillOwn={fillEditing}
          onSetAccess={onSetAccess}
          onSetMasked={onSetMasked}
          onDone={() => onEdit(null)}
        />
      ) : (
        <>
          <AccessColumn
            connections={connections}
            entries={entries}
            now={now}
            sharedCount={shared.length}
            firstSwitch={firstSwitch}
            editing={editing}
            onEdit={onEdit}
            onSetAllow={onSetAllow}
            onStopAll={onStopAll}
          />
          <div className="ag-log-upkeep" data-testid="ag-log-upkeep">
            <span className="mcp-muted">
              Activity log: {entries.length.toLocaleString()} {entries.length === 1 ? "call" : "calls"} · responses kept for 24 hours
            </span>
            <span className="mcp-grow" />
            {clearing ? (
              <>
                <button type="button" className="mcp-btn" onClick={() => setClearing(false)}>
                  Keep
                </button>
                <button
                  type="button"
                  className="mcp-btn"
                  data-mcp-clear-confirm
                  onClick={() => {
                    setClearing(false);
                    void clearMcp()
                      .then(() => showToast("MCP log cleared"))
                      .catch((err) => showToast("Couldn't clear the log", String(err), "error"));
                  }}
                >
                  Clear all {entries.length.toLocaleString()}
                </button>
              </>
            ) : (
              entries.length > 0 && (
                <button type="button" className="mcp-btn" data-mcp-clear onClick={() => setClearing(true)}>
                  Clear log
                </button>
              )
            )}
          </div>
        </>
      )}
      {canDo && <CanDoSheet host={host?.kind === "postgres" ? maskHost(host.host) : null} onClose={() => setCanDo(false)} />}
    </div>
  );
}

export function EnvDot({ conn }: { conn: ConnectionRecord | undefined }) {
  return <span className="mcp-dot" data-env={conn?.environment ?? undefined} />;
}

/** The 20% word tag, as the schema panel head prints it. */
export function EnvTag({ conn }: { conn: ConnectionRecord | undefined }) {
  const env = CONNECTION_ENVS.find((e) => e.value === conn?.environment);
  if (!env) return null;
  return (
    <span className="mcp-tag" data-env={env.value}>
      {env.value}
    </span>
  );
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${what}`, toastPreview(text));
  } catch (err) {
    showToast("Couldn't copy", String(err), "error");
  }
}

/**
 * The picked call in full: what was shared when it ran, the arguments as
 * the agent sent them, and the start of what went back.
 */
export function CallDetail({
  entry: e,
  conn,
  canOpen,
  onOpen,
}: {
  entry: McpEntry;
  conn: ConnectionRecord | undefined;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const [sample, setSample] = useState<McpSample | null>(null);
  useEffect(() => {
    let live = true;
    setSample(null);
    void mcpSample(e).then((s) => live && setSample(s?.text ? s : null));
    return () => {
      live = false;
    };
  }, [e]);
  const request = e.args === undefined ? null : typeof e.args === "string" ? e.args : JSON.stringify(e.args, null, 2);
  const verdict = verdictOf(e);
  const answered = verdict === "ok" || verdict === "flagged";
  const scope = e.scope;
  const L = MCP_LIMITS;
  const mac = isMacPlatform();
  return (
    <>
      <div className="mcp-detail" data-testid="mcp-detail">
        {scope && (
          <div className="mcp-box" data-mcp-box="access">
            <h5>
              Access <small>when it ran</small>
            </h5>
            <dl className="mcp-kv">
              <dt>Connection</dt>
              <dd>
                <b>{conn?.name ?? e.connection}</b> <EnvTag conn={conn} />
              </dd>
              {e.database && (
                <>
                  <dt>Database</dt>
                  <dd>
                    <b>{conn?.kind === "sqlite" ? "main" : e.database}</b>{" "}
                    {scope.databases === "all" ? "(every database shared)" : `(${scope.databases} shared)`}
                  </dd>
                </>
              )}
              <dt>Tables</dt>
              <dd>
                {scope.mode === "picked" ? (
                  <>
                    <b>{scope.tables}</b> ticked
                  </>
                ) : scope.tables ? (
                  <>
                    all but <b>{scope.tables}</b>
                  </>
                ) : (
                  <b>all</b>
                )}
              </dd>
              {conn?.kind === "postgres" && (
                <>
                  <dt>Host</dt>
                  <dd>{maskHost(conn.host)}</dd>
                </>
              )}
              <dt>Limits</dt>
              <dd>
                {[
                  scope.max_rows !== undefined ? `${scope.max_rows.toLocaleString()} rows` : null,
                  `${scope.timeout_s ?? L.timeoutSeconds} s`,
                  "read-only",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </dd>
            </dl>
          </div>
        )}
        {request !== null && (
          <div className="mcp-box" data-mcp-box="request">
            <h5>
              Request <small>as sent</small>
            </h5>
            <pre className="mcp-json">
              <JsonText text={request} />
            </pre>
          </div>
        )}
        {answered && (
          <div className="mcp-box" data-mcp-box="response">
            <h5>
              Response{" "}
              <small>
                {sample
                  ? sample.bytes > sample.text.length
                    ? `first ${bytesLabel(sample.text.length)} of ${bytesLabel(sample.bytes)}`
                    : bytesLabel(sample.bytes)
                  : e.bytes !== undefined
                    ? bytesLabel(e.bytes)
                    : ""}
              </small>
            </h5>
            {sample ? (
              <pre className="mcp-json">
                <JsonText text={prettyJson(sample.text)} />
                {sample.bytes > sample.text.length && <span className="mcp-cut"> …</span>}
              </pre>
            ) : (
              <span className="mcp-muted">Not kept</span>
            )}
          </div>
        )}
      </div>
      <div className="mcp-acts">
        {canOpen && (
          <button type="button" className="mcp-btn" data-mcp-open onClick={onOpen}>
            Open in tab <kbd>↵</kbd>
          </button>
        )}
        {e.sql && (
          <button type="button" className="mcp-btn" data-mcp-copy onClick={() => void copyText(e.sql!, "SQL")}>
            Copy SQL <kbd><Keys text={keysFor("copy-cells", mac)} /></kbd>
          </button>
        )}
        {request !== null && (
          <button type="button" className="mcp-btn" data-mcp-copy-request onClick={() => void copyText(request, "request")}>
            Copy request
          </button>
        )}
        {sample && (
          <button type="button" className="mcp-btn" data-mcp-copy-response onClick={() => void copyText(sample.text, "response")}>
            Copy response
          </button>
        )}
      </div>
    </>
  );
}

/**
 * JSON laid out two spaces deep, from text that may stop mid-way (the
 * response is cut at 512 bytes): brackets and commas outside strings break
 * lines; nothing is parsed.
 */
export function prettyJson(text: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  const pad = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      // Short arrays of plain values stay on one line (a row of cells).
      const close = c === "[" ? flatArrayEnd(text, i) : -1;
      if (close > 0) {
        out += text.slice(i, close + 1).replace(/,(?=\S)/g, ", ");
        i = close;
      } else {
        depth++;
        out += c + pad();
      }
    } else if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      out += pad() + c;
    } else if (c === ",") {
      out += "," + pad();
    } else if (c === ":") {
      out += ": ";
    } else if (c !== " " && c !== "\n") {
      out += c;
    }
  }
  return out;
}

/** Where a `[` of only strings, numbers and literals closes, if within 100 chars. */
function flatArrayEnd(text: string, start: number): number {
  let inString = false;
  for (let i = start + 1; i < text.length && i < start + 100; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") return -1;
    else if (c === "]") return i;
  }
  return -1;
}

/** JSON text with keys, strings and numbers coloured; built as nodes, never HTML. */
function JsonText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*"?)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    if (m[1] !== undefined) {
      parts.push(
        <span key={n++} className={m[2] ? "j-k" : "j-s"}>
          {m[1]}
        </span>,
      );
      if (m[2]) parts.push(m[2]);
    } else if (m[3] !== undefined) {
      parts.push(
        <span key={n++} className="j-n">
          {m[3]}
        </span>,
      );
    } else {
      parts.push(
        <span key={n++} className="j-n">
          {m[4]}
        </span>,
      );
    }
    at = re.lastIndex;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function clock(ts: number, seconds = true): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: false,
  });
}

function AccessColumn({
  connections,
  entries,
  now,
  sharedCount,
  firstSwitch,
  editing,
  onEdit,
  onSetAllow,
  onStopAll,
}: {
  connections: ConnectionRecord[];
  entries: McpEntry[];
  now: number;
  sharedCount: number;
  firstSwitch: Ref<HTMLInputElement>;
  editing: string | null;
  onEdit: (connectionId: string | null) => void;
  onSetAllow: (connectionId: string, allow: boolean, until?: number | null) => void;
  onStopAll: () => void;
}) {
  // Shared first, then by name; the order is fixed while the page is up, so
  // a switch doesn't move the card under the pointer.
  const [order] = useState(() =>
    [...connections]
      .sort((a, b) => Number(mcpShared(b)) - Number(mcpShared(a)) || a.name.localeCompare(b.name))
      .map((c) => c.id),
  );
  const list = [
    ...order.map((id) => connections.find((c) => c.id === id)).filter((c): c is ConnectionRecord => !!c),
    ...connections.filter((c) => !order.includes(c.id)),
  ];
  return (
    <div className="ag-col ag-col-access">
      <div className="ag-col-head">
        <h2 className="ag-h2">
          Shared with agents
          <span className="ag-count" data-testid="ag-shared-count">
            {sharedCount === 0 ? "none" : `${sharedCount} of ${connections.length}`}
          </span>
        </h2>
        {sharedCount > 0 && (
          <button type="button" className="mcp-btn ag-stop-all" data-ag-stop-all onClick={onStopAll}>
            Stop all sharing
          </button>
        )}
      </div>
      <div className="mcp-conns" data-testid="mcp-map">
        {list.length === 0 && <p className="mcp-muted mcp-none">No connections yet.</p>}
        {list.map((c, i) => (
          <AccessCard
            key={c.id}
            conn={c}
            stats={mcpStats(entries, c.id, now)}
            now={now}
            editing={editing === c.id}
            switchRef={i === 0 ? firstSwitch : undefined}
            onEdit={onEdit}
            onSetAllow={onSetAllow}
          />
        ))}
      </div>
    </div>
  );
}

const DURATIONS = [
  { id: "off", label: "Until turned off" },
  { id: "hour", label: "1 hour" },
  { id: "today", label: "Today" },
] as const;

/** One connection: its switch, what it shares, how long, and what agents did on it today. */
function AccessCard({
  conn: c,
  stats,
  now,
  editing,
  switchRef,
  onEdit,
  onSetAllow,
}: {
  conn: ConnectionRecord;
  stats: { today: number; refused: number; last: number | null };
  now: number;
  editing: boolean;
  switchRef?: Ref<HTMLInputElement>;
  onEdit: (connectionId: string | null) => void;
  onSetAllow: (connectionId: string, allow: boolean, until?: number | null) => void;
}) {
  const shared = mcpShared(c);
  const ended = !!c.allow_mcp && !shared;
  const duration = shareDuration(c.mcp_until);
  const summary = accessSummary(c);
  // A shared card opens its Edit access; its switch and durations keep their own clicks.
  const open = (e: MouseEvent | KeyboardEvent) => {
    if (!shared || editing || (e.target as HTMLElement).closest("input, button")) return;
    onEdit(c.id);
  };
  return (
    <div
      className="mcp-cn"
      data-mcp-conn={c.id}
      data-mcp-edit={shared ? c.id : undefined}
      data-shared={shared ? "" : undefined}
      data-editing={editing || undefined}
      data-env={c.environment ?? undefined}
      tabIndex={shared ? 0 : undefined}
      aria-label={shared ? `Edit access for ${c.name}` : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        open(e);
      }}
    >
      <span className="mcp-cn-top">
        <EnvDot conn={c} />
        <span className="mcp-cn-name">{c.name}</span>
        <EnvTag conn={c} />
        <input
          ref={switchRef}
          type="checkbox"
          role="switch"
          className="nc-switch"
          data-mcp-allow={c.id}
          aria-label={`Share ${c.name} with agents`}
          checked={shared}
          onChange={(e) => {
            if (!e.target.checked && editing) onEdit(null);
            onSetAllow(c.id, e.target.checked, null);
          }}
        />
      </span>
      <span className="mcp-cn-sub" data-testid="mcp-cn-sub">
        {shared ? (
          <>
            <b>{summary.databases}</b>
            {summary.tables ? ` · ${summary.tables}` : ""}
            {c.mcp_until != null ? ` · until ${untilLabel(c.mcp_until)}` : ""}
          </>
        ) : ended && c.mcp_until != null ? (
          `Sharing ended ${untilLabel(c.mcp_until)}`
        ) : (
          "Not shared"
        )}
      </span>
      {(shared || stats.last !== null) && (
        <span className="mcp-cn-stats" data-testid="mcp-cn-stats">
          <b>{stats.today.toLocaleString()}</b> {stats.today === 1 ? "call" : "calls"} today
          {stats.refused > 0 && (
            <>
              {" · "}
              <b data-refused>{stats.refused.toLocaleString()}</b> refused
            </>
          )}
          {" · last read "}
          <b>{stats.last === null ? "never" : sinceLabel(stats.last, now)}</b>
        </span>
      )}
      {shared && (
        <div className="mcp-cn-row">
          <div className="mcp-mini-seg" role="radiogroup" aria-label={`How long to share ${c.name}`}>
            {DURATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                data-mcp-duration={d.id}
                aria-checked={duration === d.id}
                onClick={() => onSetAllow(c.id, true, d.id === "off" ? null : shareUntil(d.id))}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** "14:30", or "8 Oct 14:30" when not today. */
function untilLabel(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.getHours() === 0 && d.getMinutes() === 0) return "midnight";
  return new Date().toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** "1.2 GB", "310 MB". */
function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB`;
  return bytesLabel(bytes);
}

type Tick = boolean | "mixed";

/** A tick box: on, off, or some of what it stands for. */
function TickBox({ on }: { on: Tick }) {
  return <span className="ag-cb" data-on={on === true || undefined} data-mixed={on === "mixed" || undefined} aria-hidden />;
}

const tickOf = (n: number, of: number): Tick => (n === 0 ? false : n === of ? true : "mixed");

/** Whole-list matching for the filter boxes: every word, in any order. */
function matches(text: string, filter: string): boolean {
  const t = text.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

/**
 * Edit access, in the log's place: the connection's databases on the left
 * (tick to share, pick to list its tables), the picked database's tables on
 * the right by schema. Every tick saves
 * at once; the MCP server reads it on the agent's next call.
 */
function AccessEditor({
  conn,
  fillOwn,
  onSetAccess,
  onSetMasked,
  onDone,
}: {
  conn: ConnectionRecord;
  fillOwn?: boolean;
  onSetAccess: (connectionId: string, access: McpAccess) => void;
  onSetMasked: (connectionId: string, masked: MaskedColumns) => void;
  onDone: () => void;
}) {
  const [dbs, setDbs] = useState<PickDatabase[] | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  // Ticks apply here at once and save in the background.
  const [access, setAccess] = useState<McpAccess | null>(conn.mcp_access ?? null);
  const [picked, setPicked] = useState(() => {
    const shared = conn.mcp_access ? Object.keys(conn.mcp_access) : [];
    return shared.includes(ownDatabase(conn)) || !shared.length ? ownDatabase(conn) : shared.sort()[0];
  });
  const [tables, setTables] = useState<PickTable[] | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [dbFilter, setDbFilter] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  // Sensitive columns: saved like ticks, at once. `columnsOf` is the table
  // whose columns are open beside the list.
  const [masked, setMaskedState] = useState<MaskedColumns>(conn.masked_columns ?? {});
  const [columnsOf, setColumnsOf] = useState<string | null>(null);
  const tableFilterRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const mac = isMacPlatform();
  const filterKeys = gestureKeys(GESTURES.find((g) => g.id === "agents-filter-tables")!, mac);

  // The latest map, for ticks that land after a database's tables load.
  const accessRef = useRef(access);
  // Databases just ticked whose tables tick once listed; unticking drops one.
  const filling = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    doneRef.current?.focus();
    mounted.current = true;
    let live = true;
    // Sharing just turned on: its database's tables tick as a database tick's do.
    const own = ownDatabase(conn);
    const first = conn.mcp_access?.[own];
    if (fillOwn && first?.mode === "picked" && !first.tables?.length) fillTables([own]);
    pickDatabases(conn.id)
      .then((list) => {
        if (!live) return;
        setDbs(list);
        // A connection shared before this map: what the server does for it.
        setAccess((cur) => cur ?? accessOf(conn, list.map((d) => d.name)));
      })
      .catch((err) => live && setDbError(String(err)));
    return () => {
      live = false;
      mounted.current = false;
      filling.current.clear();
      // Done, Esc or leaving the page: don't keep a session per database open.
      void closePicker();
    };
    // Loaded once per connection (the editor is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id]);

  useEffect(() => {
    let live = true;
    setTables(null);
    setTableError(null);
    setColumnsOf(null);
    pickTables(conn.id, picked)
      .then((list) => live && setTables(list))
      .catch((err) => live && setTableError(String(err)));
    return () => {
      live = false;
    };
  }, [conn.id, picked]);

  // A connection saved before the map has none until its databases are
  // listed: a tick before that would save only the picked database and
  // unshare the rest, so nothing ticks until then (or at all, if listing fails).
  const ready = access !== null;
  accessRef.current = access;
  const save = (next: McpAccess) => {
    if (accessRef.current === null) return;
    accessRef.current = next;
    setAccess(next);
    onSetAccess(conn.id, next);
  };
  const ruleOf = (db: string): McpDbAccess | undefined => access?.[db];
  const blank: McpDbAccess = { mode: "picked", tables: [] };

  const shownDbs = (dbs ?? []).filter((d) => matches(d.name, dbFilter));
  const sharedDbs = (dbs ?? []).filter((d) => ruleOf(d.name)).length;
  /**
   * A database ticked on shares every table in it today (an allow list, so a
   * table created later stays hidden until ticked). It's shared with none
   * until they're listed, a few databases at a time.
   */
  function fillTables(names: string[]) {
    const queue = names.filter((db) => !filling.current.has(db));
    for (const db of queue) filling.current.add(db);
    const worker = async () => {
      for (let db = queue.shift(); db !== undefined; db = queue.shift()) {
        if (!filling.current.has(db)) continue;
        let list: PickTable[];
        try {
          list = await pickTables(conn.id, db);
        } catch {
          filling.current.delete(db);
          continue;
        }
        // Gone (Done or Esc): the picker's sessions closed before this one opened.
        if (!mounted.current) return void closePicker();
        if (!filling.current.delete(db)) continue;
        const cur = accessRef.current;
        const rule = cur?.[db];
        if (!cur || !rule || rule.mode !== "picked" || rule.tables?.length) continue;
        save({ ...cur, [db]: { mode: "picked", tables: list.map(tableName) } });
      }
    };
    for (let i = 0; i < Math.min(4, queue.length); i++) void worker();
  }
  const toggleDbs = (names: string[], on: boolean) => {
    const next = { ...(access ?? {}) };
    const added: string[] = [];
    for (const db of names) {
      if (on && !next[db]) {
        next[db] = blank;
        added.push(db);
      } else if (!on) {
        delete next[db];
        filling.current.delete(db);
      }
    }
    if (!ready) return;
    save(next);
    fillTables(added);
  };
  const toggleDb = (db: string, on: boolean) => toggleDbs([db], on);

  const maskedHere = masked[picked] ?? [];
  const setMasked = (names: string[], on: boolean) => {
    const next = withMasked(masked, picked, names, on);
    setMaskedState(next);
    onSetMasked(conn.id, next);
  };
  const maskedIn = (t: PickTable) => (t.columns ?? []).filter((c) => maskedHere.includes(columnName(t, c.name))).length;
  const openTable = (tables ?? []).find((t) => tableName(t) === columnsOf) ?? null;

  const rule = ruleOf(picked);
  const allNames = useMemo(() => (tables ?? []).map(tableName), [tables]);
  const shownTables = (tables ?? []).filter((t) => matches(tableName(t), tableFilter));
  const isShared = (t: PickTable) => !!rule && tableShared(rule, tableName(t));
  const sharedHere = rule ? sharedCount(rule, allNames) : 0;
  const setNames = (names: string[], on: boolean) =>
    save({ ...(access ?? {}), [picked]: withTables(rule ?? blank, names, on) });
  const schemas = useMemo(() => {
    const out = new Map<string, PickTable[]>();
    for (const t of shownTables) out.set(t.schema, [...(out.get(t.schema) ?? []), t]);
    return [...out.entries()];
  }, [shownTables]);
  const shownShared = shownTables.filter(isShared).length;

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      tableFilterRef.current?.focus();
      tableFilterRef.current?.select();
    }
  };

  const dbLabel = (d: PickDatabase) => {
    const r = ruleOf(d.name);
    if (!r) return sizeLabel(d.size_bytes);
    const loaded = loadedTablesOf(conn.id, d.name)?.map(tableName);
    if (loaded) {
      const n = sharedCount(r, loaded);
      return n === loaded.length ? `all ${n}` : `${n} of ${loaded.length}`;
    }
    return r.mode === "picked" ? `${r.tables?.length ?? 0} ticked` : "all";
  };

  return (
    <div className="ag-col ag-col-activity ag-editor" data-testid="mcp-editor" data-mcp-editor={conn.id} onKeyDown={onKeyDown}>
      <div className="ag-col-head">
        <h2 className="ag-h2">
          Access
          <span className="ag-ed-conn">
            <EnvDot conn={conn} />
            {conn.name}
          </span>
          <EnvTag conn={conn} />
        </h2>
        <span className="mcp-grow" />
        <button ref={doneRef} type="button" className="mcp-btn ink" data-mcp-done onClick={onDone}>
          Done
        </button>
      </div>
      <div className="ag-ed-body" data-columns={openTable ? "" : undefined}>
        <div className="ag-ed-dbs">
          <h3 className="ag-h3">
            Databases{" "}
            <b className="ag-count">
              {dbs ? `${sharedDbs} of ${dbs.length}` : ""}
            </b>
          </h3>
          {conn.kind === "postgres" && (
            <input
              className="ag-filter"
              data-ag-db-filter
              type="search"
              placeholder="Filter databases"
              aria-label="Filter databases"
              value={dbFilter}
              onChange={(e) => setDbFilter(e.target.value)}
            />
          )}
          {dbError && <p className="mcp-muted ag-error">{dbError}</p>}
          {!dbs && !dbError && <p className="mcp-muted" data-testid="ag-loading">Loading…</p>}
          {dbs && (
            <div className="ag-list" role="group" aria-label="Databases">
              {conn.kind === "postgres" && shownDbs.length > 1 && (
                <button
                  type="button"
                  className="ag-row ag-row-all"
                  role="checkbox"
                  disabled={!ready}
                  data-ag-all-dbs
                  aria-checked={tickOf(shownDbs.filter((d) => ruleOf(d.name)).length, shownDbs.length)}
                  onClick={() =>
                    toggleDbs(
                      shownDbs.map((d) => d.name),
                      shownDbs.some((d) => !ruleOf(d.name)),
                    )
                  }
                >
                  <TickBox on={tickOf(shownDbs.filter((d) => ruleOf(d.name)).length, shownDbs.length)} />
                  <span className="ag-row-name">All databases</span>
                </button>
              )}
              {shownDbs.map((d) => {
                const on = !!ruleOf(d.name);
                return (
                  <div key={d.name} className="ag-db" data-ag-db={d.name} data-picked={picked === d.name || undefined}>
                    <button
                      type="button"
                      className="ag-tick"
                      role="checkbox"
                  disabled={!ready}
                      aria-checked={on}
                      aria-label={`Share ${d.name}`}
                      data-ag-db-tick={d.name}
                      onClick={() => {
                        toggleDb(d.name, !on);
                        if (!on) setPicked(d.name);
                      }}
                    >
                      <TickBox on={on} />
                    </button>
                    <button type="button" className="ag-db-name" data-ag-db-pick={d.name} onClick={() => setPicked(d.name)}>
                      <span className="ag-row-name">
                        {conn.kind === "sqlite" ? "This file" : d.name}
                        {d.name === ownDatabase(conn) && conn.kind === "postgres" && <span className="ag-dim"> · default</span>}
                      </span>
                      <span className="ag-row-n">{dbLabel(d)}</span>
                    </button>
                  </div>
                );
              })}
              {shownDbs.length === 0 && <p className="mcp-muted">Nothing matches.</p>}
            </div>
          )}
        </div>
        <div className="ag-ed-tables">
          <div className="ag-ed-thead">
            <h3 className="ag-h3">
              Tables{" "}
              <b className="ag-count" data-testid="ag-table-count">
                {tables ? `${sharedHere} of ${tables.length}` : ""}
              </b>
            </h3>
          </div>
          <label className="ag-filter ag-filter-keys">
            <input
              ref={tableFilterRef}
              data-ag-table-filter
              type="search"
              placeholder="Filter tables"
              aria-label="Filter tables"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
            />
            <kbd><Keys text={filterKeys} /></kbd>
          </label>
          {tableError && <p className="mcp-muted ag-error">{tableError}</p>}
          {!tables && !tableError && <p className="mcp-muted" data-testid="ag-loading">Loading…</p>}
          {tables && (
            <div className="ag-list ag-tables" role="group" aria-label="Tables">
              {shownTables.length > 0 && (
                <button
                  type="button"
                  className="ag-row ag-row-all"
                  role="checkbox"
                  disabled={!ready}
                  data-ag-all-tables
                  aria-checked={tickOf(shownShared, shownTables.length)}
                  onClick={() => setNames(shownTables.map(tableName), shownShared < shownTables.length)}
                >
                  <TickBox on={tickOf(shownShared, shownTables.length)} />
                  <span className="ag-row-name">All tables</span>
                  <span className="ag-row-n">{shownTables.length.toLocaleString()} {shownTables.length === 1 ? "table" : "tables"}</span>
                </button>
              )}
              {schemas.map(([schema, list]) => {
                const n = list.filter(isShared).length;
                const showSchema = conn.kind === "postgres";
                return (
                  <Fragment key={schema}>
                    {showSchema && (
                      <button
                        type="button"
                        className="ag-row ag-schema"
                        role="checkbox"
                  disabled={!ready}
                        data-ag-schema={schema}
                        aria-checked={tickOf(n, list.length)}
                        onClick={() => setNames(list.map(tableName), n < list.length)}
                      >
                        <TickBox on={tickOf(n, list.length)} />
                        <span className="ag-row-name">{schema}</span>
                        <span className="ag-row-n">
                          {n} of {list.length}
                        </span>
                      </button>
                    )}
                    {list.map((t) => {
                      const on = isShared(t);
                      const n = maskedIn(t);
                      const open = columnsOf === tableName(t);
                      return (
                        <div key={t.name} className="ag-trow" data-picked={open || undefined}>
                          <button
                            type="button"
                            className="ag-row ag-table"
                            role="checkbox"
                            disabled={!ready}
                            aria-checked={on}
                            data-ag-table={tableName(t)}
                            data-off={on ? undefined : ""}
                            onClick={() => setNames([tableName(t)], !on)}
                          >
                            <TickBox on={on} />
                            <span className="ag-row-name ag-mono">
                              {t.name}
                              {t.kind !== "table" && <span className="ag-dim"> ({t.kind})</span>}
                            </span>
                            <span className="ag-row-n">{rowsLabel(t.rows)}</span>
                            <span className="ag-big">{t.big ? "large" : ""}</span>
                          </button>
                          <button
                            type="button"
                            className="ag-cols-btn"
                            data-ag-columns={tableName(t)}
                            data-masked={n || undefined}
                            aria-expanded={open}
                            aria-label={n ? `Columns of ${t.name}, ${n} masked` : `Columns of ${t.name}`}
                            title={n ? `${n} masked` : "Columns"}
                            onClick={() => setColumnsOf(open ? null : tableName(t))}
                          >
                            <Icon name={n ? "noEye" : "eye"} />
                            {n > 0 && <span>{n}</span>}
                          </button>
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
              {tables.length > 0 && shownTables.length === 0 && <p className="mcp-muted">Nothing matches.</p>}
              {tables.length === 0 && <p className="mcp-muted">No tables</p>}
            </div>
          )}
        </div>
        {openTable && (
          <ColumnMarks
            key={columnsOf}
            table={openTable}
            masked={maskedHere}
            onSet={setMasked}
            onClose={() => setColumnsOf(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A table's columns beside the list, each one a row that masks it: agents
 * then only get a stand-in for its values. Names that look personal (email,
 * phone, date of birth…) are tagged, and one button masks them all.
 */
function ColumnMarks({
  table,
  masked,
  onSet,
  onClose,
}: {
  table: PickTable;
  masked: string[];
  onSet: (names: string[], on: boolean) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const columns = table.columns ?? [];
  const isMasked = (column: string) => masked.includes(columnName(table, column));
  const suggested = columns.filter((c) => looksPersonal(c.name) && !isMasked(c.name));
  const shown = columns.filter((c) => matches(c.name, filter));
  const n = columns.filter((c) => isMasked(c.name)).length;
  return (
    <div className="ag-ed-cols" data-testid="ag-columns" data-ag-columns-of={tableName(table)}>
      <div className="ag-ed-thead">
        <h3 className="ag-h3">
          Columns in <span className="ag-mono ag-cols-table">{table.name}</span>{" "}
          <b className="ag-count" data-testid="ag-masked-count">
            {n} masked
          </b>
        </h3>
        <span className="mcp-grow" />
        <button type="button" className="ag-x" aria-label="Close columns" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {suggested.length > 0 && (
        <button
          type="button"
          className="mcp-btn ag-mask-suggested"
          data-ag-mask-suggested
          onClick={() => onSet(suggested.map((c) => columnName(table, c.name)), true)}
        >
          Mask suggested ({suggested.length})
        </button>
      )}
      {columns.length > 12 && (
        <input
          className="ag-filter"
          type="search"
          placeholder="Filter columns"
          aria-label="Filter columns"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <div className="ag-list" role="group" aria-label={`Columns of ${table.name}`}>
        {shown.map((c) => {
          const on = isMasked(c.name);
          return (
            <button
              key={c.name}
              type="button"
              className="ag-row ag-col"
              role="switch"
              aria-checked={on}
              aria-label={`Mask ${c.name}`}
              data-ag-col={c.name}
              data-masked={on || undefined}
              onClick={() => onSet([columnName(table, c.name)], !on)}
            >
              <span className="ag-row-name ag-mono">{c.name}</span>
              <span className="ag-row-n">{c.type}</span>
              {!on && looksPersonal(c.name) ? <span className="ag-personal">Looks personal</span> : <span />}
              <span className="ag-eye">
                <Icon name={on ? "noEye" : "eye"} />
              </span>
            </button>
          );
        })}
        {columns.length === 0 && <p className="mcp-muted">No columns</p>}
        {columns.length > 0 && shown.length === 0 && <p className="mcp-muted">Nothing matches.</p>}
      </div>
    </div>
  );
}

/** "38 rows", "~84,000 rows" (estimates over 1,000 are approximate). */
function rowsLabel(rows: number | null): string {
  if (rows === null) return "";
  return `${rows >= 1000 ? "~" : ""}${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}`;
}

/* Stroke icons for the sheet's lists, as icons.tsx draws them (16 px, 1.4). */
const ICONS: Record<string, ReactNode> = {
  schema: (
    <>
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M2.5 6.5h11M6 3.5v9" />
    </>
  ),
  select: (
    <>
      <path d="M2.5 4l3 2.5-3 2.5" />
      <path d="M7 10h5" />
    </>
  ),
  rows: <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  shield: <path d="M8 2.5l5 2v3.5c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4.5z" />,
  noWrite: (
    <>
      <path d="M4 2.5h5l3 3V13.5H4z" />
      <path d="M9 2.5v3h3" />
      <path d="M6.5 8l3 3M9.5 8l-3 3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  noEye: (
    <>
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M3 13L13 3" />
    </>
  ),
  noScan: (
    <>
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M2.5 6.5h11M2.5 9.5h11" />
      <path d="M3 13L13 3" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </>
  ),
  noFn: (
    <>
      <path d="M9 2.5L5 13.5" />
      <path d="M3 6.5h4M9 6.5h2" />
      <path d="M11.5 10l-3 3M8.5 10l3 3" />
    </>
  ),
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="ag-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

const TOOLS: [string, string][] = [
  ["list_connections", "Shared connections"],
  ["list_databases", "Shared databases of a connection"],
  ["list_tables", "Shared tables with row counts"],
  ["search_schema", "Find tables and columns by name"],
  ["describe_table", "Columns, keys, indexes and enums"],
  ["explain", "Query plan without running it"],
  ["query", "Run one read-only SELECT"],
  ["sessions", "What's running and who blocks whom"],
  ["propose_change", "Send an INSERT, UPDATE or DELETE for you to review"],
  ["check_proposal", "Whether you committed or rejected it"],
];

/** What can the agent do: how a call flows, what it can and can't do, and its tools. */
function CanDoSheet({ host, onClose }: { host: string | null; onClose: () => void }) {
  const L = MCP_LIMITS;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div className="ag-scrim" data-testid="ag-can-do" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ag-sheet" role="dialog" aria-modal="true" aria-labelledby="ag-can-title">
        <div className="ag-sheet-head">
          <h2 id="ag-can-title">What can the agent do</h2>
          <span className="mcp-grow" />
          <button type="button" className="mcp-esc" title="Close  esc" onClick={onClose}>
            esc
          </button>
        </div>
        <FlowDiagram host={host} rows={L.defaultRows} />
        <div className="ag-two">
          <div className="ag-panel" data-ag-panel="can">
            <h3>What it can do</h3>
            <ul>
              <li>
                <Icon name="schema" />
                <span>
                  <b>Read the schema</b> of shared databases
                </span>
              </li>
              <li>
                <Icon name="select" />
                <span>
                  <b>Run one SELECT at a time</b> in a read-only session
                </span>
              </li>
              <li>
                <Icon name="rows" />
                <span>
                  <b>Get up to {L.maxRows.toLocaleString()} rows</b> per query, {L.defaultRows} by default
                </span>
              </li>
              <li>
                <Icon name="clock" />
                <span>
                  <b>Run for {L.timeoutSeconds} seconds</b> at most per query
                </span>
              </li>
              <li>
                <Icon name="shield" />
                <span>
                  <b>See masked hostnames</b>
                  {host ? ` like ${host}` : ""}
                </span>
              </li>
            </ul>
          </div>
          <div className="ag-panel ag-never" data-ag-panel="never">
            <h3>What it can&rsquo;t do</h3>
            <ul>
              <li>
                <Icon name="noWrite" />
                <span>
                  <b>Change data</b> on its own: a proposed change waits until you commit it
                </span>
              </li>
              <li>
                <Icon name="noEye" />
                <span>
                  <b>See passwords</b> or anything in the keychain
                </span>
              </li>
              <li>
                <Icon name="noScan" />
                <span>
                  <b>Scan a large table</b> of over {L.bigTableRows.toLocaleString()} rows end to end
                </span>
              </li>
              <li>
                <Icon name="lock" />
                <span>
                  <b>Reach anything you didn&rsquo;t share</b>, by name or through views and joins
                </span>
              </li>
              <li>
                <Icon name="noFn" />
                <span>
                  <b>Call unsafe functions</b> such as pg_read_file or pg_terminate_backend
                </span>
              </li>
            </ul>
            <p className="ag-panel-note" data-ag-join-note>
              For a view or a join, tick every table it reads, or the query is refused.
            </p>
          </div>
        </div>
        <div>
          <h3 className="ag-h3">Available tools</h3>
          <div className="ag-tools">
            {TOOLS.map(([name, what]) => (
              <div key={name}>
                <code>{name}</code>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ag-sheet-foot">
          <span className="mcp-muted">Changes take effect on the next call.</span>
          <span className="mcp-grow" />
          <button ref={closeRef} type="button" className="mcp-btn" data-ag-can-close onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * How one call flows: you choose what to share; the agent's tool call goes
 * to Rowkery on this Mac, which runs one read-only SELECT on the database
 * and sends capped rows back, logged.
 */
function FlowDiagram({ host, rows }: { host: string | null; rows: number }) {
  return (
    <svg
      className="ag-flow"
      viewBox="0 0 816 160"
      role="img"
      aria-label="You choose what to share. The agent calls Rowkery on this Mac; Rowkery runs one read-only SELECT on the database and sends capped rows back, logged."
    >
      <defs>
        <marker id="ag-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0.5 L7.5 4 L0 7.5" className="ag-flow-head" />
        </marker>
      </defs>
      <g className="ag-node ag-node-you">
        <rect x="318" y="4" width="180" height="40" rx="7" />
        <text x="408" y="21" className="ag-t1" textAnchor="middle">
          You
        </text>
        <text x="408" y="36" className="ag-t2" textAnchor="middle">
          choose what to share
        </text>
      </g>
      <path d="M408 44 V62" className="ag-arr" markerEnd="url(#ag-ah)" />
      <g className="ag-node">
        <rect x="0" y="64" width="160" height="46" rx="7" />
        <text x="80" y="83" className="ag-t1" textAnchor="middle">
          Agent
        </text>
        <text x="80" y="99" className="ag-t2" textAnchor="middle">
          Claude Desktop or Code
        </text>
      </g>
      <g className="ag-node ag-node-main">
        <rect x="328" y="64" width="160" height="46" rx="7" />
        <text x="408" y="83" className="ag-t1" textAnchor="middle">
          Rowkery
        </text>
        <text x="408" y="99" className="ag-t2" textAnchor="middle">
          checks every call
        </text>
      </g>
      <g className="ag-node">
        <rect x="656" y="64" width="160" height="46" rx="7" />
        <text x="736" y="83" className="ag-t1" textAnchor="middle">
          Database
        </text>
        <text x="736" y="99" className="ag-t2" textAnchor="middle">
          {host ?? "Postgres or SQLite"}
        </text>
      </g>
      <text x="244" y="73" className="ag-lbl" textAnchor="middle">
        tool call
      </text>
      <path d="M164 80 H324" className="ag-arr" markerEnd="url(#ag-ah)" />
      <text x="572" y="73" className="ag-lbl" textAnchor="middle">
        one SELECT, read-only
      </text>
      <path d="M492 80 H652" className="ag-arr" markerEnd="url(#ag-ah)" />
      <path d="M324 98 H164" className="ag-arr" markerEnd="url(#ag-ah)" />
      <text x="244" y="118" className="ag-lbl" textAnchor="middle">
        {rows} rows back, logged
      </text>
      <path d="M652 98 H492" className="ag-arr" markerEnd="url(#ag-ah)" />
      <text x="572" y="118" className="ag-lbl" textAnchor="middle">
        rows
      </text>
      <path d="M0 132 V138 H488 V132" className="ag-brk" />
      <text x="244" y="154" className="ag-lbl" textAnchor="middle">
        Stays on this Mac
      </text>
      <path d="M656 132 V138 H816 V132" className="ag-brk" />
      <text x="736" y="154" className="ag-lbl" textAnchor="middle">
        Over the network
      </text>
    </svg>
  );
}
