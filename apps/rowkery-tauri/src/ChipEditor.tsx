import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { GridMenu } from "./GridMenu";
import { CloseIcon } from "./icons";
import { SqlEditor, type EditorCompletion, type SqlEditorHandle } from "./SqlEditor";
import { FILTER_OPS, OP_WORDS, commonOps, defaultOp, type ChipColumn, type FilterOp } from "./filterChips";

/** What the chip editor holds until ↵: a new chip (`index` null) or chip `index` being edited. */
export interface ChipDraft {
  tabId: number;
  index: number | null;
  /** null: "any text column". */
  column: string | null;
  op: FilterOp;
  /** The value field: a value, or `col op value`, or free SQL. */
  value: string;
}

interface Props {
  draft: ChipDraft;
  columns: ChipColumn[];
  /** The table has text columns, so "any text column" is offered. */
  anyText: boolean;
  /** WHERE for the first chip, AND after others; empty when editing a chip in place. */
  lead: string;
  onDraft: (d: ChipDraft) => void;
  onApply: () => void;
  onEscape: () => boolean;
  completion?: EditorCompletion;
  readOnly?: boolean;
}

const ANY = "\0any";
/** The More… row (no operator is spelt this way). */
const MORE = "more";

/**
 * ⌘F's one chip editor, inline in the SQL line: column ▾ · operator ▾ ·
 * value (focused first, with completion). ↵ applies, Esc drops the draft.
 * The operator reads as a word (is, contains, more than…) and writes the
 * SQL the chip will show; its picker leads with the four a column of that
 * type most often wants, and More… lists them all.
 */
export const ChipEditor = forwardRef<SqlEditorHandle, Props>(function ChipEditor(p, valueRef) {
  const [menu, setMenu] = useState<{ which: "column" | "op"; x: number; y: number } | null>(null);
  // More… was picked: the operator menu lists every operator until it closes.
  const [allOps, setAllOps] = useState(false);
  const { draft } = p;
  const typeOf = (name: string | null) => p.columns.find((c) => c.name === name)?.type_name ?? "";
  const refocus = () =>
    requestAnimationFrame(() => {
      const h = (valueRef as React.RefObject<SqlEditorHandle | null>).current;
      h?.jumpTo(draft.value.length);
    });
  // The value takes focus as the editor appears, in the same commit as the
  // key that opened it: a key typed right after ⌘F lands in the value, not
  // the grid (a frame later, it went to the grid or nowhere).
  useLayoutEffect(() => {
    (valueRef as React.RefObject<SqlEditorHandle | null>).current?.jumpTo(draft.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = (which: "column" | "op") => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (which === "op") setAllOps(false);
    setMenu({ which, x: r.left, y: r.bottom + 6 });
  };
  const common = commonOps(typeOf(draft.column));
  // The common four (and the current one, if it is not among them), or all of them after More….
  const opRows = FILTER_OPS.filter((o) => allOps || common.includes(o.op) || o.op === draft.op).map((o) => ({
    id: o.op,
    label: OP_WORDS[o.op],
    gloss: o.op,
    checked: o.op === draft.op,
  }));
  // More… is a pick, and a pick closes the menu: this keeps it open, now with every operator.
  const keepOpen = useRef(false);
  return (
    <div
      className="chip-editor"
      data-chip-editor={draft.index ?? "new"}
      data-op={draft.op}
      data-column={draft.column ?? "*"}
      onKeyDown={(e) => {
        // The value field handles its own ↵ and Esc; these are for the pickers.
        if (e.defaultPrevented) return;
        if (e.key === "Enter") {
          e.preventDefault();
          p.onApply();
        } else if (e.key === "Escape") {
          e.preventDefault();
          p.onEscape();
        }
      }}
    >
      {p.lead && <span className="chip-editor-lead">{p.lead}</span>}
      <button type="button" className="chip-field" data-chip-column onClick={open("column")}>
        {draft.column ?? "any text column"} <span className="chip-caret">▾</span>
      </button>
      <button
        type="button"
        className="chip-field chip-op"
        data-chip-op
        disabled={draft.column === null}
        title={draft.column === null ? "Any text column contains the value" : `Writes ${draft.op}`}
        onClick={open("op")}
      >
        {OP_WORDS[draft.op]} <span className="chip-caret">▾</span>
      </button>
      <div className="chip-value">
        <SqlEditor
          ref={valueRef}
          compact
          value={draft.value}
          onChange={(v) => p.onDraft({ ...draft, value: v.replace(/\s*\n\s*/g, " ") })}
          onRun={p.onApply}
          onEscape={p.onEscape}
          readOnly={p.readOnly}
          completion={p.completion}
          placeholder={
            draft.op === "IS NULL" || draft.op === "IS NOT NULL"
              ? "↵ applies"
              : draft.op === "BETWEEN"
                ? "low and high"
                : draft.op === "IN"
                  ? "a, b, c"
                  : "value"
          }
        />
      </div>
      <button
        type="button"
        className="chip-add"
        data-chip-apply
        title="Apply this filter"
        onMouseDown={(e) => e.preventDefault()}
        onClick={p.onApply}
      >
        Add ↵
      </button>
      <button
        type="button"
        className="chip-cancel"
        data-chip-cancel
        aria-label="Cancel"
        title="Cancel  esc"
        onMouseDown={(e) => e.preventDefault()}
        onClick={p.onEscape}
      >
        <CloseIcon size={8} />
      </button>
      <GridMenu
        name="chip-column"
        label="Column"
        at={menu?.which === "column" ? menu : null}
        items={[
          ...(p.anyText ? [{ id: ANY, label: "any text column", checked: draft.column === null }] : []),
          ...p.columns.map((c) => ({ id: c.name, label: c.name, gloss: c.type_name, checked: draft.column === c.name })),
        ]}
        onPick={(id) => {
          const column = id === ANY ? null : id;
          p.onDraft({ ...draft, column, op: column === null ? "ILIKE" : defaultOp(typeOf(column)) });
          refocus();
        }}
        onClose={() => setMenu(null)}
      />
      <GridMenu
        name="chip-op"
        label="Operator"
        at={menu?.which === "op" ? menu : null}
        items={allOps ? opRows : [...opRows, { id: MORE, label: "More…", separated: true }]}
        onPick={(id) => {
          if (id === MORE) {
            keepOpen.current = true;
            setAllOps(true);
            return;
          }
          p.onDraft({ ...draft, op: id as FilterOp });
          refocus();
        }}
        onClose={() => {
          if (keepOpen.current) {
            keepOpen.current = false;
            return;
          }
          setMenu(null);
        }}
      />
    </div>
  );
});
