import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { chordFor, commandById, eventMatches, keysFor } from "./commands";
import { AgentIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon, WarningIcon } from "./icons";
import { InspectorButton, InspectorHead } from "./Inspector";
import { Keys } from "./Keys";
import { clientLabel, sinceLabel } from "./mcpActivity";
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
  type StatementPreview,
} from "./proposals";
import { highlightSqlLines } from "./sqlHighlight";
import type { ConnectionRecord } from "./types";
import "./ProposalPage.css";

/** What the agent hears when the user takes the SQL into a query tab instead. */
const OPENED_NOTE = "The user opened it in a query tab to change it, so this version won't run.";

type DryState = "idle" | "running" | "done" | "error";

/**
 * A change an agent proposed (`propose_change`), for the user to commit or
 * discard. Nothing runs when it opens (2026-10-16): the main
 * column shows each statement's exact SQL under its verb and table, and the
 * dock at its foot lists the triggers they fire beside Dry run. The dry run
 * (rolled back) puts the rows each statement changed under its SQL, old
 * value struck through above the new one, and only then can Commit ⇧⌘↵ run:
 * it sends the dry run's row counts and runs again only if every statement
 * changes as many rows; otherwise a fresh dry run takes their place.
 */
export function ProposalPage({
  connections,
  onOpenSql,
  onClose,
}: {
  connections: ConnectionRecord[];
  onOpenSql: (connectionId: string, database: string | undefined, sql: string) => void;
  onClose: () => void;
}) {
  const waiting = useProposals();
  const [at, setAt] = useState(0);
  const proposal = waiting[Math.min(at, waiting.length - 1)] ?? null;
  const [planned, setPlanned] = useState<{ id: string; plan: Plan | null; error: string | null } | null>(null);
  const [run, setRun] = useState<{ id: string; state: DryState; dry: DryRun | null; error: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const shownId = useRef<string | null>(null);
  const mac = isMacPlatform();
  const presenting = usePresenting();
  const id = proposal?.id ?? null;
  shownId.current = id;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Each proposal shown reads its statements and their triggers; it runs nothing.
  useEffect(() => {
    if (!id) return;
    let live = true;
    setPlanned({ id, plan: null, error: null });
    setRun(null);
    setRejecting(false);
    setNote("");
    planProposal(id).then(
      (plan) => live && setPlanned({ id, plan, error: null }),
      (e) => live && setPlanned({ id, plan: null, error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [id]);

  // Nothing left to review: the page goes.
  useEffect(() => {
    if (!waiting.length) onClose();
  }, [waiting.length, onClose]);

  useEffect(() => {
    if (rejecting) noteRef.current?.focus();
  }, [rejecting]);

  const plan = planned?.id === id ? planned.plan : null;
  const planError = planned?.id === id ? planned.error : null;
  const mine = run?.id === id ? run : null;
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
    setAt((i) => Math.max(0, Math.min(i, waiting.length - 2)));
  };

  const dryRun = () => {
    if (!id || state === "running" || busy) return;
    setRun({ id, state: "running", dry: null, error: null });
    dryRunProposal(id).then(
      (dry) => shownId.current === id && setRun({ id, state: "done", dry, error: null }),
      (e) => shownId.current === id && setRun({ id, state: "error", dry: null, error: String(e) }),
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
        setRun({ id: proposal.id, state: "done", dry: out.dry_run, error: null });
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
        rootRef.current?.focus();
      } else onClose();
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

  if (!proposal) return null;
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
    <section
      ref={rootRef}
      className="proposal-page"
      data-testid="proposal-page"
      data-proposal={proposal.id}
      aria-label="Proposed change"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
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
        <InspectorHead
          onClose={onClose}
          tools={
            waiting.length > 1 && (
              <>
                <InspectorButton label="Previous" ariaLabel="Previous" disabled={at === 0} onClick={() => setAt(at - 1)}>
                  <ChevronLeftIcon size={10} />
                </InspectorButton>
                <InspectorButton
                  label="Next"
                  ariaLabel="Next"
                  disabled={at >= waiting.length - 1}
                  onClick={() => setAt(at + 1)}
                >
                  <ChevronRightIcon size={10} />
                </InspectorButton>
              </>
            )
          }
        >
          <h2 className="insp-title">Proposed change</h2>
          <small className="insp-meta sans" data-testid="pp-position">
            {Math.min(at, waiting.length - 1) + 1} of {waiting.length}
          </small>
        </InspectorHead>
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
    </section>
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
