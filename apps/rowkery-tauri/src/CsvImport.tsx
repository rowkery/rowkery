import { useEffect, useRef, useState } from "react";
import { fieldNames, importRows, remap, withHeader, type EmptyCells, type ImportDraft, type OnConflict } from "./importDraft";
import { GridMenu } from "./GridMenu";
import { InspectorHead } from "./Inspector";
import { ChevronDownIcon } from "./icons";
import "./CsvImport.css";

/** A running import: rows sent so far, and since when. */
export interface ImportRun {
  rows: number;
  startedAt: number;
}

const n = (x: number) => x.toLocaleString("en-US");

function Segment<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
  name,
}: {
  label: string;
  value: T;
  choices: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  name: string;
}) {
  return (
    <div className="ci-opt" data-import-option={name}>
      <span className="ci-opt-label">{label}</span>
      <div className="nc-segment" role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            data-choice={c.value}
            aria-checked={value === c.value}
            // nc-segment draws the picked choice from aria-selected.
            aria-selected={value === c.value}
            disabled={disabled}
            onClick={() => onChange(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** `0:03`. */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Import CSV (2026-10-21), in the inspector column beside the table's grid,
 * whose first rows show the file's (tinted, as new rows). Columns match by
 * name and each can be changed or skipped; Import writes every row in one
 * transaction (core), and on a Confirm writes connection this button is the
 * confirmation. While it runs: progress and Cancel and roll back.
 */
export function CsvImport({
  table,
  columns,
  draft,
  keyColumns,
  run,
  error,
  onChange,
  onImport,
  onCancelRun,
  onClose,
}: {
  table: string;
  /** The table's columns, in order. */
  columns: string[];
  draft: ImportDraft;
  /** The table's primary key: Update is offered when it has one. */
  keyColumns: string[];
  run: ImportRun | null;
  /** The last import's failure, with its line and column. */
  error: string | null;
  onChange: (d: ImportDraft) => void;
  onImport: () => void;
  onCancelRun: () => void;
  onClose: () => void;
}) {
  const names = fieldNames(draft);
  const rows = importRows(draft);
  const matched = draft.mapping.filter(Boolean).length;
  const [pick, setPick] = useState<{ field: number; at: { x: number; y: number } } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!run) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [run]);
  // Focus goes to the panel, not Import: on Confirm writes the button is the
  // confirmation, so a stray ↵ after a drop mustn't press it.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, [draft.path]);
  const busy = !!run;
  const conflictChoices: { value: OnConflict; label: string }[] = [
    { value: "stop", label: "Stop" },
    { value: "skip", label: "Skip" },
    ...(keyColumns.length ? [{ value: "update" as const, label: "Update" }] : []),
  ];
  const picked = pick ? draft.mapping[pick.field] : null;
  return (
    <>
      <InspectorHead onClose={onClose} data-testid="import-head">
        <h2 className="insp-title ci-title" title={`Import into ${table}`}>
          Import into {table}
        </h2>
      </InspectorHead>
      <div className="ci-body" data-import-body ref={bodyRef} tabIndex={-1}>
        <p className="ci-file" data-import-file title={draft.path}>
          {draft.preview.file_name} · {n(rows)} {rows === 1 ? "row" : "rows"} · {names.length}{" "}
          {names.length === 1 ? "column" : "columns"}
        </p>
        <Segment
          name="conflict"
          label="If a key already exists"
          value={draft.onConflict}
          choices={conflictChoices}
          disabled={busy}
          onChange={(onConflict) => onChange({ ...draft, onConflict })}
        />
        <Segment
          name="empty"
          label="Empty cells"
          value={draft.empty}
          choices={[
            { value: "null" as EmptyCells, label: "NULL" },
            { value: "text" as EmptyCells, label: "Empty text" },
          ]}
          disabled={busy}
          onChange={(empty) => onChange({ ...draft, empty })}
        />
        <Segment
          name="header"
          label="First row"
          value={draft.header ? "header" : "data"}
          choices={[
            { value: "header", label: "Header" },
            { value: "data", label: "Data" },
          ]}
          disabled={busy}
          onChange={(v) => onChange(withHeader(draft, v === "header", columns, { name: table, key: keyColumns }))}
        />
        <div className="insp-label ci-label" data-import-matched={matched}>
          Columns · {matched} of {names.length} matched
        </div>
        <ul className="ci-map" data-import-map>
          {names.map((name, i) => {
            const to = draft.mapping[i];
            return (
              <li key={i} className="ci-field" data-import-field={i} data-skipped={to ? undefined : ""}>
                <span className="ci-src" title={name}>
                  {name}
                </span>
                <span className="ci-arrow" aria-hidden>
                  →
                </span>
                <button
                  type="button"
                  className="ci-pick"
                  data-import-pick={i}
                  aria-haspopup="menu"
                  aria-label={`${name} goes to`}
                  disabled={busy}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPick({ field: i, at: { x: r.left, y: r.bottom + 4 } });
                  }}
                >
                  <span className="ci-pick-name">{to ?? "skip"}</span>
                  <ChevronDownIcon size={9} />
                </button>
              </li>
            );
          })}
        </ul>
        {error && (
          <div className="ci-error" data-import-error role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className={`insp-foot ci-foot${busy ? " running" : ""}`} data-import-foot>
        {run ? (
          <>
            <div className="ci-progress-line" data-import-progress={run.rows}>
              <span>
                Importing… {n(Math.min(run.rows, rows))} of {n(rows)}
              </span>
              <span className="ci-clock">{clock(Math.max(0, now - run.startedAt))}</span>
            </div>
            <div className="ci-bar" aria-hidden>
              <i style={{ width: `${rows ? Math.min(100, (run.rows / rows) * 100) : 0}%` }} />
            </div>
            <div className="ci-run-actions">
              <button type="button" className="insp-btn" data-import-cancel-run onClick={onCancelRun}>
                Cancel and roll back
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="insp-gap" />
            <button type="button" className="insp-btn ghost" data-import-close onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="insp-btn ink"
              data-import-run
              disabled={matched === 0 || rows === 0}
              onClick={onImport}
            >
              Import {n(rows)} {rows === 1 ? "row" : "rows"}
            </button>
          </>
        )}
      </footer>
      <GridMenu
        name="import-column"
        label="Column"
        at={pick?.at ?? null}
        items={[
          { id: "\u0000skip", label: "skip", checked: picked === null },
          ...columns.map((c, j) => ({
            id: c,
            label: c,
            checked: picked === c,
            separated: j === 0,
            gloss: draft.mapping.some((m, k) => m === c && k !== pick?.field) ? "taken" : undefined,
          })),
        ]}
        onPick={(id) => pick && onChange(remap(draft, pick.field, id === "\u0000skip" ? null : id))}
        onClose={() => setPick(null)}
      />
    </>
  );
}
