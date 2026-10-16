import { useState } from "react";
import type { PlanStep, QueryPlan } from "./api";
import { showToast, toastPreview } from "./notify";
import "./PlanView.css";

/**
 * ⌘E's plan, in place of the results: one hint on top, then one row per
 * step with the share of time (or cost, for an estimate) spent in the step
 * itself. The slowest step is tinted; row guesses 10× off get a tag. A row
 * opens to its details (filter, index condition, rows removed, buffers).
 */
export function PlanView({ plan }: { plan: QueryPlan }) {
  const [open, setOpen] = useState<number | null>(plan.slowest);
  const weight = (s: PlanStep) => (plan.timed ? (s.ownMs ?? 0) : (s.ownCost ?? 0));
  const total = plan.steps.reduce((sum, s) => sum + weight(s), 0);
  const hint = plan.hint;
  return (
    <div className="plan" data-plan data-timed={plan.timed ? "" : undefined}>
      {hint && (
        <div className="plan-hint" data-plan-hint>
          <BulbIcon />
          <div className="plan-hint-text">
            {hint.text}
            {hint.sql && <code data-plan-hint-sql>{hint.sql}</code>}
          </div>
          {hint.sql && (
            <button type="button" className="results-export" data-plan-copy-hint onClick={() => void copy(hint.sql!, "SQL")}>
              Copy
            </button>
          )}
        </div>
      )}
      <div className="plan-steps" role="table" aria-label="Plan">
        <div className="plan-row plan-head" role="row">
          <span role="columnheader">Step</span>
          <span role="columnheader">{plan.timed ? "Own time" : "Own cost"}</span>
          <span role="columnheader" className="num">
            {plan.timed ? "ms" : "cost"}
          </span>
          {plan.steps.some((s) => s.expectedRows !== null) && (
            <span role="columnheader" className="num">
              {plan.timed ? "Rows, expected → actual" : "Rows, expected"}
            </span>
          )}
        </div>
        {plan.steps.map((step, i) => {
          const share = total > 0 ? weight(step) / total : 0;
          const expanded = open === i && step.details.length > 0;
          return (
            <div key={i} role="rowgroup">
              <button
                type="button"
                role="row"
                className="plan-row plan-step"
                data-plan-step={i}
                data-slowest={plan.slowest === i ? "" : undefined}
                data-open={expanded ? "" : undefined}
                aria-expanded={step.details.length ? expanded : undefined}
                onClick={() => setOpen(open === i ? null : i)}
              >
                <span role="cell" className="plan-name">
                  {Array.from({ length: step.depth }, (_, d) => (
                    <span key={d} className="plan-indent" />
                  ))}
                  <span className="plan-kind">{step.kind}</span>
                  <StepTarget step={step} />
                </span>
                <span role="cell" className="plan-bar">
                  <i style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
                </span>
                <span role="cell" className="num">
                  {plan.timed ? formatMs(step.ownMs) : formatCost(step.ownCost)}
                </span>
                {step.expectedRows !== null && (
                  <span role="cell" className="num plan-rows">
                    <RowCounts step={step} timed={plan.timed} />
                  </span>
                )}
              </button>
              {expanded && (
                <div className="plan-details" data-plan-details style={{ paddingLeft: 14 + 13 * step.depth + 14 }}>
                  {step.details.map((d) => (
                    <span key={d.label}>
                      <b>{d.label}</b>
                      {d.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepTarget({ step }: { step: PlanStep }) {
  const on = step.table ? (step.alias && step.alias !== step.table ? `${step.table} ${step.alias}` : step.table) : null;
  const parts = [
    on && `on ${on}`,
    step.index && `using ${step.index}`,
    step.note,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="plan-on">{parts.join(" ")}</span>;
}

function RowCounts({ step, timed }: { step: PlanStep; timed: boolean }) {
  const loops = step.loops ?? 1;
  return (
    <>
      {timed && step.actualRows !== null ? (
        <>
          {count(step.expectedRows!)} → {count(step.actualRows)}
        </>
      ) : (
        count(step.expectedRows!)
      )}
      {timed && loops > 1 && <span className="plan-loops"> × {count(loops)}</span>}
      {step.miss !== null && (
        <span className="plan-miss" data-plan-miss title="Postgres guessed this row count badly">
          {Math.round(step.miss)}× off
        </span>
      )}
    </>
  );
}

/** The plan as text, for Copy as text: one line per step, indented. */
export function planText(plan: QueryPlan): string {
  const lines = plan.steps.map((s) => {
    const on = [s.table && `on ${s.table}`, s.index && `using ${s.index}`, s.note].filter(Boolean).join(" ");
    const time = plan.timed ? `  ${formatMs(s.ownMs)} ms` : `  cost ${formatCost(s.ownCost)}`;
    const rows =
      s.expectedRows === null
        ? ""
        : plan.timed && s.actualRows !== null
          ? `  rows ${count(s.expectedRows)} → ${count(s.actualRows)}${(s.loops ?? 1) > 1 ? ` × ${count(s.loops!)}` : ""}`
          : `  rows ≈${count(s.expectedRows)}`;
    const head = `${"  ".repeat(s.depth)}${s.kind}${on ? ` ${on}` : ""}${time}${rows}`;
    const details = s.details.map((d) => `${"  ".repeat(s.depth + 1)}${d.label}: ${d.value}`);
    return [head, ...details].join("\n");
  });
  if (plan.hint) lines.push("", plan.hint.text, ...(plan.hint.sql ? [plan.hint.sql] : []));
  return lines.join("\n");
}

export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${what}`, toastPreview(text));
  } catch (err) {
    showToast("Couldn't copy", String(err), "error");
  }
}

function formatMs(ms: number | null): string {
  if (ms === null) return "";
  if (ms >= 100) return Math.round(ms).toLocaleString();
  if (ms >= 1) return ms.toFixed(1);
  return ms.toFixed(2);
}

function formatCost(cost: number | null): string {
  return cost === null ? "" : Math.round(cost).toLocaleString();
}

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  return Math.round(n).toLocaleString();
}

function BulbIcon() {
  return (
    <svg className="plan-hint-icon" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z" />
    </svg>
  );
}
