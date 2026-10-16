import { useMemo } from "react";
import type { RowStatement } from "./api";
import { keysFor } from "./commands";
import type { EditBuffer } from "./editBuffer";
import { InspectorHead } from "./Inspector";
import { showToast } from "./notify";
import { isMacPlatform } from "./platform";
import { highlightSqlLines } from "./sqlHighlight";
import { safeFormatCell, type ConnectionRecord, type Value } from "./types";
import { Keys } from "./Keys";

/** One statement of the transaction, as a card. */
export interface ReviewCard {
  verb: "insert" | "update" | "delete";
  sql: string;
  /** `kiosks · id 3 · city Ipoh → Klang` */
  summary: string;
}

const show = (v: Value | null | undefined) => (v == null || (typeof v === "object" && "Null" in v) ? "NULL" : safeFormatCell(v));

/** What each staged change does, in the order `bufferChanges` sends them (and core builds them). */
function summaries(buffer: EditBuffer, table: string): string[] {
  const out: string[] = [];
  const keyText = (key: { column: string; value: Value }[]) => key.map((k) => `${k.column} ${show(k.value)}`).join(", ");
  for (const ins of [...buffer.inserts].reverse()) {
    const set = Object.keys(ins.values);
    out.push(`${table} · new row${set.length ? ` · ${set.slice(0, 2).join(", ")}${set.length > 2 ? "…" : ""}` : ""}`);
  }
  for (const [k, u] of Object.entries(buffer.updates)) {
    if (k in buffer.deletes) continue;
    const cols = Object.keys(u.set);
    const first = cols[0];
    const change = first ? `${first} ${show(u.was[first])} → ${show(u.set[first])}` : "";
    out.push([table, keyText(u.key), change + (cols.length > 1 ? ` +${cols.length - 1}` : "")].filter(Boolean).join(" · "));
  }
  for (const key of Object.values(buffer.deletes)) out.push(`${table} · ${keyText(key)}`);
  return out;
}

/**
 * The cards: core's statements with a summary of the change each makes. When
 * core sent only the transaction text, its statements are read from it.
 */
export function reviewCards(
  buffer: EditBuffer | undefined,
  table: string,
  statements: RowStatement[],
  sql: string,
): ReviewCard[] {
  const said = buffer ? summaries(buffer, table) : [];
  if (statements.length) {
    return statements.map((s, i) => ({
      verb: s.verb,
      sql: s.sql,
      summary: said.length === statements.length ? said[i] : [table, s.predicate].filter(Boolean).join(" · "),
    }));
  }
  const lines = sql
    .split(/;\n/)
    .map((l) => l.trim().replace(/;$/, ""))
    .filter((l) => l && !/^(BEGIN|COMMIT)$/i.test(l));
  return lines.map((l, i) => {
    const verb = (/^(INSERT|UPDATE|DELETE)/i.exec(l)?.[1].toLowerCase() ?? "update") as ReviewCard["verb"];
    return { verb, sql: `${l};`, summary: said.length === lines.length ? said[i] : table };
  });
}

/**
 * Review SQL ⇧⌘P, in the inspector column (Paper, 2026-10-10; it was a
 * sheet): the exact transaction core built (BEGIN … COMMIT, a full-key
 * predicate on every UPDATE and DELETE), one card per statement. Commit ⌘S
 * (or ⇧⌘↵) runs exactly this text: on a Confirm writes connection the
 * review is the confirmation, since it shows what runs.
 */
export function ReviewSql({
  sql,
  cards,
  connection,
  error,
  onCommit,
  onClose,
}: {
  sql: string | null;
  cards: ReviewCard[] | null;
  connection: ConnectionRecord | null;
  /** Core refused to build the statements (a value its column can't take). */
  error: string | null;
  onCommit: () => void;
  onClose: () => void;
}) {
  const mac = isMacPlatform();
  const html = useMemo(() => (cards ?? []).map((c) => highlightSqlLines(c.sql).join("\n")), [cards]);
  const n = cards?.length ?? 0;
  const where = connection?.name ?? "this connection";
  const mode = connection?.safe_mode ?? "off";
  const note =
    mode === "read_only"
      ? "This connection is read-only: Commit won't write anything. Change safe mode to write."
      : `Runs in one transaction on ${where}. ${
          mode === "confirm" ? "Confirm writes is on: this review is the confirmation." : "Safe mode is off; Commit writes at once."
        } Each UPDATE and DELETE must change exactly 1 row, or nothing is kept.`;
  const copy = () =>
    sql &&
    navigator.clipboard.writeText(sql).then(
      () => showToast("Copied", "SQL"),
      () => showToast("Couldn't copy", undefined, "error"),
    );
  return (
    <>
      <InspectorHead onClose={onClose}>
        <h2 className="insp-title">Review SQL</h2>
        {cards && (
          <small className="insp-meta sans" data-review-meta>
            {n} {n === 1 ? "statement" : "statements"} · one transaction
          </small>
        )}
      </InspectorHead>
      <div className="rv-body" data-review-text={sql ?? ""}>
        {cards ? (
          cards.map((c, i) => (
            <div key={i} className="rv-card" data-review-card={c.verb} style={{ animationDelay: `${i * 50}ms` }}>
              <div className="rv-card-head">
                <span className={`rv-badge ${c.verb}`} data-review-badge>
                  {c.verb.toUpperCase()}
                </span>
                <span className="rv-summary" title={c.summary}>
                  {c.summary}
                </span>
              </div>
              <pre className="rv-card-sql" dangerouslySetInnerHTML={{ __html: html[i] }} />
            </div>
          ))
        ) : (
          <div className={`rv-wait${error ? " error" : ""}`} data-review-error={error ? "" : undefined}>
            {error ?? "Building the statements…"}
          </div>
        )}
        {cards && <p className="rv-note">{note}</p>}
      </div>
      <footer className="insp-foot">
        <button type="button" className="insp-btn" data-review-copy onClick={copy} disabled={!sql}>
          Copy SQL
        </button>
        <span className="insp-gap" />
        <button type="button" className="insp-btn ink" data-review-commit disabled={!sql} onClick={onCommit}>
          Commit <kbd><Keys text={keysFor("commit-edits", mac)} /></kbd>
        </button>
      </footer>
    </>
  );
}
