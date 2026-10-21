import { quoteBackspace, quoteTyped } from "./quotePairs";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CompletionPopup } from "./CompletionPopup";
import type { CompletionResult } from "./sqlComplete";
import { createSqlScan, lineAtOffset, lineStartOffsets, type SqlScan } from "./sqlHighlight";
import { BLOCK, CATCH_UP_BLOCKS, linesNeeded, pickShownLines, type ShownLines } from "./sqlLineBlocks";
import { formatSql, formatTarget, type FormatDialect } from "./sqlFormat";
import { sqlToRun, statementRangeAtOffset, type CharRange } from "./sqlStatements";

export interface SqlEditorHandle {
  getSqlToRun: () => string;
  /** What ⌘↵ would run and where it starts in the text (error positions count from there). */
  getRunTarget: () => { sql: string; start: number };
  /** Puts the caret at `offset` (the editor keeps focus) and scrolls it into view. */
  jumpTo: (offset: number) => void;
  /** Replaces `from..to` with `text` as one undo step. */
  replaceRange: (from: number, to: number, text: string) => void;
  focus: () => void;
  /** Replace the selection with `text`, keeping native undo. */
  insertText: (text: string) => void;
  /**
   * Formats the statements the selection touches, or the one under the caret,
   * as one undo step. Resolves to the parse error when it couldn't, else null.
   */
  format: (dialect: FormatDialect) => Promise<string | null>;
}

/** Schema-aware completion, supplied by the window that owns the schema. */
export interface EditorCompletion {
  complete: (text: string, caret: number, explicit: boolean) => CompletionResult | null;
  /** `*` right before the caret, as the column list it stands for. */
  expandStar: (
    text: string,
    caret: number,
  ) => { from: number; to: number; insert: string } | null;
}

/** The token a failed run pointed at: a dotted underline until the next edit. */
export interface EditorMark {
  start: number;
  end: number;
}

interface Props {
  /** A failed run's token, underlined. */
  mark?: EditorMark | null;
  /** ↵ with the caret inside the mark (no completion open): true when handled. */
  onMarkEnter?: () => boolean;
  value: string;
  onChange: (value: string) => void;
  onRun: (sql: string) => void;
  completion?: EditorCompletion;
  /**
   * Locks editing while the tab's query runs. Read-only rather than disabled:
   * disabling a focused textarea drops focus, so the next ⌘↵ went nowhere.
   */
  readOnly?: boolean;
  /**
   * One line, no gutter: a table tab's filter. ↵ (and ⌘↵) apply it, and Esc
   * calls `onEscape`, which returns whether it used the key.
   */
  compact?: boolean;
  onEscape?: () => boolean;
  placeholder?: string;
}

/** Typing one of these opens (or keeps refreshing) the completion list. */
const TRIGGER = /^[A-Za-z0-9_$."']$/;

interface OpenCompletion {
  result: CompletionResult;
  cursor: number;
  explicit: boolean;
  /** The cursor was moved with the arrows (a one-line field's ↵ then takes the item). */
  moved?: boolean;
  anchor: DOMRect;
}

/** Width of one digit of the 12.5px editor font, for sizing the gutter. */
const DIGIT_PX = 7.6;

/**
 * One line of the coloured overlay. The line number is drawn by CSS from
 * `data-n` in the gutter to its left, so it stays on the line's first row when
 * a long line wraps. `st` lines belong to the statement ⌘↵ runs.
 */
const SqlLine = memo(function SqlLine({
  n,
  html,
  cls,
}: {
  n: number;
  html: string;
  cls: string;
}) {
  return <div className={cls} data-n={n} dangerouslySetInnerHTML={{ __html: html }} />;
});

interface LineDecor {
  stFirst: number;
  stLast: number;
  caretLine: number;
  markLine: number;
}

/**
 * `BLOCK` lines of the overlay, as a fragment (the pre's children stay one
 * div per line). A keystroke re-renders only the block whose lines or
 * decorations changed, so a 5,000-line text reconciles ~80 blocks instead of
 * 5,000 lines. `decor` is the part of `LineDecor` that touches this block;
 * the unchanged lines keep their string identity from the incremental
 * highlighter, so the comparison is mostly pointer checks.
 */
const SqlLineBlock = memo(
  function SqlLineBlock({
    from,
    html,
    d,
  }: {
    from: number;
    html: string[];
    decor: string;
    d: LineDecor;
  }) {
    return (
      <>
        {html.map((h, k) => {
          const i = from + k;
          let cls = "ln";
          if (i >= d.stFirst && i <= d.stLast) {
            cls += " st";
            if (i === d.stFirst) cls += " st-first";
            if (i === d.stLast) cls += " st-last";
          }
          if (i === d.caretLine) cls += " cur";
          if (i === d.markLine) cls += " err";
          return <SqlLine key={i} n={i + 1} html={h} cls={cls} />;
        })}
      </>
    );
  },
  (a, b) =>
    a.from === b.from &&
    a.decor === b.decor &&
    a.html.length === b.html.length &&
    a.html.every((h, k) => h === b.html[k]),
);

/** What of `d` shows in lines `[from, to)`, as a key: equal keys render equal blocks. */
function blockDecor(d: LineDecor, from: number, to: number): string {
  const inside = (i: number) => (i >= from && i < to ? i : -1);
  const st =
    d.stLast < from || d.stFirst >= to ? "-" : `${Math.max(d.stFirst, from - 1)}:${Math.min(d.stLast, to)}`;
  return `${st}|${inside(d.caretLine)}|${inside(d.markLine)}`;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { value, onChange, onRun, readOnly, completion, compact, onEscape, placeholder, mark, onMarkEnter },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const marksRef = useRef<HTMLPreElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [ac, setAc] = useState<OpenCompletion | null>(null);
  const acId = useId();
  const acRef = useRef(ac);
  acRef.current = ac;
  /** Caret the last edit left, so a caret move from elsewhere closes the list. */
  const editCaret = useRef(-1);
  /** Our own insert fires an input event; it must not reopen the list. */
  const accepting = useRef(false);

  const syncCaretFromTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    if (acRef.current && (start !== end || start !== editCaret.current)) setAc(null);
    // Bail out of re-rendering when the caret did not move.
    setSelection((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  const lineStarts = useMemo(() => lineStartOffsets(value), [value]);
  const caretLine = lineAtOffset(lineStarts, selection.end);

  // New colours go in near the caret at once; far blocks whose text didn't
  // change catch up a few per task after the key (sqlLineBlocks.ts), and the
  // highlighter colours only as far as the blocks that show its work.
  const shown = useRef<ShownLines | null>(null);
  const caught = useRef({ value, blocks: new Set<number>() });
  if (caught.current.value !== value) caught.current = { value, blocks: new Set() };
  const [, setCaughtUp] = useState(0);
  const caretBlock = Math.floor(caretLine / BLOCK);

  // Scan once per edit, and only from the first changed line (the scanners
  // cache each line's lexer state); caret moves only walk the cached ranges.
  const scan = useRef<SqlScan | null>(null);
  scan.current ??= createSqlScan();
  const {
    ranges,
    lines: freshLines,
    text: textLines,
    valid,
  } = scan.current.update(value, linesNeeded(caretBlock, caught.current.blocks, shown.current !== null));
  const picked = pickShownLines(freshLines, valid, textLines, shown.current, caretBlock, (b) =>
    caught.current.blocks.has(b),
  );
  const lines = picked.html;
  useLayoutEffect(() => {
    shown.current = { html: picked.html, text: textLines };
  });
  useEffect(() => {
    if (!picked.pending.length) return;
    const blocks = caught.current.blocks;
    const t = window.setTimeout(() => {
      for (const b of picked.pending.slice(0, CATCH_UP_BLOCKS)) blocks.add(b);
      setCaughtUp((n) => n + 1);
    }, 0);
    return () => window.clearTimeout(t);
  });

  // The callbacks below read props and the scan through this ref and are made
  // once. Memoized on deps, each kept the render it was made in alive, that
  // render kept the callbacks current then, and so on back: a chain through
  // every render, each holding its onRun and completion, which hold the
  // window's result at the time. Re-running a query kept every old result.
  const live = useRef({ value, ranges, onChange, completion });
  live.current = { value, ranges, onChange, completion };

  // A non-empty selection is what runs; the native selection already shows it.
  const statementRange: CharRange | null = useMemo(() => {
    if (selection.start !== selection.end) return null;
    return statementRangeAtOffset(value, selection.start, ranges);
  }, [value, ranges, selection.start, selection.end]);

  const markLine = mark && mark.end <= value.length ? lineAtOffset(lineStarts, mark.start) : -1;
  const stFirst = statementRange ? lineAtOffset(lineStarts, statementRange.start) : -1;
  const stLast = statementRange
    ? lineAtOffset(lineStarts, Math.max(statementRange.start, statementRange.end - 1))
    : -2;
  const decor: LineDecor = { stFirst, stLast, caretLine, markLine };

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const highlight = highlightRef.current;
    if (ta && highlight) {
      highlight.scrollTop = ta.scrollTop;
      highlight.scrollLeft = ta.scrollLeft;
    }
    if (ta && marksRef.current) {
      marksRef.current.scrollTop = ta.scrollTop;
      marksRef.current.scrollLeft = ta.scrollLeft;
    }
  }, []);

  // At the next frame, not in the key's commit: reading the textarea's
  // scrollTop forces a layout of all its text, which the frame does anyway.
  useEffect(() => {
    const frame = requestAnimationFrame(syncScroll);
    return () => cancelAnimationFrame(frame);
  }, [value, syncScroll]);

  const getSqlToRun = useCallback(() => {
    const { value } = live.current;
    const ta = textareaRef.current;
    if (!ta) return value;
    return sqlToRun(value, ta.selectionStart, ta.selectionEnd);
  }, []);

  const focus = useCallback(() => textareaRef.current?.focus(), []);

  const insertText = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      if (!ta || ta.readOnly) return;
      ta.focus();
      // execCommand keeps ⌘Z working; fall back to a plain splice.
      if (!document.execCommand("insertText", false, text)) {
        const { selectionStart: start, selectionEnd: end } = ta;
        live.current.onChange(ta.value.slice(0, start) + text + ta.value.slice(end));
        requestAnimationFrame(() => {
          ta.setSelectionRange(start + text.length, start + text.length);
        });
      }
    },
    [],
  );

  /** Viewport box of the character at `offset`, measured on the coloured overlay. */
  const rectAt = useCallback((text: string, offset: number): DOMRect | null => {
    const pre = highlightRef.current;
    if (!pre) return null;
    const starts = lineStartOffsets(text);
    const line = lineAtOffset(starts, offset);
    const div = pre.children[line] as HTMLElement | undefined;
    if (!div) return null;
    let col = offset - starts[line];
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent?.length ?? 0;
      if (col <= len) {
        const range = document.createRange();
        range.setStart(node, col);
        range.setEnd(node, Math.min(len, col + 1));
        const rects = range.getClientRects();
        if (rects.length > 0) return rects[0];
        break;
      }
      col -= len;
    }
    // Empty line: its box starts after the gutter.
    const box = div.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(pre).paddingLeft) || 0;
    const preBox = pre.getBoundingClientRect();
    return new DOMRect(preBox.left + padLeft, box.top, 0, box.height);
  }, []);

  const openCompletion = useCallback(
    (text: string, caret: number, explicit: boolean) => {
      const { completion } = live.current;
      const ta = textareaRef.current;
      if (!completion || !ta || ta.readOnly) {
        setAc(null);
        return;
      }
      const result = completion.complete(text, caret, explicit);
      if (!result) {
        setAc(null);
        return;
      }
      // The overlay re-renders with this text first, then we measure.
      requestAnimationFrame(() => {
        if (textareaRef.current?.selectionStart !== caret) return;
        const anchor = rectAt(text, result.from);
        if (!anchor) return;
        editCaret.current = caret;
        setAc((prev) => ({
          result,
          explicit: explicit || !!prev?.explicit,
          // Keep the cursor on the same item while it's still listed.
          cursor: Math.max(
            0,
            prev
              ? result.items.findIndex(
                  (i) => i.insert === prev.result.items[prev.cursor]?.insert,
                )
              : 0,
          ),
          anchor,
        }));
      });
    },
    [rectAt],
  );

  const replaceRange = useCallback((from: number, to: number, text: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(from, to);
    accepting.current = true;
    // execCommand keeps ⌘Z working; fall back to a plain splice.
    if (!document.execCommand("insertText", false, text)) {
      const next = ta.value.slice(0, from) + text + ta.value.slice(to);
      live.current.onChange(next);
      requestAnimationFrame(() => ta.setSelectionRange(from + text.length, from + text.length));
    }
    accepting.current = false;
  }, []);

  const accept = useCallback(
    (index: number) => {
      const open = acRef.current;
      const ta = textareaRef.current;
      if (!open || !ta) return;
      const item = open.result.items[index];
      if (!item) return;
      setAc(null);
      const { from, to } = open.result;
      replaceRange(from, to, item.insert);
      const end = from + item.insert.length;
      if (item.caretBack) {
        const pos = end - item.caretBack;
        ta.setSelectionRange(pos, pos);
      }
      // `schema.` goes straight on to the schema's tables.
      if (item.insert.endsWith(".")) openCompletion(ta.value, end, false);
    },
    [replaceRange, openCompletion],
  );

  const getRunTarget = useCallback(() => {
    const { value, ranges } = live.current;
    const ta = textareaRef.current;
    if (!ta) return { sql: value, start: 0 };
    const { selectionStart: a, selectionEnd: b } = ta;
    if (a !== b) return { sql: value.slice(Math.min(a, b), Math.max(a, b)), start: Math.min(a, b) };
    const range = statementRangeAtOffset(value, a, ranges);
    return range ? { sql: value.slice(range.start, range.end), start: range.start } : { sql: "", start: 0 };
  }, []);

  const jumpTo = useCallback((offset: number) => {
    const { value } = live.current;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(offset, offset);
    // Bring the caret's line into view.
    const line = value.slice(0, offset).split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const top = line * lh;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, top - lh * 2);
    syncCaretFromTextarea();
  }, [syncCaretFromTextarea]);

  const format = useCallback(
    async (dialect: FormatDialect) => {
      const ta = textareaRef.current;
      if (!ta || ta.readOnly) return null;
      const { value, ranges } = live.current;
      const range = formatTarget(value, ta.selectionStart, ta.selectionEnd, ranges);
      if (!range) return null;
      const selected = ta.selectionStart !== ta.selectionEnd;
      const done = await formatSql(value, range, dialect);
      if (!done.ok) return done.error;
      // The first call waits for the formatter to load: typing or a tab switch
      // (which unmounts this editor) meanwhile wins.
      if (!ta.isConnected || live.current.value !== value || ta.readOnly) return null;
      if (done.sql === value.slice(range.start, range.end)) return null;
      replaceRange(range.start, range.end, done.sql);
      // A selection stays on what it formatted; a caret ends its statement.
      if (selected) ta.setSelectionRange(range.start, range.start + done.sql.length);
      syncCaretFromTextarea();
      return null;
    },
    [replaceRange, syncCaretFromTextarea],
  );

  useImperativeHandle(
    ref,
    () => ({ getSqlToRun, getRunTarget, jumpTo, replaceRange, focus, insertText, format }),
    [getSqlToRun, getRunTarget, jumpTo, replaceRange, focus, insertText, format],
  );

  // The mark layer: the same text, transparent, with the marked token in a
  // dotted underline; it wraps exactly like the text above it.
  const markLines = useMemo(() => {
    if (!mark || mark.end <= mark.start || mark.end > value.length) return null;
    let offset = 0;
    return value.split("\n").map((line) => {
      const from = offset;
      offset += line.length + 1;
      const a = Math.max(mark.start - from, 0);
      const b = Math.min(mark.end - from, line.length);
      if (b <= a || mark.start >= from + line.length + 1) return { before: line, marked: "", after: "" };
      return { before: line.slice(0, a), marked: line.slice(a, b), after: line.slice(b) };
    });
  }, [mark, value]);

  const gutter = Math.max(46, String(lines.length).length * DIGIT_PX + 28);

  return (
    <div
      className={`sql-editor-wrap${compact ? " compact" : ""}`}
      style={{ "--gutter": `${gutter}px` } as React.CSSProperties}
    >
      <pre data-testid="sql-highlight" className="sql-highlight" ref={highlightRef} aria-hidden>
        {Array.from({ length: Math.ceil(lines.length / BLOCK) }, (_, b) => {
          const from = b * BLOCK;
          const to = Math.min(lines.length, from + BLOCK);
          return (
            <SqlLineBlock
              key={b}
              from={from}
              html={lines.slice(from, to)}
              decor={blockDecor(decor, from, to)}
              d={decor}
            />
          );
        })}
      </pre>
      {markLines && (
        <pre data-testid="sql-highlight" className="sql-highlight sql-marks" ref={marksRef} aria-hidden data-mark={`${mark!.start}-${mark!.end}`}>
          {markLines.map((l, i) => (
            <div key={i} className="ln">
              {l.before}
              {l.marked && <u className="sql-mark">{l.marked}</u>}
              {l.after}
            </div>
          ))}
        </pre>
      )}
      <textarea
        ref={textareaRef}
        data-testid="sql-editor"
        className="sql-editor"
        aria-label="SQL"
        // While completions show, VoiceOver reads the highlighted one.
        aria-autocomplete="list"
        aria-controls={ac ? acId : undefined}
        aria-activedescendant={ac ? `${acId}-${ac.cursor}` : undefined}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        wrap={compact ? "off" : undefined}
        onChange={(e) => {
          const text = e.target.value;
          const caret = e.target.selectionStart;
          editCaret.current = caret;
          onChange(text);
          syncCaretFromTextarea();
          if (accepting.current) return;
          const input = e.nativeEvent as InputEvent;
          const typed = input.inputType === "insertText" && TRIGGER.test(input.data ?? "");
          const erased = input.inputType?.startsWith("delete") && acRef.current;
          if ((typed || erased) && e.target.selectionEnd === caret) {
            openCompletion(text, caret, !!acRef.current?.explicit);
          } else if (acRef.current) {
            setAc(null);
          }
        }}
        onScroll={() => {
          syncScroll();
          if (acRef.current) setAc(null);
        }}
        onSelect={syncCaretFromTextarea}
        onFocus={syncCaretFromTextarea}
        onBlur={() => setAc(null)}
        spellCheck={false}
        onKeyDown={(e) => {
          const ta = e.currentTarget;
          // ⇧⌘↵ is safe mode's confirm and ⌥⌘↵ Run All, both handled by the window.
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "Enter") {
            e.preventDefault();
            setAc(null);
            onRun(compact ? ta.value : getSqlToRun());
            return;
          }
          // ↵ inside the underlined token: take the suggestion (the window decides).
          if (
            e.key === "Enter" &&
            !ac &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.shiftKey &&
            mark &&
            ta.selectionStart === ta.selectionEnd &&
            ta.selectionStart >= mark.start &&
            ta.selectionStart <= mark.end &&
            onMarkEnter?.()
          ) {
            e.preventDefault();
            return;
          }
          if (ac && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const count = ac.result.items.length;
            const move = (to: number) => {
              e.preventDefault();
              setAc({ ...ac, cursor: (to + count) % count, moved: true });
            };
            switch (e.key) {
              case "ArrowDown":
                return move(ac.cursor + 1);
              case "ArrowUp":
                return move(ac.cursor - 1);
              case "PageDown":
                return move(Math.min(count - 1, ac.cursor + 8));
              case "PageUp":
                return move(Math.max(0, ac.cursor - 8));
              case "Enter":
              case "Tab":
                if (e.shiftKey) break;
                // A one-line field (a filter value) applies what was typed on ↵
                // unless the list was asked for or walked; Tab still takes it.
                if (compact && e.key === "Enter" && !ac.explicit && !ac.moved) {
                  setAc(null);
                  break;
                }
                e.preventDefault();
                accept(ac.cursor);
                return;
              case "Escape":
                // Handled here, so Esc doesn't also cancel a running query.
                e.preventDefault();
                setAc(null);
                return;
            }
          }
          if (compact) {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!e.shiftKey && !e.altKey) onRun(ta.value);
              return;
            }
            if (e.key === "Escape" && onEscape?.()) {
              e.preventDefault();
              return;
            }
          }
          // Quotes pair up; the closing quote is stepped over; Backspace in '' removes both.
          if (!e.metaKey && !e.ctrlKey && !e.altKey && !ta.readOnly && !e.nativeEvent.isComposing) {
            const edit =
              e.key === "Backspace"
                ? quoteBackspace(ta.value, ta.selectionStart, ta.selectionEnd)
                : quoteTyped(ta.value, ta.selectionStart, ta.selectionEnd, e.key);
            if (edit) {
              e.preventDefault();
              setAc(null);
              if (edit.kind === "skip") {
                ta.setSelectionRange(edit.caret, edit.caret);
                syncCaretFromTextarea();
              } else if (edit.kind === "delete") {
                replaceRange(edit.from, edit.to, "");
              } else if (edit.kind === "wrap") {
                replaceRange(edit.from, edit.to, edit.text);
                // Keep the wrapped text selected, like other editors.
                ta.setSelectionRange(edit.from + 1, edit.from + edit.text.length - 1);
              } else {
                replaceRange(ta.selectionStart, ta.selectionEnd, edit.text);
                ta.setSelectionRange(edit.caret, edit.caret);
                // `= '` still offers the column's values, now between the pair.
                openCompletion(ta.value, edit.caret, false);
              }
              return;
            }
          }
          // ⌃Space opens the list for what's at the caret, even with nothing typed.
          if (e.ctrlKey && !e.metaKey && e.code === "Space") {
            e.preventDefault();
            if (ta.selectionStart === ta.selectionEnd)
              openCompletion(ta.value, ta.selectionStart, true);
            return;
          }
          // Tab right after `*` in a SELECT list spells out the columns.
          if (e.key === "Tab" && !e.shiftKey && !ac && completion && !ta.readOnly) {
            const star =
              ta.selectionStart === ta.selectionEnd
                ? completion.expandStar(ta.value, ta.selectionStart)
                : null;
            if (star) {
              e.preventDefault();
              replaceRange(star.from, star.to, star.insert);
            }
          }
        }}
      />
      {ac && (
        <CompletionPopup
          items={ac.result.items}
          cursor={ac.cursor}
          anchor={ac.anchor}
          id={acId}
          onPick={accept}
          onHover={(i) => setAc((prev) => (prev ? { ...prev, cursor: i } : prev))}
        />
      )}
    </div>
  );
});
