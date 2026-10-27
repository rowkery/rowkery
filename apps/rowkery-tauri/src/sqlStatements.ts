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
 * What the splitter knows of the statement being read, to keep a routine's
 * body whole: inside `CREATE [OR REPLACE] [TEMP] FUNCTION | PROCEDURE |
 * TRIGGER`, a `;` between `BEGIN` and `END` doesn't end the statement
 * (SQLite triggers, Postgres `BEGIN ATOMIC`). The same rule as the SQL file
 * reader (`crates/rowkery-core/src/sql_file.rs`).
 */
interface Head {
  /**
   * `""` before the first word, `"x"` an ordinary statement (only `;`
   * matters), `"c"` `"co"` `"cor"` `"ct"` partway through `CREATE [OR
   * REPLACE] [TEMP]`, `"F0"` `"P0"` `"T0"` a function, procedure or trigger
   * before its name, and `"F"` `"P"` `"T"` after it.
   */
  stage: string;
  /** `BEGIN` … `END` depth inside the body; `CASE` counts once in one. */
  depth: number;
  parens: number;
  /** The last word was `BEGIN` in a function or procedure: a body only when `ATOMIC` follows. */
  afterBegin: boolean;
}

const freshHead = (): Head => ({ stage: "", depth: 0, parens: 0, afterBegin: false });

const ROUTINES: Record<string, string> = { FUNCTION: "F0", PROCEDURE: "P0", TRIGGER: "T0" };

/** Feeds the head one upper-cased word outside quotes and comments. */
function headWord(h: Head, w: string): void {
  switch (h.stage) {
    case "x":
      return;
    case "":
      h.stage = w === "CREATE" ? "c" : "x";
      return;
    case "co":
      h.stage = w === "REPLACE" ? "cor" : "x";
      return;
    case "c":
    case "cor":
      if (h.stage === "c" && w === "OR") h.stage = "co";
      else if (w === "TEMP" || w === "TEMPORARY") h.stage = "ct";
      else h.stage = ROUTINES[w] ?? "x";
      return;
    case "ct":
      h.stage = ROUTINES[w] ?? "x";
      return;
  }
  if (h.stage.length === 2) {
    h.stage = h.stage[0];
    return;
  }
  if (h.parens !== 0) return;
  let opens = false;
  if (h.afterBegin) {
    h.afterBegin = false;
    opens = w === "ATOMIC";
  } else if (w === "BEGIN") {
    opens = h.stage === "T";
    h.afterBegin = !opens;
  } else {
    opens = w === "CASE" && h.depth > 0;
  }
  if (opens) h.depth++;
  else if (w === "END" && h.depth > 0) h.depth--;
}

/** Counts a top-level paren; only a routine's need counting. */
function headParen(h: Head, c: string): void {
  if (h.stage === "F" || h.stage === "P" || h.stage === "T" || h.stage.endsWith("0")) {
    h.parens += c === "(" ? 1 : -1;
  }
}

/**
 * A word character: ASCII letters, digits, `_` and anything past ASCII. A
 * `$` ends the word, so dollar tags read as they do without words.
 */
const isWordChar = (c: number) =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c > 127;

/** End of the word starting at `text[i]` (a letter, `_` or non-ASCII). */
function wordEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && isWordChar(text.charCodeAt(j))) j++;
  return j;
}

/**
 * A word after `.` or `[` is a name (`x.end`, `main.begin`, SQLite's
 * `[end]`), never a keyword that opens or closes a body.
 */
const namePart = (prev: string | undefined) => prev === "." || prev === "[";

const startsWord = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c > 127;

/**
 * Statement ranges in `text`, split on top-level `;`. Semicolons inside
 * quotes ('…', "…", `…`), `--` / `/* *\/` comments, Postgres `$tag$`
 * bodies and a routine's `BEGIN` … `END` body ([`Head`]) do not split. Each
 * range is trimmed of surrounding whitespace and includes its trailing `;`.
 * Empty statements are dropped. Single pass, O(n).
 */
export function sqlStatementRanges(text: string): CharRange[] {
  const ranges: CharRange[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  const head = freshHead();

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
      if (head.depth === 0) {
        push(i + 1);
        start = i + 1;
        Object.assign(head, freshHead());
      }
      i++;
    } else if (head.stage !== "x" && startsWord(text.charCodeAt(i))) {
      const end = wordEnd(text, i);
      if (!namePart(text[i - 1])) headWord(head, text.slice(i, end).toUpperCase());
      i = end;
    } else {
      if (c === "(" || c === ")") headParen(head, c);
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

/** `h` as a string, for a line's state. */
function headKey(h: Head): string {
  if (!/^[FPT]/.test(h.stage)) return h.stage;
  return `${h.stage}:${h.depth}.${h.parens}${h.afterBegin ? "a" : ""}`;
}

function parseHead(key: string): Head {
  const m = /^([FPT]0?):(\d+)\.(-?\d+)(a?)$/.exec(key);
  if (!m) return { ...freshHead(), stage: key };
  return { stage: m[1], depth: Number(m[2]), parens: Number(m[3]), afterBegin: m[4] === "a" };
}

/**
 * One line of `sqlStatementRanges`' scan: pushes the offset after each
 * top-level `;` (the line starts at `base`) and returns the next line's
 * state. A state is the lexer's (`LineState`), then a space and the
 * statement's `headKey` unless that is empty.
 */
function statementLine(line: string, base: number, entry: string, semis: number[]): string {
  const space = entry.indexOf(" ");
  const lex = space < 0 ? entry : entry.slice(0, space);
  const head = space < 0 ? freshHead() : parseHead(entry.slice(space + 1));
  const out = (next: LineState) => {
    const key = headKey(head);
    return key ? `${next} ${key}` : next;
  };
  const n = line.length;
  let i = 0;
  if (lex !== "") {
    let j: number;
    if (lex === "*") {
      const close = line.indexOf("*/");
      j = close < 0 ? -1 : close + 2;
    } else if (lex[0] === "$") {
      const close = line.indexOf(lex);
      j = close < 0 ? -1 : close + lex.length;
    } else {
      j = quoteCloseIn(line, 0, lex);
    }
    if (j < 0) return entry;
    i = j;
  }
  while (i < n) {
    const c = line[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = quoteCloseIn(line, i + 1, c);
      if (end < 0) return out(c);
      i = end;
    } else if (c === "-" && line[i + 1] === "-") {
      return out("");
    } else if (c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) return out("*");
      i = close + 2;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(line.slice(i, i + 64));
      if (m && !/\w/.test(line[i - 1] ?? "")) {
        const close = line.indexOf(m[0], i + m[0].length);
        if (close < 0) return out(m[0]);
        i = close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";") {
      if (head.depth === 0) {
        semis.push(base + i + 1);
        Object.assign(head, freshHead());
      }
      i++;
    } else if (head.stage !== "x" && startsWord(line.charCodeAt(i))) {
      const end = wordEnd(line, i);
      if (!namePart(line[i - 1])) headWord(head, line.slice(i, end).toUpperCase());
      i = end;
    } else {
      if (c === "(" || c === ")") headParen(head, c);
      i++;
    }
  }
  return out("");
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
  /** `states[k]`: where line k starts (see `statementLine`); one more entry than lines. */
  let states: string[] = [""];
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
