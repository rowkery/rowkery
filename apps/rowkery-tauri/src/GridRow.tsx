import { memo } from "react";
import { CELL_SHOWN_CHARS, CELL_TITLE_CHARS, clipText } from "./gridLayout";
import { HIDDEN_TEXT } from "./presenting";
import { valueText, type ResultRows } from "./resultStore";
import type { RowEditState } from "./gridTypes";
import type { Column, Value } from "./types";

/** `2026-09-27 06:12:44.201+00` → date, time, then fraction and zone. */
const TIMESTAMP_PARTS = /^(\d{4}-\d{2}-\d{2})([ T])(\d{2}:\d{2}:\d{2})(.*)$/;

/** Rows past this one enter together, so a tall window doesn't wait; REVEAL_MS in ResultsGrid.tsx must outlast the last delay. */
const REVEAL_ROWS = 24;

/** Timestamps read by their time: the date and fraction are dimmed. */
function TimestampText({ text }: { text: string }) {
  const m = TIMESTAMP_PARTS.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <span className="rg-ts-date">{m[1]}</span>
      {m[2]}
      {m[3]}
      {m[4] && <span className="rg-ts-rest">{m[4]}</span>}
    </>
  );
}

/** Per column: how its cells print (fixed per result). */
export interface ColumnLooks {
  numeric: boolean[];
  json: boolean[];
  timestamp: boolean[];
  /** Presenting hides it: dots for every cell. */
  hidden: boolean[];
}

interface RowProps {
  index: number;
  /** Its top, from the row virtualizer. */
  start: number;
  rows: ResultRows;
  columns: Column[];
  /** Rendered columns `c0`–`c1`; `pad` stands in for the ones left of them. */
  c0: number;
  c1: number;
  pad: number;
  widths: number[];
  gutterWidth: number;
  totalWidth: number;
  looks: ColumnLooks;
  /** The ring's column when it is on this row, else -1. */
  activeCol: number;
  multi: boolean;
  /** The selected block's columns when it covers this row, else -1. */
  selC0: number;
  selC1: number;
  findSet: ReadonlySet<string>;
  /** The current find match's column when it is on this row, else -1. */
  findCol: number;
  /** Staged edits on this row; `editVersion` redraws it when they change. */
  edit?: RowEditState;
  editVersion?: number;
  /** `aria-rowindex` of row 0: after the header row and any new rows. */
  ariaRow0: number;
  /** The active cell's id (`aria-activedescendant`) when the ring is on this row. */
  activeId?: string;
  /** Quick Look shows this row: it takes the accent wash. */
  looked?: boolean;
}

/**
 * One grid row. Memoized: scrolling renders only the rows that came into
 * view, and a selection change only the rows it touches. Rows only ever
 * append, so a row's cells never change under it.
 */
export const Row = memo(function Row({
  index: r,
  start,
  rows,
  columns,
  c0,
  c1,
  pad,
  widths,
  gutterWidth,
  totalWidth,
  looks,
  activeCol,
  multi,
  selC0,
  selC1,
  findSet,
  findCol,
  edit,
  ariaRow0,
  activeId,
  looked,
}: RowProps) {
  const cells = [];
  for (let ci = c0; ci <= c1; ci++) {
    const staged = edit?.cells.get(ci);
    const isNull = staged ? !staged.value || "Null" in staged.value : rows.isNull(r, ci);
    const text = isNull ? "" : staged ? valueText(staged.value ?? undefined) : rows.text(r, ci);
    let cls = staged ? "rg-cell rg-cell-edited" : "rg-cell";
    if (looks.numeric[ci] || rows.isNumber(r, ci)) cls += " rg-num";
    if (rows.isBool(r, ci)) cls += text === "true" ? " rg-true" : " rg-false";
    else if (looks.json[ci]) cls += " rg-json";
    const active = activeCol === ci;
    const sel = ci >= selC0 && ci <= selC1;
    const find = findSet.size && findSet.has(`${r}:${ci}`) ? (findCol === ci ? "current" : "match") : undefined;
    if (active) cls += " rg-cell-active";
    if (sel) cls += " rg-cell-sel";
    if (find) cls += find === "current" ? " rg-find rg-find-current" : " rg-find";
    const hidden = looks.hidden[ci];
    if (hidden) cls += " rg-cell-hidden";
    cells.push(
      <div
        key={`${ci}:${columns[ci].name}`}
        id={active ? activeId : undefined}
        role="gridcell"
        aria-colindex={ci + 2}
        aria-selected={sel || active}
        data-col={ci}
        data-edited={staged ? "" : undefined}
        data-active={active ? "" : undefined}
        data-selected={sel ? "" : undefined}
        data-find={find}
        className={cls}
        style={{ width: widths[ci] }}
        data-hidden={hidden ? "" : undefined}
        title={
          hidden ? undefined : staged ? `Was ${wasText(staged.was)} · Esc reverts` : isNull ? "NULL" : clipText(text, CELL_TITLE_CHARS)
        }
      >
        {hidden ? (
          HIDDEN_TEXT
        ) : isNull ? (
          <span data-testid="rg-null" className="rg-null">NULL</span>
        ) : looks.timestamp[ci] ? (
          <TimestampText text={text} />
        ) : (
          clipText(text, CELL_SHOWN_CHARS)
        )}
      </div>,
    );
  }
  return (
    <div
      role="row"
      aria-rowindex={ariaRow0 + r}
      data-row={r}
      data-mark={edit?.mark}
      className={`rg-row${r % 2 ? " rg-odd" : ""}${activeCol >= 0 && !multi ? " rg-row-active" : ""}${
        selC0 >= 0 ? " rg-row-sel" : ""
      }${edit ? ` rg-row-${edit.mark}` : ""}${looked ? " rg-row-looked" : ""}`}
      data-looked={looked ? "" : undefined}
      style={{
        transform: `translateY(${start}px)`,
        width: totalWidth,
        ["--i" as string]: Math.min(r, REVEAL_ROWS),
      }}
    >
      <div data-testid="rg-gutter" className="rg-gutter" role="rowheader" aria-colindex={1} style={{ width: gutterWidth }}>
        {edit && <i className="rg-mark-dot" />}
        {r + 1}
      </div>
      {pad > 0 && <span className="rg-colpad" aria-hidden style={{ width: pad }} />}
      {cells}
    </div>
  );
});

/** "Petaling J." for the edited cell's tooltip. */
function wasText(v: Value | null): string {
  if (!v || "Null" in v) return "NULL";
  const t = valueText(v);
  return t.length > 24 ? `${t.slice(0, 22)}…` : t;
}
