import { keysFor } from "./commands";
import { LockIcon, WarningIcon } from "./icons";
import type {
  ConnectionRecord,
  SafetyHold,
  SchemaCatalog,
  StatementCheck,
} from "./types";
import "./SafeMode.css";
import { Keys } from "./Keys";

/** "DELETE on wallet_tx", "DROP TABLE wallets", "CALL". */
export function statementLabel(s: StatementCheck): string {
  if (!s.target) return s.verb;
  return s.verb.includes(" ") ? `${s.verb} ${s.target}` : `${s.verb} on ${s.target}`;
}

const unquote = (name: string) => name.replace(/^["`]|["`]$/g, "");

/** The catalog's row count for a statement's target table, when it knows one. */
function rowEstimate(catalog: SchemaCatalog | null, target: string | null): string | null {
  if (!catalog || !target) return null;
  const parts = target.split(".").map(unquote);
  const table = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : null;
  // Quoted names match exactly; bare names fold to lower case like Postgres.
  const same = (a: string, b: string, quoted: boolean) =>
    quoted ? a === b : a.toLowerCase() === b.toLowerCase();
  const quoted = /^["`]/.test(target.split(".").pop() ?? "");
  for (const db of catalog.databases) {
    for (const sch of db.schemas) {
      if (schema && !same(sch.name, schema, false)) continue;
      const t = sch.tables.find((x) => same(x.name, table, quoted));
      const est = t?.row_estimate;
      if (!est || est === "Unknown") continue;
      if ("Exact" in est) return est.Exact.toLocaleString();
      return `about ${est.Approximate.toLocaleString()}`;
    }
  }
  return null;
}

/** What the confirm button says for one destructive statement. */
function confirmLabel(hold: SafetyHold): string {
  const [only] = hold.statements;
  if (hold.statements.length !== 1 || !only.destructive) return "Run";
  if (only.verb === "DELETE") return "Delete all rows";
  if (only.verb === "UPDATE") return "Update all rows";
  if (only.verb === "TRUNCATE") return "Truncate";
  if (only.verb.startsWith("DROP")) return "Drop";
  return "Run";
}

function destructiveNote(s: StatementCheck, catalog: SchemaCatalog | null): string {
  const rows = rowEstimate(catalog, s.target);
  const table = s.target ?? "the table";
  if (s.verb === "DELETE" || s.verb === "UPDATE") {
    const verb = s.verb === "DELETE" ? "deletes" : "changes";
    return `No WHERE: this ${verb} every row in ${table}${rows ? ` (${rows})` : ""}.`;
  }
  if (s.verb === "TRUNCATE") return `This empties ${table}${rows ? ` (${rows} rows)` : ""}.`;
  return `This drops ${table} and everything in it. It can't be undone.`;
}

/** Held edits: the transaction core built, shown as it will run. */
export interface HeldEdits {
  /** `3 statements on public.kiosks: INSERT 1 · UPDATE 1 · DELETE 1` */
  summary: string;
  sql: string;
}

/**
 * Confirm writes: the strip at the top of the results card while a write
 * waits. Nothing has reached the database; ⇧⌘↵ runs it, Esc drops it. For
 * a table tab's edits it prints the exact statements, and Esc keeps them
 * staged.
 */
export function SafetyBar({
  hold,
  connection,
  database,
  catalog,
  mac,
  edits,
  onConfirm,
  onCancel,
}: {
  hold: SafetyHold;
  connection: ConnectionRecord | null;
  database: string | null;
  catalog: SchemaCatalog | null;
  mac: boolean;
  edits?: HeldEdits;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const statements = hold.statements;
  const keys = keysFor("confirm-write", mac);
  if (edits) {
    const where = [connection?.name, connection?.environment].filter(Boolean).join(" · ");
    return (
      <div data-testid="safe-bar" className="safe-bar safe-bar-edits" role="alert" data-held-edits>
        <span className="safe-bar-icon">
          <WarningIcon size={15} />
        </span>
        <span className="safe-bar-text">
          <b>Confirm writes{where ? ` · ${where}` : ""}</b>
          <span>{edits.summary}</span>
          <pre className="safe-bar-sql" data-held-sql>
            {edits.sql}
          </pre>
        </span>
        <button type="button" data-testid="safe-btn" className="safe-btn" onClick={onCancel} autoFocus>
          Keep editing <kbd>esc</kbd>
        </button>
        <button type="button" data-testid="safe-btn" className="safe-btn commit" data-commit-held onClick={onConfirm}>
          Commit <kbd><Keys text={keys} /></kbd>
        </button>
      </div>
    );
  }
  const destructive = statements.find((s) => s.destructive);
  const title =
    statements.length === 1
      ? `${statementLabel(statements[0])} isn't run yet`
      : `${statements.length} writes aren't run yet`;
  const where = [
    connection?.environment,
    [connection?.name, database].filter(Boolean).join(" / "),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      data-testid="safe-bar"
      className={`safe-bar${destructive ? " danger" : ""}`}
      data-tone={destructive ? "danger" : "go"}
      role="alert"
    >
      <span className="safe-bar-icon">
        <WarningIcon size={15} />
      </span>
      <span className="safe-bar-text">
        <b>{title}</b>
        {destructive ? (
          <span data-testid="safe-bar-warn" className="safe-bar-warn">{destructiveNote(destructive, catalog)}</span>
        ) : statements.length > 1 ? (
          <span>{statements.map(statementLabel).join(" · ")}</span>
        ) : null}
        <span>{where ? `${where} · ` : ""}Confirm writes is on for this connection</span>
      </span>
      <button type="button" data-testid="safe-btn" className="safe-btn" onClick={onCancel} autoFocus>
        Cancel <kbd>esc</kbd>
      </button>
      <button
        type="button"
        data-testid="safe-btn"
        className={`safe-btn ${destructive ? "danger" : "go"}`}
        data-tone={destructive ? "danger" : "go"}
        onClick={onConfirm}
      >
        {confirmLabel(hold)} <kbd><Keys text={keys} /></kbd>
      </button>
    </div>
  );
}

/** Read-only: what was refused, in place of the results. */
export function SafetyRefusal({
  hold,
  onChangeMode,
}: {
  hold: SafetyHold;
  onChangeMode: () => void;
}) {
  const statements = hold.statements;
  const what =
    statements.length === 1 ? statementLabel(statements[0]) : `${statements.length} writes`;
  const unlocks = statements.every((s) => s.unlocks_writes);
  return (
    <div data-testid="safe-refuse" className="safe-refuse" role="alert">
      <span className="safe-refuse-icon">
        <LockIcon size={18} />
      </span>
      <b>This connection is read-only</b>
      <p>
        <code>{what}</code> wasn't run.{" "}
        {unlocks
          ? "It would let later statements write."
          : "Nothing was sent to the database."}
      </p>
      <button type="button" data-testid="safe-btn" className="safe-btn" onClick={onChangeMode}>
        Change safe mode…
      </button>
    </div>
  );
}
