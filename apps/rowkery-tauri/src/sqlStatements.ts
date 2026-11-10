export interface CharRange {
  start: number;
  end: number;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * MySQL and MariaDB read SQL as the mysql client does: `#` starts a comment
 * to the line's end, `--` only when a space, control character or the
 * text's end follows it (`1--1` is 1 minus -1), a backslash escapes the next
 * character inside '…' and "…", and there are no `$tag$` bodies. A routine's
 * `BEGIN` … `END` is a body (`END IF`, `END LOOP`, … close their own block),
 * and so is MariaDB's `BEGIN NOT ATOMIC` … `END`. A `DELIMITER xx` line is
 * the client's own: statements end at `xx` after it, and neither the line
 * nor `xx` is part of one.
 */
export type SqlDialect = "mysql" | undefined;

/** `text[i]` starts a comment running to the line's end. */
export function lineCommentAt(text: string, i: number, dialect: SqlDialect): boolean {
  const c = text[i];
  if (dialect === "mysql") {
    if (c === "#") return true;
    if (c !== "-" || text[i + 1] !== "-") return false;
    const after = text.charCodeAt(i + 2);
    // NaN past the end: a comment too.
    return !(after > 32 && after !== 127);
  }
  return c === "-" && text[i + 1] === "-";
}

/** A backslash escapes the next character inside a run quoted by `q`. */
const escapes = (q: string, dialect: SqlDialect) => dialect === "mysql" && q !== "`";

/**
 * End (exclusive) of the quoted run opening at `text[start]`. A doubled quote
 * (`'it''s'`, `"a""b"`) stays inside it; an unclosed run ends at the text's end.
 * Shared with `sqlHighlight.ts` so colours and statement ranges agree.
 */
export function quotedEnd(text: string, start: number, dialect?: SqlDialect): number {
  const end = quoteCloseIn(text, start + 1, text[start], dialect);
  return end < 0 ? text.length : end;
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
   * before its name, and `"F"` `"P"` `"T"` after it. MySQL: `"b"` `"bn"`
   * partway through `BEGIN NOT ATOMIC`, whose block reads as a trigger's.
   */
  stage: string;
  /** `BEGIN` … `END` depth inside the body; `CASE` counts once in one. */
  depth: number;
  parens: number;
  /** The last word was `BEGIN` in a function or procedure: a body only when `ATOMIC` follows. */
  afterBegin: boolean;
  /** MySQL: the last word was an `END` that closed a block; `END IF` (…) closed no `BEGIN`. */
  afterEnd: boolean;
}

const freshHead = (): Head => ({ stage: "", depth: 0, parens: 0, afterBegin: false, afterEnd: false });

const ROUTINES: Record<string, string> = { FUNCTION: "F0", PROCEDURE: "P0", TRIGGER: "T0" };
/** MySQL's too: an event's `DO BEGIN … END` is a body like a trigger's. */
const MY_ROUTINES: Record<string, string> = { ...ROUTINES, EVENT: "T0" };
/** MySQL blocks that end with `END <word>` and open no `BEGIN` (`FOR` is MariaDB's). */
const MY_END_WORDS = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);

/** Feeds the head one upper-cased word outside quotes and comments. */
function headWord(h: Head, w: string, dialect: SqlDialect): void {
  const mysql = dialect === "mysql";
  const routine = (mysql ? MY_ROUTINES : ROUTINES)[w];
  switch (h.stage) {
    case "x":
      return;
    case "":
      h.stage = w === "CREATE" ? "c" : mysql && w === "BEGIN" ? "b" : "x";
      return;
    case "b":
      h.stage = w === "NOT" ? "bn" : "x";
      return;
    case "bn":
      h.stage = w === "ATOMIC" ? "T" : "x";
      if (h.stage === "T") h.depth = 1;
      return;
    case "co":
      h.stage = w === "REPLACE" ? "cor" : "x";
      return;
    case "c":
    case "cor":
      if (h.stage === "c" && w === "OR") h.stage = "co";
      else if (w === "TEMP" || w === "TEMPORARY") h.stage = "ct";
      // `CREATE DEFINER = user PROCEDURE`, `CREATE AGGREGATE FUNCTION`:
      // words until the routine's.
      else if (mysql && (w === "DEFINER" || w === "AGGREGATE")) h.stage = "cd";
      else h.stage = routine ?? "x";
      return;
    case "ct":
      h.stage = routine ?? "x";
      return;
    case "cd":
      if (routine) h.stage = routine;
      return;
  }
  if (h.stage.length === 2) {
    h.stage = h.stage[0];
    return;
  }
  if (h.parens !== 0) return;
  if (h.afterEnd) {
    h.afterEnd = false;
    // `END IF`: the END closed the IF, not a BEGIN; `END CASE` closed its CASE.
    if (MY_END_WORDS.has(w)) {
      h.depth++;
      return;
    }
    if (w === "CASE") return;
  }
  let opens = false;
  if (h.afterBegin) {
    h.afterBegin = false;
    opens = w === "ATOMIC";
  } else if (w === "BEGIN") {
    // MySQL's routines have no ATOMIC: BEGIN is the body.
    opens = h.stage === "T" || mysql;
    h.afterBegin = !opens;
  } else {
    opens = w === "CASE" && h.depth > 0;
  }
  if (opens) h.depth++;
  else if (w === "END" && h.depth > 0) {
    h.depth--;
    h.afterEnd = mysql;
  }
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
 * What a `DELIMITER` line sets, given the line's text after the word: its
 * first run without whitespace, `""` for `;` itself. Null when there is none
 * or it holds a backslash (the Run SQL file reader refuses those): the word
 * is then ordinary text and the server answers.
 */
function delimiterAfter(rest: string): string | null {
  const d = rest.trim().split(/\s+/)[0];
  if (!d || d.includes("\\")) return null;
  return d === ";" ? "" : d;
}

/** `text[i]` opens a `/*! … *\/` or `/*M! … *\/` comment: SQL to the server. */
const executableAt = (text: string, i: number) => text[i + 2] === "!" || (text[i + 2] === "M" && text[i + 3] === "!");

/**
 * Start of a custom delimiter `d` inside the comment `text[from, end)`, or -1.
 * The mysql client finds its delimiter inside a `/*! … *\/` too.
 */
function delimiterIn(text: string, d: string, from: number, end: number): number {
  const k = text.indexOf(d, from);
  return k >= 0 && k < end ? k : -1;
}

/**
 * Statement ranges in `text`, split on top-level `;`. Semicolons inside
 * quotes ('…', "…", `…`), `--` / `/* *\/` comments, Postgres `$tag$`
 * bodies and a routine's `BEGIN` … `END` body ([`Head`]) do not split. Each
 * range is trimmed of surrounding whitespace and includes its trailing `;`.
 * Empty statements are dropped. Single pass, O(n).
 */
export function sqlStatementRanges(text: string, dialect?: SqlDialect): CharRange[] {
  const ranges: CharRange[] = [];
  const n = text.length;
  const mysql = dialect === "mysql";
  let start = 0;
  let i = 0;
  /** MySQL: what a `DELIMITER` line set in place of `;`; `""` for `;`. */
  let delim = "";
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
  /** The statement ends at `end`; the next starts at `next`. */
  const cut = (end: number, next: number) => {
    push(end);
    start = next;
    Object.assign(head, freshHead());
  };

  while (i < n) {
    const c = text[i];
    if (delim && text.startsWith(delim, i)) {
      // Before anything else, as the client looks: a delimiter may start as a quote or a comment does.
      cut(i, i + delim.length);
      i = start;
    } else if (c === "'" || c === '"' || c === "`") {
      if (mysql) head.stage ||= "x";
      i = quotedEnd(text, i, dialect);
    } else if (lineCommentAt(text, i, dialect)) {
      const nl = text.indexOf("\n", i + 1);
      i = nl < 0 ? n : nl + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      const k = delim && executableAt(text, i) ? delimiterIn(text, delim, i + 1, end) : -1;
      i = k < 0 ? end : k;
    } else if (c === "$" && !mysql) {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (m && !/\w/.test(text[i - 1] ?? "")) {
        const close = text.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";" && !delim) {
      // `END;` closed a block: the next statement's IF (…) opens its own.
      head.afterEnd = false;
      if (head.depth === 0) cut(i + 1, i + 1);
      i++;
    } else if (head.stage !== "x" && startsWord(text.charCodeAt(i))) {
      const end = wordEnd(text, i);
      const w = text.slice(i, end).toUpperCase();
      const nl = mysql && head.stage === "" && w === "DELIMITER" ? text.indexOf("\n", end) : -2;
      const set = nl === -2 ? null : delimiterAfter(text.slice(end, nl < 0 ? n : nl));
      if (set !== null) {
        delim = set;
        cut(i, nl < 0 ? n : nl + 1);
        i = start;
      } else if (delim) {
        // Only the delimiter ends a statement now, and it may sit inside this word.
        head.stage = "x";
        i++;
      } else {
        if (!namePart(text[i - 1])) headWord(head, w, dialect);
        i = end;
      }
    } else {
      // MySQL: a statement that starts with anything but a word is no `DELIMITER` line.
      if (mysql && !isSpace(text.charCodeAt(i))) head.stage ||= "x";
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

/**
 * Index after the quote closing a run that continues at `line[from]`; -1 when
 * this line doesn't close it. On MySQL a backslash escapes the next character
 * (a backslash ending a line escapes its newline: the run goes on).
 */
export function quoteCloseIn(line: string, from: number, q: string, dialect?: SqlDialect): number {
  const esc = escapes(q, dialect);
  let i = from;
  for (;;) {
    const close = line.indexOf(q, i);
    if (close < 0) return -1;
    if (esc) {
      const slash = line.indexOf("\\", i);
      if (slash >= 0 && slash < close) {
        i = slash + 2;
        continue;
      }
    }
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
  return `${h.stage}:${h.depth}.${h.parens}${h.afterBegin ? "a" : ""}${h.afterEnd ? "e" : ""}`;
}

function parseHead(key: string): Head {
  const m = /^([FPT]0?):(\d+)\.(-?\d+)(a?)(e?)$/.exec(key);
  if (!m) return { ...freshHead(), stage: key };
  return { stage: m[1], depth: Number(m[2]), parens: Number(m[3]), afterBegin: m[4] === "a", afterEnd: m[5] === "e" };
}

/**
 * One line of `sqlStatementRanges`' scan: pushes the offset where the next
 * statement starts after each top-level `;` (the line starts at `base`), and
 * to `gaps` how many characters before that offset belong to no statement (a
 * custom delimiter, a `DELIMITER` line). Returns the next line's state: the
 * lexer's (`LineState`, and `!` inside a `/*! … *\/` that a custom delimiter
 * may end), then a space and the statement's `headKey` unless that is empty,
 * then a tab and the custom delimiter when one is set.
 */
function statementLine(
  line: string,
  base: number,
  entry: string,
  semis: number[],
  gaps: number[],
  dialect: SqlDialect,
): string {
  const mysql = dialect === "mysql";
  const tab = entry.indexOf("\t");
  let delim = tab < 0 ? "" : entry.slice(tab + 1);
  const state = tab < 0 ? entry : entry.slice(0, tab);
  const space = state.indexOf(" ");
  const lex = space < 0 ? state : state.slice(0, space);
  const head = space < 0 ? freshHead() : parseHead(state.slice(space + 1));
  const out = (next: LineState) => {
    const key = headKey(head);
    return `${next}${key ? ` ${key}` : ""}${delim ? `\t${delim}` : ""}`;
  };
  const cut = (next: number, gap: number) => {
    semis.push(base + next);
    gaps.push(gap);
    Object.assign(head, freshHead());
  };
  /** Past the block comment whose text continues at `from`: its end, a delimiter inside it, or -1 when the line ends first. */
  const commentEnd = (from: number, executable: boolean): number => {
    const close = line.indexOf("*/", from);
    const end = close < 0 ? line.length : close + 2;
    const k = executable ? delimiterIn(line, delim, from, end) : -1;
    return k >= 0 ? k : close < 0 ? -1 : end;
  };
  const n = line.length;
  let i = 0;
  if (lex !== "") {
    let j: number;
    if (lex === "*" || lex === "!") {
      j = commentEnd(0, lex === "!");
    } else if (lex[0] === "$") {
      const close = line.indexOf(lex);
      j = close < 0 ? -1 : close + lex.length;
    } else {
      j = quoteCloseIn(line, 0, lex, dialect);
    }
    if (j < 0) return entry;
    i = j;
  }
  while (i < n) {
    const c = line[i];
    if (delim && line.startsWith(delim, i)) {
      cut(i + delim.length, delim.length);
      i += delim.length;
    } else if (c === "'" || c === '"' || c === "`") {
      if (mysql) head.stage ||= "x";
      const end = quoteCloseIn(line, i + 1, c, dialect);
      if (end < 0) return out(c);
      i = end;
    } else if (lineCommentAt(line, i, dialect)) {
      return out("");
    } else if (c === "/" && line[i + 1] === "*") {
      const executable = delim !== "" && executableAt(line, i);
      // A delimiter may start at the comment's second character.
      const k = executable && line.startsWith(delim, i + 1) ? i + 1 : commentEnd(i + 2, executable);
      if (k < 0) return out(executable ? "!" : "*");
      i = k;
    } else if (c === "$" && !mysql) {
      const m = /^\$[A-Za-z_]*\$/.exec(line.slice(i, i + 64));
      if (m && !/\w/.test(line[i - 1] ?? "")) {
        const close = line.indexOf(m[0], i + m[0].length);
        if (close < 0) return out(m[0]);
        i = close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";" && !delim) {
      // `END;` closed a block: the next statement's IF (…) opens its own.
      head.afterEnd = false;
      if (head.depth === 0) cut(i + 1, 0);
      i++;
    } else if (head.stage !== "x" && startsWord(line.charCodeAt(i))) {
      const end = wordEnd(line, i);
      const w = line.slice(i, end).toUpperCase();
      const set = mysql && head.stage === "" && w === "DELIMITER" ? delimiterAfter(line.slice(end)) : null;
      if (set !== null) {
        delim = set;
        cut(n + 1, n + 1 - i);
        return out("");
      }
      if (delim) {
        // Only the delimiter ends a statement now, and it may sit inside this word.
        head.stage = "x";
        i++;
      } else {
        if (!namePart(line[i - 1])) headWord(head, w, dialect);
        i = end;
      }
    } else {
      // MySQL: a statement that starts with anything but a word is no `DELIMITER` line.
      if (mysql && !isSpace(line.charCodeAt(i))) head.stage ||= "x";
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
export function createStatementScanner(dialect?: SqlDialect): StatementScanner {
  let text: string | null = null;
  let src: string[] = [];
  /** `states[k]`: where line k starts (see `statementLine`); one more entry than lines. */
  let states: string[] = [""];
  /** `counts[k]`: top-level `;` before line k; one more entry than lines. */
  let counts: number[] = [0];
  /** Where the next statement starts after each top-level `;` (or custom delimiter, or `DELIMITER` line). */
  let semis: number[] = [];
  /** `gaps[i]`: characters before `semis[i]` that are no statement's (0 after a `;`, which is its statement's). */
  let gaps: number[] = [];
  /** The statement ending `gaps[i]` before `semis[i]` (from the previous `semis`), trimmed; null when dropped. */
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
      const outGaps = gaps.slice(0, keep);
      let outStates = states.slice(0, p + 1);
      const outCounts = counts.slice(0, p + 1);
      let state = outStates[p];
      let k = p;
      for (; k < lines.length; k++) {
        // An unchanged line starting in its old state: the rest is as before.
        if (k >= lines.length - q && state === states[k - delta]) break;
        state = statementLine(lines[k], base, state, outSemis, outGaps, dialect);
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
        for (let i = old; i < semis.length; i++) {
          outSemis.push(semis[i] + charDelta);
          outGaps.push(gaps[i]);
        }
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
          outPairs.push(trimmedRange(next, i ? outSemis[i - 1] : 0, outSemis[i] - outGaps[i]));
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
      gaps = outGaps;
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
  ranges?: CharRange[],
): string {
  if (selectionStart !== selectionEnd) {
    return text.slice(
      Math.min(selectionStart, selectionEnd),
      Math.max(selectionStart, selectionEnd),
    );
  }
  const range = statementRangeAtOffset(text, selectionStart, ranges);
  return range ? text.slice(range.start, range.end) : "";
}
