import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chordFor, commandById, eventMatches, keysFor } from "./commands";
import { CallDetail, EnvDot, clock, copyText } from "./AgentSharing";
import { AgentIcon, PlayIcon, SettingsIcon, WarningIcon } from "./icons";
import { PageBack, usePageFocus } from "./Inspector";
import { Keys } from "./Keys";
import { bytesLabel, clientLabel, sinceLabel, useMcpEntries, verdictOf, type McpEntry } from "./mcpActivity";
import { useGlideHover } from "./motion";
import { showToast } from "./notify";
import { isMacPlatform } from "./platform";
import { HIDDEN_TEXT, markedNames, usePresenting } from "./presenting";
import {
  commitProposal,
  dryRunProposal,
  forgetProposal,
  planProposal,
  proposalTable,
  rejectProposal,
  tableLabel,
  useProposals,
  type DryRun,
  type Plan,
  type Proposal,
  type StatementPreview,
} from "./proposals";
import { highlightSqlLines } from "./sqlHighlight";
import type { ConnectionRecord } from "./types";
import "./AgentsPage.css";
import "./ProposalPage.css";

/** What the agent hears when the user takes the SQL into a query tab instead. */
const OPENED_NOTE = "The user opened it in a query tab to change it, so this version won't run.";

type DryState = "idle" | "running" | "done" | "error";
type Planned = { plan: Plan | null; error: string | null };
type Run = { state: DryState; dry: DryRun | null; error: string | null };

/** Calls rendered in the list at most; older ones stay in the log file. */
const SHOWN = 300;

type Sel = { kind: "proposal"; id: string } | { kind: "call"; key: number } | null;
type Call = { e: McpEntry; key: number };

/**
 * The Agents page (2026-10-17): what agents did and what they ask for, one
 * list on the left and the picked item beside it. "Waiting for you" holds
 * the changes agents proposed (`propose_change`), oldest first; "Activity"
 * every call, newest first (All, or only Refused). Sharing itself is a
 * one-off and lives in Settings › Agents (the foot's Sharing button).
 * ↑↓ move through both lists; on a call, ↵ opens its SQL in a query tab (not
 * run) and ⌘C copies it. The way out is the head's first control, which
 * names the window it returns to; Esc does the same.
 *
 * A proposal opens with nothing run (2026-10-16): the main column shows each
 * statement's exact SQL under its verb and table, and the dock at its foot
 * lists the triggers they fire beside Dry run. The dry run (rolled back)
 * puts the rows each statement changed under its SQL, old value struck
 * through above the new one, and only then can Commit ⇧⌘↵ run: it sends the
 * dry run's row counts and runs again only if every statement changes as
 * many rows; otherwise a fresh dry run takes their place. Each keeps its
 * plan and its dry run while another item is shown, so coming back to one
 * doesn't need a new dry run; Commit still re-checks the row counts.
 */
export function AgentsInbox({
  connections,
  initial,
  focus,
  backTo,
  onOpenSql,
  onSharing,
  onClose,
}: {
  connections: ConnectionRecord[];
  /** What shows first: the oldest waiting proposal, or the newest call. */
  initial: "proposals" | "activity";
  /** A proposal to show first, while it waits (a card's Review in Rowkery). */
  focus?: string;
  /** The window the page returns to, named on the way out. */
  backTo: string;
  onOpenSql: (connectionId: string, database: string | undefined, sql: string) => void;
  /** Settings › Agents, with Connect an agent open when asked. */
  onSharing: (connect?: boolean) => void;
  onClose: () => void;
}) {
  const waiting = useProposals();
  const entries = useMcpEntries();
  const [filter, setFilter] = useState<"all" | "refused">("all");
  // "12 s ago" stays current while the page is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  const byId = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const calls = useMemo(() => {
    const out: Call[] = [];
    for (let i = entries.length - 1; i >= 0 && out.length < SHOWN; i--)
      if (filter === "all" || verdictOf(entries[i]) === "refused") out.push({ e: entries[i], key: i });
    return out;
  }, [entries, filter]);
  const refusedCount = useMemo(() => entries.filter((e) => verdictOf(e) === "refused").length, [entries]);
  const manyPlaces = useMemo(() => new Set(entries.map((e) => e.connection).filter(Boolean)).size > 1, [entries]);

  const [sel, setSel] = useState<Sel>(focus ? { kind: "proposal", id: focus } : null);
  useEffect(() => {
    if (focus) setSel({ kind: "proposal", id: focus });
  }, [focus]);
  // The picked proposal, or once it's decided, the one that took its place in
  // the list; with none left, the newest call.
  const lastAt = useRef(0);
  const wantCall = sel ? sel.kind === "call" : initial === "activity" && calls.length > 0;
  let at = -1;
  if (!wantCall && waiting.length) {
    at = waiting.findIndex((p) => sel?.kind === "proposal" && p.id === sel.id);
    if (at < 0) at = Math.min(lastAt.current, waiting.length - 1);
    lastAt.current = at;
  }
  const proposal = at >= 0 ? waiting[at] : null;
  const call = proposal ? null : ((sel?.kind === "call" ? calls.find((c) => c.key === sel.key) : undefined) ?? calls[0] ?? null);

  const [plans, setPlans] = useState<Record<string, Planned>>({});
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const asked = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  useGlideHover(listRef, ".pp-card, .ag-call");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const mac = isMacPlatform();
  const presenting = usePresenting();
  const id = proposal?.id ?? null;

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  usePageFocus(rootRef);

  // Each waiting proposal reads its statements and their triggers once (the
  // list's cards show them too); it runs nothing. The shown one goes first.
  useEffect(() => {
    const order = proposal ? [proposal, ...waiting.filter((p) => p !== proposal)] : waiting;
    for (const p of order) {
      if (asked.current.has(p.id)) continue;
      asked.current.add(p.id);
      planProposal(p.id).then(
        (plan) => setPlans((m) => ({ ...m, [p.id]: { plan, error: null } })),
        (e) => setPlans((m) => ({ ...m, [p.id]: { plan: null, error: String(e) } })),
      );
    }
  }, [waiting, proposal]);

  // A note half typed belongs to the proposal it was for.
  useEffect(() => {
    setRejecting(false);
    setNote("");
  }, [id]);

  useEffect(() => {
    if (rejecting) noteRef.current?.focus();
  }, [rejecting]);

  const plan = id ? (plans[id]?.plan ?? null) : null;
  const planError = id ? (plans[id]?.error ?? null) : null;
  const mine = id ? (runs[id] ?? null) : null;
  const setRun = (pid: string, r: Run) => setRuns((m) => ({ ...m, [pid]: r }));
  const state: DryState = mine?.state ?? "idle";
  const dry = mine?.state === "done" ? mine.dry : null;
  const conn = connections.find((c) => c.id === proposal?.connection) ?? null;
  const hidden = useMemo(
    () => (presenting && conn && proposal ? markedNames(conn.masked_columns?.[proposal.database] ?? [], null) : new Set<string>()),
    [presenting, conn, proposal],
  );
  const total = dry?.statements.reduce((n, s) => n + s.rows, 0) ?? 0;

  // The statements as shown: the dry run's once it has run, else the plan's.
  const statements = useMemo(() => {
    if (dry) return dry.statements.map((s) => ({ verb: s.verb, target: s.target, sql: s.sql, destructive: s.destructive, preview: s }));
    if (plan) return plan.statements.map((s) => ({ ...s, preview: null as StatementPreview | null }));
    return proposal
      ? [{ verb: null, target: null, sql: proposal.sql, destructive: false, preview: null as StatementPreview | null }]
      : [];
  }, [dry, plan, proposal]);
  const sqlHtml = useMemo(
    () => statements.map((s) => highlightSqlLines(/;\s*$/.test(s.sql) ? s.sql : `${s.sql};`).join("\n")),
    [statements],
  );
  const triggers = useMemo(() => {
    const out: { name: string; event: string; table: string }[] = [];
    for (const s of plan?.statements ?? []) {
      if (!s.target) continue;
      for (const t of s.triggers) {
        const table = tableLabel(s.target);
        if (!out.some((o) => o.name === t.name && o.table === table && o.event === t.event))
          out.push({ name: t.name, event: t.event, table });
      }
    }
    return out;
  }, [plan]);
  const unread = !!plan?.statements.some((s) => !s.target);

  const done = (id: string) => {
    forgetProposal(id);
    // The pressed button goes with the proposal; keep the keys on the page.
    rootRef.current?.focus({ preventScroll: true });
    setRuns((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  };

  // Both lists as one for ↑↓: the proposals, then the calls shown.
  const items: Sel[] = [...waiting.map((p): Sel => ({ kind: "proposal", id: p.id })), ...calls.map((c): Sel => ({ kind: "call", key: c.key }))];
  const current = proposal ? at : call ? waiting.length + calls.indexOf(call) : -1;
  const pick = (to: number) => {
    const next = items[Math.max(0, Math.min(to, items.length - 1))];
    if (!next || to === current) return;
    setSel(next);
    const q = next.kind === "proposal" ? `[data-proposal-id="${next.id}"]` : `[data-mcp-entry="${next.key}"]`;
    listRef.current?.querySelector<HTMLElement>(q)?.scrollIntoView({ block: "nearest" });
  };
  const canOpen = (c: Call | null): c is Call & { e: McpEntry & { sql: string; connection: string } } =>
    !!c?.e.sql && !!c.e.connection && byId.has(c.e.connection);
  const openCall = (c: Call | null) => {
    if (canOpen(c)) onOpenSql(c.e.connection, c.e.database, c.e.sql);
  };

  const dryRun = () => {
    if (!id || state === "running" || busy) return;
    // The button disables while it runs, which would drop focus to the body and
    // leave ⇧⌘↵ (Commit) with nowhere to land; the page keeps it instead.
    // Once it settles, the button takes focus back if nothing else took it.
    const button = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    setRun(id, { state: "running", dry: null, error: null });
    const settle = (run: Parameters<typeof setRun>[1]) => {
      setRun(id, run);
      if (button && document.activeElement === rootRef.current) requestAnimationFrame(() => button.focus({ preventScroll: true }));
    };
    dryRunProposal(id).then(
      (dry) => settle({ state: "done", dry, error: null }),
      (e) => settle({ state: "error", dry: null, error: String(e) }),
    );
  };

  const commit = async () => {
    if (!proposal || !dry || busy || rejecting) return;
    setBusy(true);
    try {
      const out = await commitProposal(proposal.id, dry.statements.map((s) => s.rows));
      if (out.outcome === "committed") {
        const rows = out.rows.reduce((a, b) => a + b, 0);
        showToast("Committed", `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"} · ${tableLabel(dry.statements[0].target)}`);
        done(proposal.id);
      } else if (out.outcome === "moved") {
        setRun(proposal.id, { state: "done", dry: out.dry_run, error: null });
        showToast("Nothing was saved", "The rows changed since the dry run. Check the new one.", "error");
      } else {
        showToast("Couldn't commit", out.error, "error");
      }
    } catch (e) {
      showToast("Couldn't commit", String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (why?: string) => {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      await rejectProposal(proposal.id, why);
      const first = statements[0]?.target;
      if (why !== OPENED_NOTE) showToast("Discarded", first ? tableLabel(first) : "");
      done(proposal.id);
    } catch (e) {
      showToast("Couldn't discard", String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const openInTab = async () => {
    if (!proposal) return;
    const { connection, database, sql } = proposal;
    await reject(OPENED_NOTE);
    onOpenSql(connection, database, sql);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (rejecting) {
        setRejecting(false);
        rootRef.current?.focus({ preventScroll: true });
      } else onClose();
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing) return;
    const mod = mac ? e.metaKey : e.ctrlKey;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      pick(current + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (call) {
      if (e.key === "Enter" && !mod) {
        e.preventDefault();
        openCall(call);
      } else if (mod && e.key.toLowerCase() === "c" && call.e.sql && !window.getSelection()?.toString()) {
        e.preventDefault();
        void copyText(call.e.sql, "SQL");
      }
      return;
    }
    const confirm = commandById("confirm-write");
    const chord = confirm && chordFor(confirm);
    if (chord && eventMatches(e, chord, mac)) {
      e.preventDefault();
      e.stopPropagation();
      void commit();
    }
  };

  const places = new Set(waiting.map((p) => `${p.connection}\u0000${p.database}`)).size;
  const last = entries.length ? entries[entries.length - 1] : null;

  return (
    <section
      ref={rootRef}
      className="proposal-page ag-inbox"
      data-testid="agents-page"
      data-proposal={proposal?.id}
      data-call={call ? call.key : undefined}
      aria-label="Agents"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <nav className="pp-list" data-testid="pp-list" aria-label="Agents">
        <header className="ag-head ag-inbox-head">
          <PageBack to={backTo} onBack={onClose} />
          <span className="mcp-grow" />
          <h1 className="ag-title">Agents</h1>
        </header>
        <div ref={listRef} className="ag-inbox-scroll">
          {waiting.length > 0 && (
            <>
              <h2 className="ag-sec">
                Waiting for you{" "}
                <span className="ag-sec-n" data-testid="pp-list-count">
                  {waiting.length}
                </span>
              </h2>
              <div className="pp-cards">
                {waiting.map((p, i) => (
                  <ProposalCard
                    key={p.id}
                    p={p}
                    planned={plans[p.id]}
                    run={runs[p.id]}
                    where={places > 1 ? placeLabel(p, connections) : null}
                    current={i === at}
                    onPick={() => {
                      setSel({ kind: "proposal", id: p.id });
                      rootRef.current?.focus({ preventScroll: true });
                    }}
                  />
                ))}
              </div>
            </>
          )}
          <h2 className="ag-sec">
            Activity
            <span className="mcp-grow" />
            {entries.length > 0 &&
              (
                [
                  ["all", "All"],
                  ["refused", `Refused${refusedCount ? ` ${refusedCount}` : ""}`],
                ] as const
              ).map(([f, label]) => (
                <button key={f} type="button" className="ag-filter" data-mcp-filter={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
          </h2>
          <div className="ag-calls" role="list" aria-label="Agent calls">
            {calls.length === 0 && (
              <p className="mcp-muted ag-calls-none">{entries.length ? "Nothing refused." : "No calls yet."}</p>
            )}
            {calls.map((c) => (
              <CallRow
                key={c.key}
                c={c}
                conn={c.e.connection ? byId.get(c.e.connection) : undefined}
                showConn={manyPlaces}
                current={c === call}
                onPick={() => {
                  setSel({ kind: "call", key: c.key });
                  rootRef.current?.focus({ preventScroll: true });
                }}
                onOpen={() => openCall(c)}
              />
            ))}
          </div>
        </div>
        <footer className="ag-inbox-foot">
          <span data-testid="mcp-live" className="mcp-live" data-on={last && now - last.ts < 60_000 ? "" : undefined}>
            {last ? `${clientLabel(last.client)} · ${sinceLabel(last.ts, now)}` : "No agent calls yet"}
          </span>
          <span className="mcp-grow" />
          <button type="button" className="mcp-btn ag-sharing-btn" data-ag-sharing title="Settings › Agents" onClick={() => onSharing()}>
            <SettingsIcon size={13} />
            Sharing
          </button>
        </footer>
      </nav>
      {proposal ? (
        renderProposal(proposal)
      ) : call ? (
        <CallView
          key={call.key}
          c={call}
          conn={call.e.connection ? byId.get(call.e.connection) : undefined}
          canOpen={canOpen(call)}
          onOpen={() => openCall(call)}
        />
      ) : (
        <div className="pp-main ag-empty" data-testid="mcp-empty">
          <p>{entries.length ? "Nothing refused." : "No agent has called Rowkery yet."}</p>
          {!entries.length && (
            <button type="button" className="mcp-btn ink" data-mcp-connect onClick={() => onSharing(true)}>
              Connect an agent
            </button>
          )}
        </div>
      )}
    </section>
  );

  function renderProposal(proposal: Proposal) {
    const expected = proposal.expect_rows;
    const first = statements[0];
    const destructive = statements.filter((s) => s.destructive && s.target);
    const commitLabel =
      statements.length === 1 && first?.destructive
        ? first.verb === "DELETE"
          ? "Delete all rows"
          : "Update all rows"
        : "Commit";
    const tables = [...new Set(statements.flatMap((s) => (s.target ? [tableLabel(s.target)] : [])))];
    const title = tables.length ? tables.join(", ") : (proposalTable(proposal.sql) ?? "Proposed SQL");
    const sub = [
      plan?.connection_name ?? dry?.connection_name ?? conn?.name ?? "Deleted connection",
      conn?.kind === "postgres" ? proposal.database : null,
      unread || !plan ? null : `${statements.length} ${statements.length === 1 ? "statement" : "statements"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const line =
      state === "running"
        ? null
        : state === "done"
          ? `${total.toLocaleString()} ${total === 1 ? "row" : "rows"} · rolled back`
          : state === "error"
            ? mine?.error
            : unread
              ? "Couldn't read the target table"
              : planError
                ? planError
                : triggers.length
                  ? "Triggers fire during the dry run"
                  : null;

    return (
      <>
          <div className="pp-main">
            <header className="ag-head">
              <h1 className="ag-title" data-testid="pp-title">
                {title}
              </h1>
              <span className="pp-sub" data-testid="pp-summary">
                {sub}
              </span>
            </header>
            <div className="pp-previews">
              {statements.map((s, i) => (
                <section key={i} className="pp-stmt" data-testid="pp-stmt" data-verb={s.verb?.toLowerCase()}>
                  {s.verb && s.target && (
                    <h3 className="pp-stmt-head" data-testid="pp-stmt-head">
                      {s.verb} {s.target}
                      {s.preview && (
                        <span>
                          <b>{s.preview.rows.toLocaleString()}</b> {s.preview.rows === 1 ? "row" : "rows"}
                        </span>
                      )}
                    </h3>
                  )}
                  <pre className="rv-card-sql pp-stmt-sql" data-testid="pp-sql" dangerouslySetInnerHTML={{ __html: sqlHtml[i] }} />
                  {s.preview && <Preview s={s.preview} hidden={hidden} />}
                </section>
              ))}
            </div>
            <div className="pp-dock" data-testid="pp-dry" data-state={state}>
              {triggers.length > 0 && (
                <ul className="pp-triggers" data-testid="pp-triggers">
                  {triggers.map((t) => (
                    <li key={`${t.name}\u0000${t.table}\u0000${t.event}`} data-testid="pp-trigger" data-trigger={t.name}>
                      <b>{t.name}</b> runs on {t.event} <code>{t.table}</code>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pp-dry-row">
                <button
                  type="button"
                  className={state === "idle" ? "run-btn" : state === "running" ? "run-btn running" : "insp-btn"}
                  data-testid="pp-dry-run"
                  disabled={state === "running" || busy}
                  onClick={dryRun}
                >
                  {state === "idle" || state === "running" ? (
                    <>
                      <PlayIcon size={10} />
                      {state === "running" ? "Running…" : "Dry run"}
                    </>
                  ) : (
                    "Dry run again"
                  )}
                </button>
                {line && (
                  <span className="pp-dry-line" data-testid="pp-dry-line" data-error={state === "error" ? "" : undefined}>
                    {line}
                  </span>
                )}
              </div>
            </div>
          </div>
          <aside className="pp-side" data-testid="pp-side">
            <header className="insp-head">
              <h2 className="insp-title">Proposed change</h2>
            </header>
            <div className="pp-body">
              <div className="pp-who">
                <AgentIcon size={13} />
                <span>{clientLabel(proposal.client)}</span>
                <span className="pp-where">
                  {conn?.name ?? "Deleted connection"}
                  {conn?.kind === "postgres" ? ` · ${proposal.database}` : ""}
                </span>
                <span className="pp-ago">{sinceLabel(proposal.ts)}</span>
              </div>
              <blockquote className="pp-reason" data-testid="pp-reason">
                {proposal.reason}
              </blockquote>
              {dry && (
                <>
                  <div className="pp-count" data-testid="pp-count">
                    <span>
                      <b>
                        {total.toLocaleString()} {total === 1 ? "row" : "rows"}
                      </b>{" "}
                      would change
                    </span>
                    {expected !== undefined && (
                      <span className="pp-expect" data-match={expected === total ? "" : undefined}>
                        Agent expected {expected.toLocaleString()}
                      </span>
                    )}
                  </div>
                  {dry.statements.some((s) => s.changed.length > 0) && (
                    <div className="pp-cols" data-testid="pp-cols">
                      {[...new Set(dry.statements.flatMap((s) => s.changed))].map((c) => (
                        <code key={c}>{c}</code>
                      ))}
                    </div>
                  )}
                </>
              )}
              {destructive.map((s, i) => (
                <p key={`d${i}`} className="pp-warn" data-testid="pp-destructive">
                  <WarningIcon size={12} />
                  No WHERE: this {s.verb === "DELETE" ? "deletes" : "changes"} every row in {tableLabel(s.target!)}.
                </p>
              ))}
            </div>
            <footer className="insp-foot">
              {rejecting ? (
                <form
                  className="pp-reject"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void reject(note);
                  }}
                >
                  <input
                    ref={noteRef}
                    className="pp-note-input"
                    data-testid="pp-note"
                    placeholder="Note for the agent"
                    value={note}
                    maxLength={500}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button type="submit" className="insp-btn" data-testid="pp-reject-send" disabled={busy}>
                    Discard
                  </button>
                </form>
              ) : (
                <>
                  <button type="button" className="insp-btn" data-testid="pp-reject" disabled={busy} onClick={() => setRejecting(true)}>
                    Discard
                  </button>
                  <button type="button" className="insp-btn" data-testid="pp-open" disabled={busy} onClick={() => void openInTab()}>
                    Open in a tab
                  </button>
                  <span className="insp-gap" />
                  <button
                    type="button"
                    className="insp-btn ink"
                    data-testid="pp-commit"
                    disabled={!dry || busy}
                    onClick={() => void commit()}
                  >
                    {commitLabel} <kbd><Keys text={keysFor("confirm-write", mac)} /></kbd>
                  </button>
                </>
              )}
            </footer>
          </aside>
      </>
    );
  }
}

/** "Platform API · orders": where a proposal would run, when the list spans more than one place. */
function placeLabel(p: Proposal, connections: ConnectionRecord[]): string {
  const conn = connections.find((c) => c.id === p.connection);
  return conn ? (conn.kind === "postgres" ? `${conn.name} · ${p.database}` : conn.name) : "Deleted connection";
}

/** "UPDATE customers", "INSERT, DELETE orders": the verbs and tables, from the plan once read. */
function cardHead(p: Proposal, plan: Plan | null): string {
  const read = plan?.statements.filter((s) => s.verb && s.target) ?? [];
  if (read.length && read.length === plan?.statements.length) {
    const verbs = [...new Set(read.map((s) => s.verb))].join(", ");
    const tables = [...new Set(read.map((s) => tableLabel(s.target!)))].join(", ");
    return `${verbs} ${tables}`;
  }
  const verb = /^\s*(insert|update|delete)\b/i.exec(p.sql)?.[1];
  const table = proposalTable(p.sql);
  return verb && table ? `${verb.toUpperCase()} ${table}` : p.sql.replace(/\s+/g, " ").trim();
}

/**
 * One waiting proposal in the list: its verbs and tables, the agent's reason
 * (two lines), who sent it and when; at the end, a missing WHERE, else the
 * dry run's rows once it has run.
 */
function ProposalCard({
  p,
  planned,
  run,
  where,
  current,
  onPick,
}: {
  p: Proposal;
  planned: Planned | undefined;
  run: Run | undefined;
  where: string | null;
  current: boolean;
  onPick: () => void;
}) {
  const plan = planned?.plan ?? null;
  const count = plan?.statements.length ?? 0;
  const noWhere = plan?.statements.some((s) => s.destructive && s.target);
  const rows = run?.state === "done" && run.dry ? run.dry.statements.reduce((n, s) => n + s.rows, 0) : null;
  return (
    <button
      type="button"
      className="pp-card"
      data-testid="pp-card"
      data-proposal-id={p.id}
      aria-current={current ? "true" : undefined}
      tabIndex={-1}
      onClick={onPick}
    >
      <span className="pp-card-top">
        <span className="pp-card-head" data-testid="pp-card-head">
          {cardHead(p, plan)}
        </span>
        <span className="pp-card-ago">{sinceLabel(p.ts)}</span>
      </span>
      <span className="pp-card-reason">{p.reason}</span>
      <span className="pp-card-meta">
        <AgentIcon size={12} />
        <span className="pp-card-who">
          {[clientLabel(p.client), where, count > 1 ? `${count} statements` : null].filter(Boolean).join(" · ")}
        </span>
        {noWhere ? (
          <span className="pp-card-warn" data-testid="pp-card-warn">
            <WarningIcon size={11} />
            No WHERE
          </span>
        ) : rows !== null ? (
          <span className="pp-card-state" data-testid="pp-card-rows">
            {rows.toLocaleString()} {rows === 1 ? "row" : "rows"} · dry run
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A call's size or outcome, as the row's right edge prints it. */
function callMeta(e: McpEntry): string {
  const v = verdictOf(e);
  if (v === "refused") return "refused";
  if (v === "error") return "failed";
  if (v === "flagged") return "would refuse";
  if (e.tool === "query" && e.rows !== undefined) return `${e.rows.toLocaleString()} ${e.rows === 1 ? "row" : "rows"}`;
  if (e.tool === "propose_change") return "proposed";
  if (e.bytes !== undefined) return bytesLabel(e.bytes);
  return e.ms !== undefined ? `${e.ms} ms` : "";
}

/**
 * One call in Activity: its time and tool, its outcome or size, and under
 * them one line of its SQL (or what it described). Double-click opens the
 * SQL in a tab, as ↵ does.
 */
function CallRow({
  c,
  conn,
  showConn,
  current,
  onPick,
  onOpen,
}: {
  c: Call;
  conn: ConnectionRecord | undefined;
  showConn: boolean;
  current: boolean;
  onPick: () => void;
  onOpen: () => void;
}) {
  const e = c.e;
  const verdict = verdictOf(e);
  const what =
    e.sql?.replace(/\s+/g, " ").trim() ??
    e.target ??
    (e.tool === "list_connections" && e.rows !== undefined
      ? `${e.rows} shared`
      : e.tool === "sessions" && e.rows !== undefined
        ? `${e.rows} ${e.rows === 1 ? "session" : "sessions"} · ${conn?.name ?? e.connection ?? ""}`
        : (conn?.name ?? e.database ?? ""));
  return (
    <button
      type="button"
      role="listitem"
      className="ag-call"
      data-testid="ag-call"
      data-mcp-entry={c.key}
      data-tool={e.tool}
      data-verdict={verdict}
      aria-current={current ? "true" : undefined}
      tabIndex={-1}
      onClick={onPick}
      onDoubleClick={onOpen}
    >
      <span className="ag-call-time">{clock(e.ts, false)}</span>
      <span className="ag-call-tool">
        {showConn && e.connection && <EnvDot conn={conn} />}
        {e.tool}
      </span>
      <span className="ag-call-meta" data-testid="ag-call-meta" data-verdict={verdict}>
        {callMeta(e)}
      </span>
      {what && <span className="ag-call-what">{what}</span>}
    </button>
  );
}

/**
 * The picked call in full, beside the list: who sent it where and when, why
 * it was refused, its SQL, then what was shared, the request as sent and
 * the start of the response, with Open in tab and the copies.
 */
function CallView({
  c,
  conn,
  canOpen,
  onOpen,
}: {
  c: Call;
  conn: ConnectionRecord | undefined;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const e = c.e;
  const verdict = verdictOf(e);
  const sqlHtml = useMemo(() => (e.sql ? highlightSqlLines(e.sql.trim()).join("\n") : ""), [e.sql]);
  const sub = [
    clientLabel(e.client),
    e.connection ? (conn?.name ?? e.connection) : null,
    e.database && conn?.kind === "postgres" ? e.database : null,
    clock(e.ts),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="pp-main ag-call-view" data-testid="ag-call-view" data-verdict={verdict}>
      <header className="ag-head">
        <h1 className="ag-title" data-testid="ag-call-title">
          {e.tool}
        </h1>
        <span className="pp-sub">{sub}</span>
      </header>
      <div className="pp-previews">
        <section className="pp-stmt">
          {(verdict === "refused" || verdict === "error") && e.verdict && (
            <p className="ag-call-reason" data-testid="mcp-reason" data-verdict={verdict}>
              <b>{verdict === "refused" ? "Refused" : "Failed"}</b> {e.verdict.replace(/^Refused:\s*/, "")}
            </p>
          )}
          {e.target && !e.sql && <h3 className="pp-stmt-head">{e.target}</h3>}
          {e.sql && <pre className="rv-card-sql pp-stmt-sql" data-testid="ag-call-sql" dangerouslySetInnerHTML={{ __html: sqlHtml }} />}
          <CallDetail entry={e} conn={conn} canOpen={canOpen} onOpen={onOpen} />
        </section>
      </div>
    </div>
  );
}

/** A cell as text: NULL spelled out, objects as JSON. */
function show(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** One statement's rows: changed cells tinted, old over new; the rest faded. */
function Preview({ s, hidden }: { s: StatementPreview; hidden: Set<string> }) {
  const changed = new Set(s.changed);
  const cell = (v: unknown, col: string) => (hidden.has(col) ? HIDDEN_TEXT : show(v));
  return (
    <div className="pp-preview" data-testid="pp-preview" data-verb={s.verb.toLowerCase()}>
      {s.rows === 0 ? (
        <p className="pp-none">No rows match, so this statement changes nothing.</p>
      ) : (
        <div className="pp-scroll">
          <table className="pp-grid">
            <thead>
              <tr>
                {s.columns.map((c) => (
                  <th key={c} data-changed={changed.has(c) ? "" : undefined} data-key={s.key.includes(c) ? "" : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.shown.map((r, i) => (
                <tr key={i} data-row={r.before && r.after ? "update" : r.after ? "insert" : "delete"}>
                  {s.columns.map((c, j) => {
                    const before = r.before?.[j];
                    const after = r.after?.[j];
                    if (r.before && r.after && show(before) !== show(after))
                      return (
                        <td key={c} data-cell="changed">
                          <span className="pp-old">{cell(before, c)}</span>
                          <span className="pp-new">{cell(after, c)}</span>
                        </td>
                      );
                    const v = r.after ? after : before;
                    return (
                      <td key={c} data-cell={r.before && r.after && !s.key.includes(c) ? "same" : undefined}>
                        {cell(v, c)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {s.rows > s.shown.length && (
            <p className="pp-more">
              First {s.shown.length.toLocaleString()} of {s.rows.toLocaleString()} rows
            </p>
          )}
        </div>
      )}
    </div>
  );
}
