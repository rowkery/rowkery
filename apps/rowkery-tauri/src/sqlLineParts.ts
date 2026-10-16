import { highlightSqlLines } from "./sqlHighlight";

/**
 * A table tab's SQL as its one line shows it: the statement core sends,
 * whitespace collapsed (`\nWHERE` → ` WHERE`), split around the WHERE
 * clause's text (where the chips go) and the `LIMIT n` literal, which is the
 * page-size control. Literals stay exactly as sent.
 */
export interface SqlLineParts {
  /** The whole line, as text. */
  text: string;
  /** Highlighted HTML before the LIMIT literal (or of the whole line). */
  beforeHtml: string;
  /** The text before LIMIT by clause, so a gesture can wash the one it changed. */
  segments: SqlLineSegment[];
  /**
   * `beforeHtml` split for the chips: up to `WHERE (` (or, with no WHERE, up
   * to where one would go), the filter text itself, then the rest (after
   * the WHERE's closing bracket).
   */
  headHtml: string;
  /** The head's length in characters. */
  headChars: number;
  where: string | null;
  tailHtml: string;
  /** The head and the rest by clause, so a gesture can wash the one it changed. */
  headSegments: SqlLineSegment[];
  tailSegments: SqlLineSegment[];
  /** `LIMIT 1000`, when the statement ends with one. */
  limit: string | null;
  /** Highlighted HTML after it (the `;`). */
  afterHtml: string;
}

/**
 * `head` is `SELECT `, `select` the column list, `order` the `ORDER BY …`
 * clause, `body` everything else (FROM, WHERE, spaces).
 */
export type SqlLineClause = "head" | "select" | "body" | "order";

export interface SqlLineSegment {
  clause: SqlLineClause;
  text: string;
  html: string;
  /** The select list holds this many columns (`*` counts as 0). */
  columns?: number;
}

/** A select list this long reads as `SELECT 42 columns FROM …` (display only). */
export const COLLAPSE_COLUMNS = 40;

export function sqlLineText(sql: string): string {
  return sql.replace(/\s*\n\s*/g, " ").trim();
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`;
const ORDER_KEY = String.raw`${IDENT}(?:\.${IDENT})?(?: DESC| ASC)?(?: NULLS (?:LAST|FIRST))?`;
/** The ORDER BY core writes, at the end of the text before LIMIT. */
const ORDER_TAIL = new RegExp(String.raw`ORDER BY ${ORDER_KEY}(?:, ${ORDER_KEY})*(\s*)$`);

/** Index of the first ` FROM ` outside double quotes, or -1. */
function fromIndex(text: string, start: number): number {
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && text.startsWith(" FROM ", i)) return i;
  }
  return -1;
}

/** Columns in a select list (commas outside quotes, plus one); `*` is 0. */
export function selectListCount(list: string): number {
  if (list.trim() === "*") return 0;
  let quoted = false;
  let n = 1;
  for (const c of list) {
    if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) n++;
  }
  return n;
}

const seg = (clause: SqlLineClause, text: string): SqlLineSegment => ({
  clause,
  text,
  html: text ? (highlightSqlLines(text)[0] ?? "") : "",
});

/** Splits the text before LIMIT into SELECT, its list, the body and ORDER BY. */
export function sqlLineSegments(before: string): SqlLineSegment[] {
  const out: SqlLineSegment[] = [];
  let rest = before;
  if (rest.startsWith("SELECT ")) {
    const from = fromIndex(rest, 7);
    if (from > 7) {
      out.push(seg("head", "SELECT "));
      const list = rest.slice(7, from);
      out.push({ ...seg("select", list), columns: selectListCount(list) });
      rest = rest.slice(from);
    }
  }
  const m = ORDER_TAIL.exec(rest);
  if (m) {
    const tail = m[1] ?? "";
    out.push(seg("body", rest.slice(0, m.index)));
    out.push(seg("order", rest.slice(m.index, rest.length - tail.length)));
    if (tail) out.push(seg("body", tail));
  } else if (rest) {
    out.push(seg("body", rest));
  }
  return out.filter((s) => s.text !== "");
}

/**
 * The line core ran with `ran` as its WHERE text, rewritten for `next` (the
 * chips just changed and the new page hasn't come back yet), so the line
 * always reads as the SQL the chips produce.
 */
export function lineWithFilter(sql: string, ran: string, next: string): string {
  const text = sqlLineText(sql);
  const r = ran.trim() ? sqlLineText(ran) : "";
  const n = next.trim() ? sqlLineText(next) : "";
  if (r === n) return text;
  let base = text;
  if (r) {
    const clause = ` WHERE (${r})`;
    const at = base.indexOf(clause);
    if (at < 0) return text;
    base = base.slice(0, at) + base.slice(at + clause.length);
  }
  if (!n) return base;
  const from = base.search(/ FROM /);
  const cut = base.slice(from + 1).search(/ ORDER BY | GROUP BY | LIMIT \d|;$/);
  const end = cut >= 0 ? from + 1 + cut : base.length;
  return `${base.slice(0, end)} WHERE (${n})${base.slice(end)}`;
}

const html = (s: string) => (s ? (highlightSqlLines(s)[0] ?? "") : "");

/** `filter` is the tab's WHERE text, as core wrapped it in `WHERE (…)`. */
export function sqlLineParts(sql: string, filter?: string | null): SqlLineParts {
  const text = sqlLineText(sql);
  const m = /(LIMIT \d+(?: OFFSET \d+)?)(;?)$/.exec(text);
  const before = m ? text.slice(0, m.index) : text;
  const f = filter?.trim() ? sqlLineText(filter) : null;
  let head = before;
  let where: string | null = null;
  let tail = "";
  const clause = f ? ` WHERE (${f})` : null;
  const at = clause ? before.indexOf(clause) : -1;
  if (clause && at >= 0) {
    head = before.slice(0, at + " WHERE (".length);
    where = f;
    // The closing bracket is drawn after the chips, so this starts past it.
    tail = before.slice(at + clause.length);
  } else if (!f) {
    // No WHERE: the chips' slot sits where one would go, after the table.
    const from = before.search(/ FROM /);
    const cut = before.slice(from + 1).search(/ ORDER BY | GROUP BY |;$/);
    const end = cut >= 0 ? from + 1 + cut : before.length;
    head = before.slice(0, end);
    tail = before.slice(end);
  }
  return {
    text,
    beforeHtml: html(before),
    segments: sqlLineSegments(before),
    headSegments: sqlLineSegments(head),
    tailSegments: sqlLineSegments(tail),
    headHtml: html(head),
    headChars: head.length,
    where,
    tailHtml: html(tail),
    limit: m ? m[1] : null,
    afterHtml: m ? html(m[2]) : "",
  };
}
