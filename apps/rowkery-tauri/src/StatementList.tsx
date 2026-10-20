import { useRef } from "react";
import { useGlideHover } from "./motion";
import { formatMs, type QueryResultDto } from "./types";
import "./StatementList.css";

/** What the results show of one statement of a run of several. */
export interface StatementResult {
  result: QueryResultDto | null;
  tableKey: string | null;
  /** Rows remained when it ran (only the run's last statement can still load them). */
  hasMore: boolean;
  paged?: boolean;
  ranSql?: string;
  runNo?: number;
}

const WRITES_ROWS = /^\s*(insert|update|delete|merge)\b/i;

/** "5 rows", "1 row changed", "Error": how one statement of a run ended. */
export function statementOutcome(s: StatementResult): string {
  const r = s.result;
  if (!r) return "";
  if (r.error) return "Error";
  if (r.cancelled) return "Cancelled";
  const count = (n: number, word: string) => `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;
  if (r.columns.length > 0) return s.hasMore ? `${r.row_count.toLocaleString()}+ rows` : count(r.row_count, "row");
  const changed = r.affected_rows ?? 0;
  return changed > 0 || WRITES_ROWS.test(s.ranSql ?? "") ? `${count(changed, "row")} changed` : "Done";
}

/**
 * Beside the grid after a run of several statements: each statement with how
 * it ended. Picking one shows its result; ↑ / ↓ step through them.
 */
export function StatementList({
  statements,
  at,
  disabled,
  onPick,
}: {
  statements: StatementResult[];
  at: number;
  disabled: boolean;
  onPick: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useGlideHover(listRef, "[data-statement]");
  const pick = (i: number) => {
    if (i < 0 || i >= statements.length) return;
    onPick(i);
    listRef.current?.querySelector<HTMLElement>(`[data-statement="${i}"]`)?.focus();
  };
  return (
    <div
      ref={listRef}
      data-testid="statement-list"
      className="statement-list"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Statements"
      onKeyDown={(e) => {
        if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        pick(at + (e.key === "ArrowDown" ? 1 : -1));
      }}
    >
      {statements.map((s, i) => {
        const failed = !!s.result?.error;
        return (
          <button
            key={i}
            type="button"
            role="tab"
            data-statement={i}
            data-state={failed ? "error" : undefined}
            aria-selected={i === at}
            tabIndex={i === at ? 0 : -1}
            disabled={disabled && i !== at}
            title={s.ranSql}
            onClick={() => pick(i)}
          >
            <span className="statement-sql">
              <span className="statement-no">{i + 1}</span>
              {s.ranSql?.replace(/\s+/g, " ")}
            </span>
            <span className="statement-meta" data-testid="statement-outcome">
              {statementOutcome(s)}
              {s.result && !failed && !s.result.cancelled && <span>{formatMs(s.result.elapsed_ms)}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
