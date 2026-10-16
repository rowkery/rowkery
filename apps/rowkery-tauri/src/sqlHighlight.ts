/**
 * SQL syntax colours for the editor overlay. One linear pass over the text
 * produces an HTML string per line (spans with one-letter classes: k keyword,
 * f function, s string, n number or parameter, c comment, p punctuation), so
 * the editor can re-render only the lines an edit changed. Quoting and
 * comments follow `sqlStatements.ts`, so colours and statement ranges agree.
 */

import {
  createStatementScanner,
  lineDiff,
  quoteCloseIn,
  quotedEnd,
  type CharRange,
  type LineDiff,
  type LineState,
} from "./sqlStatements";

const KEYWORDS = new Set(
  `ADD ALL ALTER ANALYZE AND ANY ARRAY AS ASC AT BEGIN BETWEEN BIGINT BIGSERIAL
  BOOL BOOLEAN BY BYTEA CASCADE CASE CAST CHAR CHARACTER CHECK COLLATE COLUMN
  COMMIT CONFLICT CONSTRAINT COPY CREATE CROSS CURRENT DATABASE DATE DECIMAL
  DEFAULT DELETE DESC DISTINCT DO DOUBLE DROP ELSE END ENUM ESCAPE EXCEPT EXISTS
  EXPLAIN EXTENSION FALSE FETCH FILTER FIRST FLOAT FOLLOWING FOR FOREIGN FROM
  FULL FUNCTION GRANT GROUP HAVING IF ILIKE IN INDEX INNER INSERT INT INTEGER
  INTERSECT INTERVAL INTO IS JOIN JSON JSONB LANGUAGE LAST LATERAL LEFT LIKE
  LIMIT LOCK LOCKED MATERIALIZED NATURAL NEXT NOT NOTHING NOWAIT NULL NULLS
  NUMERIC OFFSET ON ONLY OR ORDER OUTER OVER PARTITION PRECEDING PRECISION
  PRIMARY PROCEDURE RANGE REAL RECURSIVE REFERENCES RELEASE RENAME REPLACE
  RESTRICT RETURNING RETURNS REVOKE RIGHT ROLLBACK ROW ROWS SAVEPOINT SCHEMA
  SELECT SEQUENCE SERIAL SET SHARE SHOW SIMILAR SKIP SMALLINT SOME TABLE TEMP
  TEMPORARY TEXT THEN TIME TIMESTAMP TIMESTAMPTZ TO TRANSACTION TRIGGER TRUE
  TRUNCATE UNBOUNDED UNION UNIQUE UNLOGGED UPDATE USING UUID VACUUM VALUES
  VARCHAR VARYING VERBOSE VIEW WHEN WHERE WINDOW WITH ZONE`.split(/\s+/),
);

const PUNCT = new Set([..."(),.;:=<>!+-*/%^|&~@#?[]{}"]);

const isIdentStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
const isIdentPart = (c: number) =>
  isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

const NEEDS_ESCAPE = /[&<>]/;

function escapeHtml(text: string): string {
  // Most tokens have nothing to escape; skip the replace and its allocation.
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** HTML for each line of `sql`, split on `\n` (so `lines.length` = line count). */
export function highlightSqlLines(sql: string): string[] {
  const lines: string[] = [];
  let line = "";
  const emit = (cls: string | null, text: string) => {
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      const part = nl < 0 ? text.slice(from) : text.slice(from, nl);
      if (part) line += cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
      if (nl < 0) return;
      lines.push(line);
      line = "";
      from = nl + 1;
    }
  };

  const n = sql.length;
  let i = 0;
  /** Last significant character, to tell `t.date` (a column) from `date`. */
  let prevSig = "";
  while (i < n) {
    const c = sql.charCodeAt(i);
    const ch = sql[i];
    let j = i + 1;
    let cls: string | null = null;

    if (isSpace(c)) {
      while (j < n && isSpace(sql.charCodeAt(j))) j++;
      emit(null, sql.slice(i, j));
      i = j;
      continue;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      j = nl < 0 ? n : nl;
      cls = "c";
    } else if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      j = close < 0 ? n : close + 2;
      cls = "c";
    } else if (ch === "'") {
      j = quotedEnd(sql, i);
      cls = "s";
    } else if (ch === '"' || ch === "`") {
      // Quoted identifiers read as names, not strings.
      j = quotedEnd(sql, i);
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag && !/\w/.test(sql[i - 1] ?? "")) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        j = close < 0 ? n : close + tag[0].length;
        cls = "s";
      } else {
        while (j < n && isDigit(sql.charCodeAt(j))) j++;
        cls = j > i + 1 ? "n" : "p";
      }
    } else if (isDigit(c) || (ch === "." && isDigit(sql.charCodeAt(i + 1)))) {
      while (j < n && (isDigit(sql.charCodeAt(j)) || sql[j] === ".")) j++;
      if ((sql[j] === "e" || sql[j] === "E") && /[+-]?\d/.test(sql.slice(j + 1, j + 3))) {
        j++;
        if (sql[j] === "+" || sql[j] === "-") j++;
        while (j < n && isDigit(sql.charCodeAt(j))) j++;
      }
      cls = "n";
    } else if (isIdentStart(c)) {
      while (j < n && isIdentPart(sql.charCodeAt(j))) j++;
      const word = sql.slice(i, j);
      if (prevSig !== "." && sql[j] !== "." && KEYWORDS.has(word.toUpperCase())) {
        cls = "k";
      } else {
        let k = j;
        while (k < n && (sql[k] === " " || sql[k] === "\t")) k++;
        if (sql[k] === "(") cls = "f";
      }
    } else if (PUNCT.has(ch)) {
      cls = "p";
    }

    emit(cls, sql.slice(i, j));
    prevSig = sql[j - 1];
    i = j;
  }
  lines.push(line);
  return lines;
}

/** Offset where each line starts; `lineStarts[0]` is 0. */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

/** Line index holding `offset`, by binary search over `lineStarts`. */
export function lineAtOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Incremental highlighting, for the editor: each keystroke re-colours from the
// first changed line and stops as soon as an unchanged line starts in the
// lexer state it had before the edit (everything after it is then the same).
// `highlightSqlLines` stays the one-off, whole-text pass; the two agree line
// for line (test/sqlIncremental.test.ts checks it after random edits).

const wrap = (cls: string | null, part: string) =>
  !part ? "" : cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);

/**
 * One line's HTML and the state the next line starts in. Mirrors
 * `highlightSqlLines` token for token. A token never spans a newline except
 * the quoted runs, comments and dollar bodies the state carries over; `next`
 * is the next line's first character ("" when it is empty, null after the
 * last line), the one thing past a line's end the whole-text pass reads
 * (`1e` at a line's end is a number only when the next line starts with a digit).
 */
function highlightLine(line: string, entry: LineState, next: string | null): [string, LineState] {
  const n = line.length;
  let out = "";
  let i = 0;
  let prevSig = entry === "." ? "." : "";
  if (entry !== "" && entry !== ".") {
    // Finish the token the previous line left open.
    let j: number;
    let cls: string | null = "s";
    if (entry === "*") {
      const close = line.indexOf("*/");
      j = close < 0 ? -1 : close + 2;
      cls = "c";
    } else if (entry[0] === "$") {
      const close = line.indexOf(entry);
      j = close < 0 ? -1 : close + entry.length;
    } else {
      j = quoteCloseIn(line, 0, entry);
      if (entry !== "'") cls = null;
    }
    if (j < 0) return [wrap(cls, line), entry];
    out += wrap(cls, line.slice(0, j));
    prevSig = line[j - 1];
    i = j;
  }

  while (i < n) {
    const c = line.charCodeAt(i);
    const ch = line[i];
    let j = i + 1;
    let cls: string | null = null;

    if (isSpace(c)) {
      while (j < n && isSpace(line.charCodeAt(j))) j++;
      out += escapeHtml(line.slice(i, j));
      i = j;
      continue;
    } else if (ch === "-" && line[i + 1] === "-") {
      j = n;
      cls = "c";
    } else if (ch === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) return [out + wrap("c", line.slice(i)), "*"];
      j = close + 2;
      cls = "c";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      cls = ch === "'" ? "s" : null;
      const end = quoteCloseIn(line, i + 1, ch);
      if (end < 0) return [out + wrap(cls, line.slice(i)), ch];
      j = end;
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(line.slice(i, i + 64));
      if (tag && !/\w/.test(line[i - 1] ?? "")) {
        const close = line.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return [out + wrap("s", line.slice(i)), tag[0]];
        j = close + tag[0].length;
        cls = "s";
      } else {
        while (j < n && isDigit(line.charCodeAt(j))) j++;
        cls = j > i + 1 ? "n" : "p";
      }
    } else if (isDigit(c) || (ch === "." && isDigit(line.charCodeAt(i + 1)))) {
      while (j < n && (isDigit(line.charCodeAt(j)) || line[j] === ".")) j++;
      if (line[j] === "e" || line[j] === "E") {
        let ahead = line.slice(j + 1, j + 3);
        if (ahead.length < 2 && next !== null) ahead = `${ahead}\n${next}`.slice(0, 2);
        if (/[+-]?\d/.test(ahead)) {
          j++;
          if (line[j] === "+" || line[j] === "-") j++;
          while (j < n && isDigit(line.charCodeAt(j))) j++;
        }
      }
      cls = "n";
    } else if (isIdentStart(c)) {
      while (j < n && isIdentPart(line.charCodeAt(j))) j++;
      const word = line.slice(i, j);
      if (prevSig !== "." && line[j] !== "." && KEYWORDS.has(word.toUpperCase())) {
        cls = "k";
      } else {
        let k = j;
        while (k < n && (line[k] === " " || line[k] === "\t")) k++;
        if (line[k] === "(") cls = "f";
      }
    } else if (PUNCT.has(ch)) {
      cls = "p";
    }

    out += wrap(cls, line.slice(i, j));
    prevSig = line[j - 1];
    i = j;
  }
  return [out, prevSig === "." ? "." : ""];
}

export interface SqlHighlighter {
  /**
   * `highlightSqlLines(text)`, re-colouring only what changed since the last
   * call. Pass `lines` (`text.split("\n")`) when the caller already has them,
   * and `diff` when it already ran `lineDiff` from the previous call's lines.
   *
   * `limit` bounds the work: colouring stops at that line once the edited
   * lines are done, and the lines after it keep their previous HTML (same
   * text, possibly older colours) until a later call with a higher limit, or
   * the same text, carries on. `valid()` says how many lines are up to date.
   */
  update(text: string, lines?: string[], diff?: LineDiff, limit?: number): string[];
  /** Lines from the top whose HTML matches `highlightSqlLines` of the last text. */
  valid(): number;
}

/** A per-editor highlighter: caches each line's HTML and the state it starts in. */
export function createSqlHighlighter(): SqlHighlighter {
  let text: string | null = null;
  let src: string[] = [];
  let html: string[] = [];
  /** `states[k]`: where line k starts; one more entry than lines. */
  let states: LineState[] = [""];
  /** Lines `[0, validTo)` and `states[0..validTo]` are up to date. */
  let validTo = 0;

  return {
    valid: () => validTo,
    update(next: string, lines = next === text ? src : next.split("\n"), diff?: LineDiff, limit = Infinity): string[] {
      if (next === text && validTo >= Math.min(limit, lines.length)) return html;
      // The same text, further: carry on where the last call stopped.
      const { p, q } =
        next === text ? { p: validTo + 1, q: lines.length - validTo } : (diff ?? lineDiff(src, lines));
      const delta = lines.length - src.length;
      // The edited lines are always coloured, whatever the limit.
      const stopAt = Math.max(limit, lines.length - q);
      // A line's colours can hang on the next line's first character, so the
      // line above the first change is re-coloured too; nothing past the old
      // up-to-date lines can be trusted as a starting point.
      const from = Math.min(Math.max(0, p - 1), validTo);
      const outHtml = html.slice(0, from);
      const outStates = states.slice(0, from + 1);
      let state = outStates[from];
      let k = from;
      let resumed = false;
      for (; k < lines.length; k++) {
        // An unchanged, up-to-date line starting in its old state: the rest
        // is as before.
        if (k >= lines.length - q && k - delta < validTo && state === states[k - delta]) {
          resumed = true;
          break;
        }
        if (k >= stopAt) break;
        const after = k + 1 < lines.length ? (lines[k + 1][0] ?? "") : null;
        const [h, exit] = highlightLine(lines[k], state, after);
        outHtml.push(h);
        outStates.push(exit);
        state = exit;
      }
      const oldValid = validTo;
      if (k < lines.length) {
        // Past `k` the lines are the old ones (k ≥ the edit's end), shifted.
        html = outHtml.concat(html.slice(k - delta));
        states = outStates.concat(states.slice(k - delta + 1));
        validTo = resumed ? oldValid + delta : k;
      } else {
        html = outHtml;
        states = outStates;
        validTo = lines.length;
      }
      src = lines;
      text = next;
      return html;
    },
  };
}

export interface SqlScan {
  /**
   * Each line's HTML (`highlightSqlLines`, up to date for the first `valid`
   * lines: see `SqlHighlighter.update`'s `limit`), the statements
   * (`sqlStatementRanges`) and the text's lines (`text.split("\n")`).
   */
  update(text: string, limit?: number): { lines: string[]; ranges: CharRange[]; text: string[]; valid: number };
}

/** The editor's scanners: highlight and statement ranges, sharing one split and line diff per edit. */
export function createSqlScan(): SqlScan {
  const hl = createSqlHighlighter();
  const st = createStatementScanner();
  let text: string | null = null;
  let src: string[] = [""];
  let ranges: CharRange[] = [];
  let out = { lines: [""], ranges, text: src, valid: 1 };
  return {
    update(next, limit = Infinity) {
      let html: string[];
      if (next === text) {
        html = hl.update(next, src, undefined, limit);
      } else {
        const lines = next.split("\n");
        const diff = lineDiff(text === null ? [] : src, lines);
        html = hl.update(next, lines, diff, limit);
        ranges = st.update(next, lines, diff);
        text = next;
        src = lines;
      }
      if (html !== out.lines || ranges !== out.ranges || hl.valid() !== out.valid)
        out = { lines: html, ranges, text: src, valid: hl.valid() };
      return out;
    },
  };
}
