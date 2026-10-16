import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { commandById, eventMatches, formatChord } from "./commands";
import { boolOf, editorStartText, parseInput, type ColumnEditor } from "./editBuffer";
import { isMacPlatform } from "./platform";
import type { Value } from "./types";

/** Where the ring goes after a value is staged. */
export type EditMove = "down" | "right" | "left" | "none";

/** A row the foreign key picker found: the key it stages and a label. */
export interface KeyChoice {
  value: Value;
  label: string;
}

interface Props {
  editor: ColumnEditor;
  initial: Value | null;
  /** Where the editor sits over its cell (inside the grid's scrolled content). */
  style: CSSProperties;
  onStage: (value: Value | null, move: EditMove) => void;
  /** ↵ / Tab on a value left as it opened: the ring moves, nothing is staged. */
  onKeep: (move: EditMove) => void;
  onCancel: () => void;
  /** Focus left the editor (a click elsewhere): a changed value stays as a
   * pending edit (`value`), an unchanged one just closes (`undefined`);
   * focus stays where it went (2026-10-13). */
  onBlurDone: (value: Value | null | undefined) => void;
  /** The foreign key picker: rows of the referenced table matching the text. */
  searchKey?: (query: string) => Promise<KeyChoice[]>;
}

const isNull = (v: Value | null) => !v || "Null" in v;

/** ⌥⇧N (Ctrl+Alt+N): by code, since ⌥⇧N is a dead key in macOS text fields. */
function isSetNull(e: KeyboardEvent) {
  const chord = commandById("set-null")?.chord;
  return !!chord && eventMatches(e, chord, isMacPlatform());
}

const moveOf = (e: KeyboardEvent): EditMove => (e.key === "Tab" ? (e.shiftKey ? "left" : "right") : "down");

/**
 * A cell's typed editor, over the cell: text, number and date/time inputs,
 * an enum list from the catalog, a foreign key picker, a boolean that Space
 * toggles, and JSON in a larger pane. ↵ stages and moves down, Tab right,
 * Esc leaves the cell as it was, ⌥⇧N stages NULL. A value closed as it
 * opened (NULL's empty text, SQLite's 1 read as true) stages nothing.
 */
export function CellEditor(props: Props) {
  if (props.editor.kind === "bool") return <BoolEditor {...props} />;
  if (props.editor.kind === "json") return <JsonEditor {...props} />;
  return <TextEditor {...props} />;
}

function BoolEditor({ editor, initial, style, onStage, onKeep, onCancel }: Props) {
  // SQLite keeps booleans as 1 / 0: they read as true / false here.
  const [start] = useState<boolean | null>(() => (isNull(initial) ? null : (boolOf(initial) ?? false)));
  const [value, setValue] = useState<boolean | null>(start);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const stage = (v: boolean | null, move: EditMove) => onStage(v === null ? null : { Bool: v }, move);
  return (
    <div
      ref={ref}
      tabIndex={0}
      className="rg-editor rg-editor-bool"
      data-cell-editor="bool"
      data-value={value === null ? "NULL" : String(value)}
      style={style}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === " ") {
          e.preventDefault();
          // true → false → NULL (when the column takes it) → true.
          setValue((v) => (v === true ? false : v === false && editor.nullable ? null : true));
        } else if (isSetNull(e) && editor.nullable) {
          e.preventDefault();
          stage(null, "none");
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (value === start && (start === null || boolOf(initial) === start)) onKeep(moveOf(e));
          else stage(value, moveOf(e));
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {value === null ? <span data-testid="rg-null" className="rg-null">NULL</span> : String(value)}
      <span className="rg-editor-hint">Space</span>
    </div>
  );
}

function JsonEditor({ initial, style, onStage, onKeep, onCancel, onBlurDone, editor }: Props) {
  // The stored text, pretty-printed only when no number changes (editBuffer.ts).
  const [start] = useState(() => editorStartText("json", initial));
  const [text, setText] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const mac = isMacPlatform();
  return (
    <div className="rg-editor rg-editor-json" style={{ ...style, height: "auto" }} data-cell-editor="json">
      <textarea
        ref={ref}
        value={text}
        spellCheck={false}
        aria-invalid={!!error}
        data-editor-error={error ?? undefined}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        // Clicking away keeps a changed value as a pending edit (2026-10-13);
        // text that isn't JSON is dropped, as Esc would.
        onBlur={() => {
          if (done.current) return;
          done.current = true;
          if (text === start) return onBlurDone(undefined);
          const parsed = parseInput("json", text);
          onBlurDone("error" in parsed ? undefined : parsed.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            done.current = true;
            onCancel();
          } else if (isSetNull(e) && editor.nullable) {
            e.preventDefault();
            done.current = true;
            onStage(null, "none");
          } else if (e.key === "Enter" && (mac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault();
            // Untouched: nothing to stage (a rewritten jsonb would be an edit).
            if (text === start) {
              done.current = true;
              onKeep("none");
              return;
            }
            const parsed = parseInput("json", text);
            if ("error" in parsed) setError(parsed.error);
            else {
              done.current = true;
              onStage(parsed.value, "none");
            }
          }
        }}
      />
      <span className="rg-editor-foot">{error ?? `Enter JSON · ${formatChord({ mac: "Mod+Enter" }, mac)} stages`}</span>
    </div>
  );
}

function TextEditor({ editor, initial, style, onStage, onKeep, onCancel, onBlurDone, searchKey }: Props) {
  const [start] = useState(() => editorStartText(editor.kind, initial));
  const [text, setText] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<KeyChoice[]>([]);
  const [cursor, setCursor] = useState(-1);
  const listId = useId();
  // The enum list filters once something is typed; until then it lists every label.
  const [typed, setTyped] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  // The foreign key picker searches as the text settles.
  useEffect(() => {
    if (!searchKey) return;
    let live = true;
    const t = window.setTimeout(() => {
      searchKey(text).then(
        (rows) => live && setFound(rows.slice(0, 8)),
        () => live && setFound([]),
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [searchKey, text]);
  const labels =
    editor.kind === "enum" ? (editor.labels ?? []).filter((l) => !typed || l.toLowerCase().includes(text.toLowerCase())) : [];
  const choices: KeyChoice[] = editor.kind === "enum" ? labels.map((l) => ({ value: { Text: l }, label: l })) : found;
  const finish = (value: Value | null, move: EditMove) => {
    done.current = true;
    onStage(value, move);
  };
  const stageText = (move: EditMove) => {
    // Untouched (NULL's empty text too): nothing to stage, the ring just moves.
    if (text === start) {
      done.current = true;
      onKeep(move);
      return;
    }
    const parsed = parseInput(editor.kind, text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    finish(parsed.value, move);
  };
  const number = editor.kind === "int" || editor.kind === "number";
  return (
    <div className="rg-editor" style={style} data-cell-editor={editor.fk ? "fk" : editor.kind}>
      <input
        ref={ref}
        className={`rg-editor-input${number ? " rg-num" : ""}`}
        value={text}
        spellCheck={false}
        placeholder={editor.fk ? `Search ${editor.fk.table}…` : editor.placeholder}
        aria-invalid={!!error}
        role={choices.length > 0 ? "combobox" : undefined}
        aria-expanded={choices.length > 0 || undefined}
        aria-controls={choices.length > 0 ? listId : undefined}
        aria-activedescendant={choices[cursor] ? `${listId}-${cursor}` : undefined}
        data-editor-error={error ?? undefined}
        onChange={(e) => {
          setText(e.target.value);
          setTyped(true);
          setError(null);
          setCursor(-1);
        }}
        // Clicking away keeps a changed value as a pending edit (2026-10-13);
        // a value that doesn't parse is dropped, as Esc would.
        onBlur={() => {
          if (done.current) return;
          done.current = true;
          if (text === start) return onBlurDone(undefined);
          const parsed = parseInput(editor.kind, text);
          onBlurDone("error" in parsed ? undefined : parsed.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown" && choices.length) {
            e.preventDefault();
            setCursor((c) => Math.min(choices.length - 1, c + 1));
          } else if (e.key === "ArrowUp" && choices.length) {
            e.preventDefault();
            setCursor((c) => Math.max(-1, c - 1));
          } else if (isSetNull(e)) {
            e.preventDefault();
            if (editor.nullable) finish(null, "none");
            else setError("Can't be NULL");
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const pick = choices[cursor] ?? (editor.kind === "enum" && labels.length === 1 ? choices[0] : undefined);
            if (pick) finish(pick.value, moveOf(e));
            else stageText(moveOf(e));
          } else if (e.key === "Escape") {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
      />
      {error && <span className="rg-editor-error">{error}</span>}
      {choices.length > 0 && (
        <div className="rg-editor-list" role="listbox" id={listId} aria-label="Choices" data-editor-list>
          {choices.map((c, i) => (
            <div
              key={`${i}:${c.label}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === cursor}
              className={i === cursor ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                finish(c.value, "none");
              }}
            >
              {c.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
