import { nearestName } from "./queryError";
import { needsQuoting } from "./sqlKeywords";

/**
 * A table tab's filter as chips: one per predicate, each reading as the SQL
 * it produces. `chipsToWhere()` joins them with AND into the `filter` string
 * core wraps in `WHERE (…)`, so the SQL line and Edit SQL stay honest.
 * Hand-written SQL is never parsed into chips: free WHERE text is one opaque
 * expression chip, and only a bare `col op value` fragment becomes a chip.
 */

export type FilterOp =
  | "="
  | "<>"
  | "IS DISTINCT FROM"
  | ">"
  | "<"
  | ">="
  | "<="
  | "ILIKE"
  | "IN"
  | "BETWEEN"
  | "IS NULL"
  | "IS NOT NULL";

/** The operator picker's rows: the SQL, then a dim gloss. */
export const FILTER_OPS: { op: FilterOp; gloss: string }[] = [
  { op: "=", gloss: "equals" },
  { op: "<>", gloss: "not equal (drops empty rows)" },
  { op: "IS DISTINCT FROM", gloss: "not equal, or empty" },
  { op: ">", gloss: "greater than" },
  { op: "<", gloss: "less than" },
  { op: ">=", gloss: "at least" },
  { op: "<=", gloss: "at most" },
  { op: "ILIKE", gloss: "contains" },
  { op: "IN", gloss: "one of" },
  { op: "BETWEEN", gloss: "range" },
  { op: "IS NULL", gloss: "empty" },
  { op: "IS NOT NULL", gloss: "not empty" },
];

/** What each operator does, in plain words; the picker leads with these and prints the SQL as the gloss. */
export const OP_WORDS: Record<FilterOp, string> = {
  "=": "is",
  "<>": "is not",
  "IS DISTINCT FROM": "is not, or empty",
  ">": "more than",
  "<": "less than",
  ">=": "at least",
  "<=": "at most",
  ILIKE: "contains",
  IN: "one of",
  BETWEEN: "between",
  "IS NULL": "is empty",
  "IS NOT NULL": "is not empty",
};

/**
 * The four operators a column of `type` most often wants, shown first in the
 * picker; More… lists the rest. Text: contains, is, is not, is empty. Numbers
 * and times: is, more than, less than, between. Booleans: is, is not, is empty.
 */
export function commonOps(type: string): FilterOp[] {
  if (isTextType(type)) return ["ILIKE", "=", "IS DISTINCT FROM", "IS NULL"];
  if (isNumberType(type) || isTimeType(type)) return ["=", ">", "<", "BETWEEN"];
  if (BOOL_TYPE.test(type.trim())) return ["=", "IS DISTINCT FROM", "IS NULL"];
  return ["=", "IS DISTINCT FROM", "ILIKE", "IS NULL"];
}

/** A chip in plain words (`status is settled`, `amount between 50 and 200`): its tooltip and its row in the overflow menu. */
export function chipWords(chip: FilterChip): string {
  if (chip.kind === "expr") return chip.sql.trim();
  if (chip.kind === "any") return `any text column contains ${chip.value}`;
  switch (chip.op) {
    case "IS NULL":
    case "IS NOT NULL":
      return `${chip.column} ${OP_WORDS[chip.op]}`;
    case "BETWEEN":
      return `${chip.column} between ${chip.value} and ${chip.value2 ?? ""}`;
    default:
      return `${chip.column} ${OP_WORDS[chip.op]} ${chip.text ? quoteText(chip.value) : chip.value}`;
  }
}

/**
 * `col op value`: the value as typed (unquoted); BETWEEN's upper bound in
 * `value2`; IN's values comma-separated (an item holding a comma, or starting
 * with a quote, is written quoted: `'a, b', O'Brien`; see `splitList`).
 */
export interface PredicateChip {
  kind: "pred";
  column: string;
  /** The column's catalog type: numbers and booleans go unquoted. */
  type: string;
  op: FilterOp;
  value: string;
  value2?: string;
  /**
   * The value is a cell's text as it is, never NULL or a quoted null
   * (a cell holding the word `null`, or `'null'` with its quotes).
   */
  text?: true;
}

/** "any text column": `(a ILIKE '%x%' OR b ILIKE '%x%')` over the table's text columns. */
export interface AnyTextChip {
  kind: "any";
  columns: string[];
  value: string;
}

/** Free WHERE text, passed through untouched. */
export interface ExprChip {
  kind: "expr";
  sql: string;
}

export type FilterChip = PredicateChip | AnyTextChip | ExprChip;

export interface ChipColumn {
  name: string;
  type_name: string;
}

export type ChipEngine = "postgres" | "sqlite";

/** Number types by name: `int4`, `numeric(10,2)`, `double precision`; never `interval`. */
const NUMBER_TYPE =
  /^(int[248]?|integer|bigint|smallint|tinyint|mediumint|real|double|float[48]?|numeric|decimal|money|oid|serial[248]?|bigserial|smallserial)\b/i;
const BOOL_TYPE = /^bool/i;
const TEXT_TYPE = /^(text|varchar|character|char|citext|bpchar|name|nvarchar|nchar|clob|string)\b/i;
const TIME_TYPE = /^(timestamp|date|time|datetime|interval)/i;
const REAL_TYPE = /^(real|float4)$/i;
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** An identifier as the line shows it: quoted only when it needs to be (core's `quote_ident` rules). */
export function chipIdent(name: string): string {
  return needsQuoting(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

/** Arrays (`text[]`, or `_text` as Postgres names the type) never take ILIKE. */
const ARRAY_TYPE = /(\[\]|^_)/;
export const isTextType = (type: string) => TEXT_TYPE.test(type.trim()) && !ARRAY_TYPE.test(type.trim());
export const isNumberType = (type: string) => NUMBER_TYPE.test(type.trim());

/**
 * `'it''s'`: a string literal with its quotes doubled. On Postgres, text
 * holding a backslash is an `E'…'` string with backslashes doubled too: with
 * `standard_conforming_strings` off a plain `'…'` reads `\'` as a quote that
 * doesn't end it, so a cell's value could break out. `E''` reads the same on
 * every server (core's `sql_literal` does the same). SQLite has no escapes.
 */
export function quoteText(v: string, engine: ChipEngine = "postgres"): string {
  if (engine === "postgres" && v.includes("\\")) return `E'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * `'null'`, quoted: the text "null", which a bare `null` (SQL's NULL) can't
 * say. A chip keeps the quotes so its value stays text (rowkery/reports#44).
 */
const QUOTED_NULL = /^'null'$/i;
const isNull = (v: string) => /^null$/i.test(v.trim());

/** Whether a cell's text needs `text: true` on its chip to be read as itself. */
export const readsAsNull = (value: string) => isNull(value) || QUOTED_NULL.test(value.trim());

/** A value as a literal for a column of `type`: numbers and booleans bare, the rest quoted; `asText`, quoted as it is. */
export function chipLiteral(value: string, type: string, engine: ChipEngine = "postgres", asText = false): string {
  if (asText) return quoteText(value, engine);
  const v = value.trim();
  if (isNull(v)) return "NULL";
  if (QUOTED_NULL.test(v)) return quoteText(v.slice(1, -1), engine);
  // A real's `0.1` is quoted so it reads as a real: bare, it's a double no real equals.
  if (isNumberType(type) && NUMBER_TEXT.test(v)) {
    return engine === "postgres" && REAL_TYPE.test(type.trim()) ? `'${v}'` : v;
  }
  if (BOOL_TYPE.test(type) && /^(true|false)$/i.test(v)) return v.toUpperCase();
  return quoteText(value, engine);
}

/** The operator a column gets by default: text contains, everything else equals. */
export function defaultOp(type: string): FilterOp {
  if (isTextType(type)) return "ILIKE";
  return "=";
}

const like = (engine: ChipEngine) => (engine === "sqlite" ? "LIKE" : "ILIKE");

/**
 * "contains": `'%x%'`, with `\`, `%` and `_` in the value escaped so they
 * match themselves (Postgres reads `\` as LIKE's escape, and `user_name`
 * must not match `user-name`), and then an ESCAPE of `\` (SQLite has no
 * escape without it). On Postgres the escaped pattern and the ESCAPE are
 * `E''` strings (see `quoteText`): `ESCAPE '\'` is an unclosed string with
 * `standard_conforming_strings` off. A plain value reads plainly.
 */
const containsPattern = (v: string, engine: ChipEngine) => {
  const escaped = v.replace(/[\\%_]/g, "\\$&");
  if (escaped === v) return quoteText(`%${v}%`, engine);
  return `${quoteText(`%${escaped}%`, engine)} ESCAPE ${engine === "postgres" ? "E'\\\\'" : "'\\'"}`;
};

/** A contains pattern's value back (`%a\_b%` → `a_b`); null for a pattern with wildcards of its own. */
function containsValue(pattern: string): string | null {
  const m = /^%(.*)%$/s.exec(pattern);
  if (!m) return null;
  let out = "";
  for (let i = 0; i < m[1].length; i++) {
    const ch = m[1][i];
    if (ch === "\\") {
      if (i + 1 >= m[1].length) return null;
      out += m[1][++i];
    } else if (ch === "%" || ch === "_") return null;
    else out += ch;
  }
  return out;
}

/**
 * Splits `a, b` (IN) on commas. A quote only opens a string at the start of
 * an item (`'a, b'`, `'it''s'`); anywhere else it is a letter (`O'Brien`).
 */
export function splitList(v: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= v.length) {
    while (i < v.length && /\s/.test(v[i])) i++;
    let item = "";
    if (v[i] === "'") {
      // A quoted item: '' is a quote inside it.
      i++;
      while (i < v.length) {
        if (v[i] === "'" && v[i + 1] === "'") {
          item += "'";
          i += 2;
        } else if (v[i] === "'") {
          i++;
          break;
        } else item += v[i++];
      }
      // Anything after the closing quote, up to the comma, stays with it.
      let tail = "";
      while (i < v.length && v[i] !== ",") tail += v[i++];
      const quoted = item + tail.trimEnd();
      // A quoted null is the text, kept quoted (see QUOTED_NULL).
      out.push(tail.trim() === "" && isNull(item) ? `'${item}'` : quoted);
    } else {
      while (i < v.length && v[i] !== ",") item += v[i++];
      item = item.trim();
      if (item !== "") out.push(item);
    }
    i++; // the comma
  }
  return out;
}

/** IN's values as a chip keeps them: bare, or quoted when an item holds a comma or starts with a quote. */
export function joinList(items: string[]): string {
  // The chip's own text (read back by splitList), not SQL: plain quotes.
  return items.map((s) => (!QUOTED_NULL.test(s) && /,|^'|^\s|\s$/.test(s) ? `'${s.replace(/'/g, "''")}'` : s)).join(", ");
}

/** `'it''s'` → `it's`; anything else as is, and `'null'` (see QUOTED_NULL). */
function unquote(v: string): string {
  if (QUOTED_NULL.test(v)) return v;
  const m = /^'((?:[^']|'')*)'$/.exec(v);
  return m ? m[1].replace(/''/g, "'") : v;
}

/** One chip as SQL, exactly as it reads in the line. */
export function chipSql(chip: FilterChip, engine: ChipEngine = "postgres"): string {
  if (chip.kind === "expr") return chip.sql.trim();
  if (chip.kind === "any") {
    const parts = chip.columns.map((c) => `${chipIdent(c)} ${like(engine)} ${containsPattern(chip.value, engine)}`);
    // Bracketed by chipFragments when another chip joins it (core's WHERE (…) brackets it alone).
    return parts.join(" OR ");
  }
  const col = chipIdent(chip.column);
  const lit = (v: string) => chipLiteral(v, chip.type, engine, chip.text);
  switch (chip.op) {
    case "IS NULL":
    case "IS NOT NULL":
      return `${col} ${chip.op}`;
    case "ILIKE": {
      // Postgres has no ILIKE for numbers, times or booleans: their text
      // form is searched, as the foreign-key picker does (rowkery/reports#56).
      const target = engine === "postgres" && !isTextType(chip.type) ? `CAST(${col} AS TEXT)` : col;
      return `${target} ${like(engine)} ${containsPattern(chip.value, engine)}`;
    }
    case "IN":
      return `${col} IN (${splitList(chip.value).map(lit).join(", ")})`;
    case "BETWEEN":
      return `${col} BETWEEN ${lit(chip.value)} AND ${lit(chip.value2 ?? "")}`;
    case "IS DISTINCT FROM":
      // Not equal, keeping the rows where it is NULL ("Hide rows where col = v").
      if (!chip.text && isNull(chip.value)) return `${col} IS NOT NULL`;
      return `${col} ${engine === "sqlite" ? "IS NOT" : "IS DISTINCT FROM"} ${lit(chip.value)}`;
    default: {
      // NULL never equals anything: = NULL means IS NULL.
      if (!chip.text && isNull(chip.value)) return `${col} ${chip.op === "<>" ? "IS NOT NULL" : "IS NULL"}`;
      return `${col} ${chip.op} ${lit(chip.value)}`;
    }
  }
}

/** A free expression with a top-level OR is bracketed when other chips join it with AND. */
function needsParens(sql: string): boolean {
  // The text outside strings and brackets.
  let depth = 0;
  let q = false;
  let top = "";
  for (const ch of sql) {
    if (ch === "'") q = !q;
    else if (!q && ch === "(") depth++;
    else if (!q && ch === ")") depth--;
    else if (!q && depth === 0) top += ch;
    else continue;
    if (ch === "'" || ch === "(" || ch === ")") top += " ";
  }
  return /\bor\b/i.test(top);
}

/** Each chip's SQL in its place in the WHERE clause (what the line renders). */
export function chipFragments(chips: FilterChip[], engine: ChipEngine = "postgres"): string[] {
  return chips.map((c) => {
    const sql = chipSql(c, engine);
    return chips.length > 1 && c.kind !== "pred" && needsParens(sql) ? `(${sql})` : sql;
  });
}

/** The chips as the tab's `filter` string: core wraps it in `WHERE (…)`. */
export function chipsToWhere(chips: FilterChip[], engine: ChipEngine = "postgres"): string {
  return chipFragments(chips, engine).filter((s) => s !== "").join(" AND ");
}

/** A tab saved before chips: its filter text is one expression chip. */
export function chipsFromFilter(filter: string | undefined): FilterChip[] {
  return filter?.trim() ? [{ kind: "expr", sql: filter.trim() }] : [];
}

/**
 * `col op rest`. A symbol operator may touch its operands (`amount>5`); a word
 * operator needs space around it (`(` may follow IN), so a value such as
 * `pending`, `Berlin` or `admin@x.com` is never read as `pend IN g`.
 */
const FRAGMENT =
  /^("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*(=|<>|!=|>=|<=|>|<)\s*|\s+(ilike|like|in|between|is\s+distinct\s+from|is\s+not\s+null|is\s+null|is\s+not)(?:\s+|(?=\()|$))(.*)$/is;
/** A value that is plainly a value: a number, a quoted string, one word. */
const SIMPLE_VALUE = /^(-?(\d+\.?\d*|\.\d+)|'(?:[^']|'')*'|[A-Za-z0-9_.:@-]+)$/;

/**
 * What the chip editor's value field holds, once ↵ is pressed: a bare
 * `col op value` fragment on a known column is a chip; other SQL is an
 * expression chip; anything else is a plain value (null) for the chosen
 * column and operator.
 */
export function parseFragment(text: string, columns: ChipColumn[]): FilterChip | null {
  const t = text.trim();
  const m = FRAGMENT.exec(t);
  const name = m ? (m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]) : "";
  const col = m
    ? (columns.find((c) => c.name === name) ?? columns.find((c) => c.name.toLowerCase() === name.toLowerCase()))
    : undefined;
  // A fragment on a column the table doesn't have is free SQL when it has an
  // operator or brackets (below), else a plain value (`rock in roll`).
  if (m && col) {
    const op = (m[2] ?? m[3]).replace(/\s+/g, " ").toUpperCase().replace("!=", "<>").replace(/^IS NOT$/, "IS DISTINCT FROM") as FilterOp | "LIKE";
    let rest = m[4].trim();
    if (op === "ILIKE") rest = rest.replace(/\s+escape\s+(?:'\\'|e'\\\\')$/i, "");
    if (op === "IS NULL" || op === "IS NOT NULL") {
      if (rest === "") return { kind: "pred", column: col.name, type: col.type_name, op, value: "" };
    } else if (op === "IN") {
      const inner = /^\((.*)\)$/.exec(rest)?.[1] ?? rest;
      const items = splitList(inner);
      if (items.length && !/[()]/.test(inner))
        return { kind: "pred", column: col.name, type: col.type_name, op, value: joinList(items) };
    } else if (op === "BETWEEN") {
      const b = /^(.+?)\s+and\s+(.+)$/i.exec(rest);
      if (b && SIMPLE_VALUE.test(b[1].trim()) && SIMPLE_VALUE.test(b[2].trim()))
        return { kind: "pred", column: col.name, type: col.type_name, op, value: unquote(b[1].trim()), value2: unquote(b[2].trim()) };
    } else if (op === "ILIKE") {
      // ILIKE '%x%' (or E'%x%', its backslashes doubled) reads back as
      // "contains x"; a pattern of the user's own stays SQL.
      const quoted = /^(e?)'((?:[^']|'')*)'$/is.exec(rest);
      const body = !quoted
        ? null
        : !quoted[1]
          ? quoted[2]
          : /^(?:[^\\]|\\\\)*$/.test(quoted[2])
            ? quoted[2].replace(/\\\\/g, "\\")
            : null;
      const value = body !== null ? containsValue(body.replace(/''/g, "'")) : null;
      if (value) return { kind: "pred", column: col.name, type: col.type_name, op, value };
    } else if (op !== "LIKE" && SIMPLE_VALUE.test(rest)) {
      return { kind: "pred", column: col.name, type: col.type_name, op, value: unquote(rest) };
    }
    return { kind: "expr", sql: t };
  }
  // SQL that isn't a value: comparisons, brackets, a function call, IS NULL.
  if (/[=<>()]|\bis\s+(not\s+)?null\b/i.test(t)) return { kind: "expr", sql: t };
  return null;
}

/**
 * A `col op value` fragment on a column the table doesn't have, and the
 * column it most likely meant: a near spelling, else the one column that
 * starts with (or holds) what was typed. Null when the column exists, the text
 * isn't such a fragment, or nothing comes close: then it stays free SQL.
 */
export function unknownColumn(text: string, columns: ChipColumn[]): { name: string; suggestion: string } | null {
  const m = FRAGMENT.exec(text.trim());
  if (!m || m[1].startsWith('"')) return null;
  const name = m[1];
  const lower = name.toLowerCase();
  const names = columns.map((c) => c.name);
  // Two letters are too few to guess from (`i > 1` may be a column of a join).
  if (lower.length < 3 || names.some((n) => n.toLowerCase() === lower)) return null;
  const only = (hits: string[]) => (hits.length === 1 ? hits[0] : null);
  const suggestion =
    nearestName(name, names) ??
    only(names.filter((n) => n.toLowerCase().startsWith(lower))) ??
    only(names.filter((n) => n.toLowerCase().includes(lower)));
  return suggestion ? { name, suggestion } : null;
}

/** `text` with its leading column name replaced (`balance > 5` → `balance_cents > 5`). */
export function renameFragmentColumn(text: string, name: string, to: string): string {
  const t = text.trim();
  return t.startsWith(name) ? to + t.slice(name.length) : t;
}

/** The text columns "any text column" reads. */
export function textColumns(columns: ChipColumn[]): string[] {
  return columns.filter((c) => isTextType(c.type_name)).map((c) => c.name);
}

/** Whether a predicate has what it needs to be SQL. */
export function chipComplete(chip: FilterChip): boolean {
  if (chip.kind === "expr") return chip.sql.trim() !== "";
  if (chip.kind === "any") return chip.value !== "" && chip.columns.length > 0;
  if (chip.op === "IS NULL" || chip.op === "IS NOT NULL") return true;
  if (chip.op === "BETWEEN") return chip.value.trim() !== "" && (chip.value2 ?? "").trim() !== "";
  return chip.value.trim() !== "";
}

export const isTimeType = (type: string) => TIME_TYPE.test(type.trim());

/** Restores saved chips, dropping anything malformed. */
export function savedChips(raw: unknown): FilterChip[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((c): c is FilterChip => {
    if (!c || typeof c !== "object") return false;
    const k = (c as { kind?: unknown }).kind;
    if (k === "expr") return typeof (c as ExprChip).sql === "string";
    if (k === "any") return Array.isArray((c as AnyTextChip).columns) && typeof (c as AnyTextChip).value === "string";
    if (k === "pred") {
      const p = c as PredicateChip;
      return typeof p.column === "string" && typeof p.value === "string" && FILTER_OPS.some((o) => o.op === p.op);
    }
    return false;
  });
}
