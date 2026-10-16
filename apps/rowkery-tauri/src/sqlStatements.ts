export interface CharRange {
  start: number;
  end: number;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * End (exclusive) of the quoted run opening at `text[start]`. A doubled quote
 * (`'it''s'`, `"a""b"`) stays inside it; an unclosed run ends at the text's end.
 * Shared with `sqlHighlight.ts` so colours and statement ranges agree.
 */
export function quotedEnd(text: string, start: number): number {
  const q = text[start];
  let i = start + 1;
  for (;;) {
    const close = text.indexOf(q, i);
    if (close < 0) return text.length;
    if (text[close + 1] !== q) return close + 1;
    i = close + 2;
  }
}

/**
 * Statement ranges in `text`, split on top-level `;`. Semicolons inside
 * quotes ('…', "…", `…`), `--` / `/* *\/` comments and Postgres `$tag$`
 * bodies do not split. Each range is trimmed of surrounding whitespace and
 * includes its trailing `;`. Empty statements are dropped. Single pass, O(n).
 */
export function sqlStatementRanges(text: string): CharRange[] {
  const ranges: CharRange[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && isSpace(text.charCodeAt(s))) s++;
    while (e > s && isSpace(text.charCodeAt(e - 1))) e--;
    // Skip bare `;` with nothing before it.
    if (e > s && !(e - s === 1 && text.charCodeAt(s) === 59)) {
      ranges.push({ start: s, end: e });
    }
  };

  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i = quotedEnd(text, i);
    } else if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? n : nl + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (m && !/\w/.test(text[i - 1] ?? "")) {
        const close = text.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";") {
      push(i + 1);
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(n);
  return ranges;
}

// ---------------------------------------------------------------------------
// Incremental scanning, for the editor. Both lexers here and in
// `sqlHighlight.ts` keep, per line, the state the line starts in; an edit
// re-scans from the first changed line and stops at the first unchanged line
// that starts in its old state, reusing everything after it. The whole-text
// functions stay for one-off callers; test/sqlIncremental.test.ts checks the
// two agree after random edits.

/**
 * Lexer state where a line starts: `""` between tokens (the highlighter adds
 * `"."`: right after a `.`), `'` `"` `` ` `` inside that quoted run, `*`
 * inside a block comment, `$tag$` inside that dollar body. Closing quotes,
 * `*\/` and dollar tags never contain a newline, so a line can always finish
 * an open run by looking at itself alone.
 */
export type LineState = string;

/** Index after the quote closing a run that continues at `line[from]`; -1 when this line doesn't close it. */
export function quoteCloseIn(line: string, from: number, q: string): number {
  let i = from;
  for (;;) {
    const close = line.indexOf(q, i);
    if (close < 0) return -1;
    if (line[close + 1] !== q) return close + 1;
    i = close + 2;
  }
}

/** Lines an edit left alone: `p` equal from the top, `q` from the bottom (`p + q` ≤ the shorter count). */
export interface LineDiff {
  p: number;
  q: number;
}

export function lineDiff(prev: readonly string[], next: readonly string[]): LineDiff {
  const m = Math.min(prev.length, next.length);
  let p = 0;
  while (p < m && prev[p] === next[p]) p++;
  let q = 0;
  while (q < m - p && prev[prev.length - 1 - q] === next[next.length - 1 - q]) q++;
  return { p, q };
}

/**
 * One line of `sqlStatementRanges`' scan: pushes the offset after each
 * top-level `;` (the line starts at `base`) and returns the next line's state.
 */
function statementLine(line: string, base: number, entry: LineState, semis: number[]): LineState {
  const n = line.length;
  let i = 0;
  if (entry !== "") {
    let j: number;
    if (entry === "*") {
      const close = line.indexOf("*/");
      j = close < 0 ? -1 : close + 2;
    } else if (entry[0] === "$") {
      const close = line.indexOf(entry);
      j = close < 0 ? -1 : close + entry.length;
    } else {
      j = quoteCloseIn(line, 0, entry);
    }
    if (j < 0) return entry;
    i = j;
  }
  while (i < n) {
    const c = line[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = quoteCloseIn(line, i + 1, c);
      if (end < 0) return c;
      i = end;
    } else if (c === "-" && line[i + 1] === "-") {
      return "";
    } else if (c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) return "*";
      i = close + 2;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(line.slice(i, i + 64));
      if (m && !/\w/.test(line[i - 1] ?? "")) {
        const close = line.indexOf(m[0], i + m[0].length);
        if (close < 0) return m[0];
        i = close + m[0].length;
      } else {
        i++;
      }
    } else {
      if (c === ";") semis.push(base + i + 1);
      i++;
    }
  }
  return "";
}

/** `text[start, end)` trimmed of whitespace, or null when empty or a bare `;` (as `sqlStatementRanges` drops). */
function trimmedRange(text: string, start: number, end: number): CharRange | null {
  let s = start;
  let e = end;
  while (s < e && isSpace(text.charCodeAt(s))) s++;
  while (e > s && isSpace(text.charCodeAt(e - 1))) e--;
  return e > s && !(e - s === 1 && text.charCodeAt(s) === 59) ? { start: s, end: e } : null;
}

export interface StatementScanner {
  /**
   * `sqlStatementRanges(text)`, re-scanning only what changed since the last
   * call. Pass `lines` (`text.split("\n")`) when the caller already has them,
   * and `diff` when it already ran `lineDiff` from the previous call's lines.
   */
  update(text: string, lines?: string[], diff?: LineDiff): CharRange[];
}

/** A per-editor statement splitter: caches each line's start state and the `;` offsets. */
export function createStatementScanner(): StatementScanner {
  let text: string | null = null;
  let src: string[] = [];
  /** `states[k]`: where line k starts; one more entry than lines. */
  let states: LineState[] = [""];
  /** `counts[k]`: top-level `;` before line k; one more entry than lines. */
  let counts: number[] = [0];
  /** Offset after each top-level `;`. */
  let semis: number[] = [];
  /** The statement ending at `semis[i]` (from the previous `;`), trimmed; null when dropped. */
  let pairs: (CharRange | null)[] = [];
  let ranges: CharRange[] = [];

  return {
    update(next: string, lines = next.split("\n"), diff?: LineDiff): CharRange[] {
      if (next === text) return ranges;
      const { p, q } = diff ?? lineDiff(src, lines);
      const delta = lines.length - src.length;
      const charDelta = next.length - (text?.length ?? 0);
      let base = 0;
      for (let k = 0; k < p; k++) base += lines[k].length + 1;
      const keep = counts[p];
      const outSemis = semis.slice(0, keep);
      let outStates = states.slice(0, p + 1);
      const outCounts = counts.slice(0, p + 1);
      let state = outStates[p];
      let k = p;
      for (; k < lines.length; k++) {
        // An unchanged line starting in its old state: the rest is as before.
        if (k >= lines.length - q && state === states[k - delta]) break;
        state = statementLine(lines[k], base, state, outSemis);
        base += lines[k].length + 1;
        outStates.push(state);
        outCounts.push(outSemis.length);
      }
      /** First reused `;` (new index), and how far old indices moved. */
      let firstOld = Infinity;
      let shift = 0;
      if (k < lines.length) {
        const old = counts[k - delta];
        firstOld = outSemis.length;
        shift = firstOld - old;
        for (let i = old; i < semis.length; i++) outSemis.push(semis[i] + charDelta);
        for (let j = k - delta + 1; j < counts.length; j++) outCounts.push(counts[j] + shift);
        outStates = outStates.concat(states.slice(k - delta + 1));
      }
      const outPairs = pairs.slice(0, keep);
      for (let i = keep; i < outSemis.length; i++) {
        if (i > firstOld) {
          // Both ends past the edit: the old statement, moved.
          const r = pairs[i - shift];
          outPairs.push(r && charDelta ? { start: r.start + charDelta, end: r.end + charDelta } : r);
        } else {
          outPairs.push(trimmedRange(next, i ? outSemis[i - 1] : 0, outSemis[i]));
        }
      }
      const out: CharRange[] = [];
      for (const r of outPairs) if (r) out.push(r);
      const last = trimmedRange(next, outSemis.length ? outSemis[outSemis.length - 1] : 0, next.length);
      if (last) out.push(last);

      text = next;
      src = lines;
      states = outStates;
      counts = outCounts;
      semis = outSemis;
      pairs = outPairs;
      ranges = out;
      return ranges;
    },
  };
}

/**
 * Statement Cmd+Enter would run with the caret at `offset`, or null when the
 * editor has no SQL. A caret inside a statement (or touching its end) picks
 * it; a caret in whitespace after a statement on the same line picks that
 * statement; otherwise the next statement, falling back to the previous one.
 * Pass `ranges` (from `sqlStatementRanges`) to skip re-scanning on caret moves.
 */
export function statementRangeAtOffset(
  text: string,
  offset: number,
  ranges: CharRange[] = sqlStatementRanges(text),
): CharRange | null {
  if (ranges.length === 0) return null;
  const pos = Math.max(0, Math.min(offset, text.length));

  let prev: CharRange | null = null;
  for (const r of ranges) {
    if (pos >= r.start && pos <= r.end) return r;
    if (r.start > pos) {
      if (prev && !text.slice(prev.end, pos).includes("\n")) return prev;
      return r;
    }
    prev = r;
  }
  return prev;
}

/** SQL to execute: non-empty selection wins; otherwise the statement at the caret. */
export function sqlToRun(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): string {
  if (selectionStart !== selectionEnd) {
    return text.slice(
      Math.min(selectionStart, selectionEnd),
      Math.max(selectionStart, selectionEnd),
    );
  }
  const range = statementRangeAtOffset(text, selectionStart);
  return range ? text.slice(range.start, range.end) : "";
}
