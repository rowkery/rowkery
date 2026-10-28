import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fieldNames, importRows, remap, withHeader, type EmptyCells, type ImportDraft, type OnConflict } from "./importDraft";
import { useOutsideClose } from "./ConnectionSwitcher";
import { Floating } from "./Floating";
import { GridMenu } from "./GridMenu";
import { InspectorHead } from "./Inspector";
import { ChevronDownIcon, SearchIcon } from "./icons";
import { useCursorIntoView, usePointerCursor } from "./listCursor";
import { Presence, useGlideHover } from "./motion";
import { filterByName } from "./nameFilter";
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

/** A choice in the panel's Connection or Table picker. */
export interface PickChoice {
  id: string;
  name: string;
  /** Beside the name: `7 of 8 columns`. */
  gloss?: string;
}

/**
 * The panel's Connection / Table row: the picked name on a chip, and a
 * filterable list under it (the database switcher's), best choices first.
 */
function Picker({
  name,
  label,
  value,
  placeholder,
  choices,
  disabled,
  active,
  onPick,
}: {
  /** The window is shown: a hidden one's list closes (it's portalled above every window). */
  active: boolean;
  name: string;
  label: string;
  value: string | null;
  placeholder: string;
  choices: PickChoice[];
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useOutsideClose(rootRef, open, () => setOpen(false), layerRef);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  // The list is placed once; the panel scrolling under it closes it rather than leave it adrift.
  useEffect(() => {
    if (!open) return;
    const body = rootRef.current?.closest(".ci-body");
    const close = () => setOpen(false);
    body?.addEventListener("scroll", close);
    return () => body?.removeEventListener("scroll", close);
  }, [open]);
  /** Esc or a pick: back to the chip, so the keyboard carries on from it. */
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };
  const current = choices.find((c) => c.id === value);
  return (
    <div className="ci-opt" data-import-option={name}>
      <span className="ci-opt-label">{label}</span>
      <div className="ci-picker" ref={rootRef}>
        <button
          type="button"
          className="ci-pick"
          data-import-picker={name}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}: ${current?.name ?? placeholder}`}
          ref={buttonRef}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`ci-pick-name${current ? "" : " ci-pick-empty"}`}>{current?.name ?? placeholder}</span>
          <ChevronDownIcon size={9} />
        </button>
        <Floating anchor={rootRef} layerRef={layerRef}>
          <Presence open={open}>
            <PickList
              name={name}
              label={label}
              value={value}
              choices={choices}
              onClose={close}
              onPick={(id) => {
                close();
                if (id !== value) onPick(id);
              }}
            />
          </Presence>
        </Floating>
      </div>
    </div>
  );
}

function PickList({
  name,
  label,
  value,
  choices,
  onClose,
  onPick,
}: {
  name: string;
  label: string;
  value: string | null;
  choices: PickChoice[];
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterByName(choices, query, (c) => c.name), [choices, query]);
  const at = () =>
    Math.max(
      0,
      choices.findIndex((c) => c.id === value),
    );
  const [cursor, setCursor] = useState(at);
  // Typing puts the cursor on the best match; an empty filter puts it back on the pick.
  useEffect(() => setCursor(query.trim() ? 0 : at()), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => inputRef.current?.focus(), []);
  const listRef = useRef<HTMLUListElement>(null);
  useGlideHover(listRef, ".db-option");
  const listId = useId();
  useCursorIntoView(listRef, cursor, matches.length);
  const hover = usePointerCursor(setCursor);
  return (
    <div
      data-import-popover={name}
      className="conn-popover db-popover ci-popover"
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const m = matches[cursor];
          if (m) onPick(m.id);
        }
      }}
    >
      <label className="conn-search">
        <SearchIcon size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder={`Filter ${label.toLowerCase()}s…`}
          aria-label={`Filter ${label.toLowerCase()}s`}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={matches[cursor] ? `${listId}-${cursor}` : undefined}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul className="conn-list" role="listbox" id={listId} aria-label={`${label}s`} ref={listRef}>
        {matches.length === 0 ? (
          <li className="conn-empty">{choices.length ? "No matches" : `No ${label.toLowerCase()}s`}</li>
        ) : (
          matches.map((c, i) => (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === cursor} aria-current={c.id === value || undefined}>
              <button
                type="button"
                data-import-choice={c.id}
                className={`conn-option db-option${i === cursor ? " cursor" : ""}`}
                onMouseMove={hover(i)}
                onClick={() => onPick(c.id)}
              >
                <span className="db-check">{c.id === value ? "✓" : ""}</span>
                <span className="db-option-name">{c.name}</span>
                {c.gloss && <span className="db-option-size">{c.gloss}</span>}
              </button>
            </li>
          ))
        )}
      </ul>
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
 * whose first rows show the file's (tinted, as new rows). The connection and
 * table come prefilled and can be changed; columns match by name and each
 * can be changed or skipped. Import writes every row in one transaction
 * (core), and on a Confirm writes connection this button is the
 * confirmation. While it runs: progress and Cancel and roll back.
 */
export function CsvImport({
  active,
  connectionId,
  connections,
  onPickConnection,
  tableKey,
  tables,
  onPickTable,
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
  active: boolean;
  connectionId: string;
  connections: PickChoice[];
  /** Another connection: the import moves to a window on it. */
  onPickConnection: (id: string) => void;
  /** Null until a table is picked (nothing fitted the file). */
  tableKey: string | null;
  /** The tables the file can go into, best fit first. */
  tables: PickChoice[];
  onPickTable: (key: string) => void;
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
  const [pick, setPick] = useState<{
    field: number;
    at: { x: number; y: number };
  } | null>(null);
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
  // Update finds each row by its whole key: without it every row would be new.
  const unmappedKey = draft.onConflict === "update" ? keyColumns.filter((k) => !draft.mapping.includes(k)) : [];
  return (
    <>
      <InspectorHead onClose={onClose} data-testid="import-head">
        <h2 className="insp-title ci-title">Import CSV</h2>
      </InspectorHead>
      <div className="ci-body" data-import-body ref={bodyRef} tabIndex={-1}>
        <p className="ci-file" data-import-file title={draft.path}>
          {draft.preview.file_name} · {n(rows)} {rows === 1 ? "row" : "rows"} · {names.length} {names.length === 1 ? "column" : "columns"}
        </p>
        <Picker
          name="connection"
          label="Connection"
          value={connectionId}
          placeholder="Connection"
          choices={connections}
          disabled={busy}
          active={active}
          onPick={onPickConnection}
        />
        <Picker name="table" label="Table" value={tableKey} placeholder="Choose…" choices={tables} disabled={busy} active={active} onPick={onPickTable} />
        {tableKey && (
          <>
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
              onChange={(v) =>
                onChange(
                  withHeader(draft, v === "header", columns, {
                    name: table,
                    key: keyColumns,
                  }),
                )
              }
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
                        setPick({
                          field: i,
                          at: { x: r.left, y: r.bottom + 4 },
                        });
                      }}
                    >
                      <span className="ci-pick-name">{to ?? "skip"}</span>
                      <ChevronDownIcon size={9} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {unmappedKey.length > 0 && (
          <div className="ci-error" data-import-unmapped-key role="alert">
            Update finds rows by {unmappedKey.join(", ")}. Match a column to {unmappedKey.length === 1 ? "it" : "each"}, or pick Stop or Skip.
          </div>
        )}
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
              <i
                style={{
                  width: `${rows ? Math.min(100, (run.rows / rows) * 100) : 0}%`,
                }}
              />
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
              disabled={!tableKey || matched === 0 || rows === 0 || unmappedKey.length > 0}
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
