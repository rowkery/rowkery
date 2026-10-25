/**
 * Context-aware completion for the SQL editor. It reads only the statement
 * around the caret, with a tolerant scanner (half-written SQL is the normal
 * case, so no real parser), works out the clause at the caret and which
 * tables and aliases are in scope, then ranks candidates from the
 * `CompletionIndex`. Pure and synchronous: one call per keystroke.
 */

import type { CompletionIndex, FnEntry, RelEntry } from "./completionIndex";
import { sqlIdent } from "./paletteIndex";
import { createStatementScanner } from "./sqlStatements";
import type { ColumnNode } from "./types";
import { formatRowCount } from "./types";

export type CompletionKind =
  | "table"
  | "view"
  | "matview"
  | "cte"
  | "schema"
  | "column"
  | "alias"
  | "join"
  | "function"
  | "keyword"
  | "value";

export interface Completion {
  kind: CompletionKind;
  label: string;
  /** Text that replaces `from`…`to`. */
  insert: string;
  /** Right-aligned hint: column type, row count, schema. */
  detail?: string;
  /** Column is (part of) the primary key / a foreign key. */
  key?: "pk" | "fk";
  /** Indices into `label` the typed text matched. */
  marks: number[];
  score: number;
  /** Put the caret this many characters before the end of `insert`. */
  caretBack?: number;
}

export interface CompletionResult {
  from: number;
  to: number;
  /** What was typed so far (between `from` and the caret). */
  prefix: string;
  items: Completion[];
}

export const MAX_ITEMS = 50;

// ---------------------------------------------------------------------------
// Scanner

type TokType = "w" | "q" | "s" | "n" | "p";

interface Tok {
  t: TokType;
  /** Text; for quoted identifiers without quotes. */
  v: string;
  /** Uppercased word, "" for other tokens. */
  up: string;
  s: number;
  e: number;
  /** Paren group the token sits in; `(` and `)` sit in the outer one. */
  g: number;
  /** Group in effect right after the token. */
  ga: number;
  /** Unterminated string or quoted identifier. */
  open?: boolean;
}

const isIdentStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
const isIdentPart = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;
const isDigit = (c: number) => c >= 48 && c <= 57;

interface Scan {
  toks: Tok[];
  parent: number[];
  /** Caret sits in a comment. */
  inComment: boolean;
}

function scan(text: string, start: number, end: number, caret: number): Scan {
  const toks: Tok[] = [];
  const parent = [-1];
  const stack = [0];
  let inComment = false;
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    const ch = text[i];
    const g = stack[stack.length - 1];
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      const e = nl < 0 || nl > end ? end : nl;
      if (caret > i + 1 && caret <= e) inComment = true;
      i = e;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const e = close < 0 || close + 2 > end ? end : close + 2;
      if (caret > i + 1 && (caret < e || close < 0)) inComment = true;
      i = e;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      let open = true;
      while (j < end) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          open = false;
          j++;
          break;
        }
        j++;
      }
      const inner = text.slice(i + 1, open ? j : j - 1).split(ch + ch).join(ch);
      toks.push({ t: ch === "'" ? "s" : "q", v: inner, up: "", s: i, e: j, g, ga: g, open });
      i = j;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (tag && !/\w/.test(text[i - 1] ?? "")) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const e = close < 0 || close > end ? end : close + tag[0].length;
        toks.push({ t: "s", v: "", up: "", s: i, e, g, ga: g, open: close < 0 });
        i = e;
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < end && isIdentPart(text.charCodeAt(j))) j++;
      const v = text.slice(i, j);
      toks.push({ t: "w", v, up: v.toUpperCase(), s: i, e: j, g, ga: g });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < end && (isDigit(text.charCodeAt(j)) || text[j] === ".")) j++;
      toks.push({ t: "n", v: text.slice(i, j), up: "", s: i, e: j, g, ga: g });
      i = j;
      continue;
    }
    if (ch === "(") {
      const child = parent.length;
      parent.push(g);
      stack.push(child);
      toks.push({ t: "p", v: ch, up: "", s: i, e: i + 1, g, ga: child });
    } else if (ch === ")") {
      if (stack.length > 1) stack.pop();
      const outer = stack[stack.length - 1];
      toks.push({ t: "p", v: ch, up: "", s: i, e: i + 1, g: outer, ga: outer });
    } else {
      // Two-character operators stay one token so `=` checks stay simple.
      const two = text.slice(i, i + 2);
      const op = ["<>", "!=", ">=", "<=", "::", "||", "->"].includes(two) ? two : ch;
      toks.push({ t: "p", v: op, up: "", s: i, e: i + op.length, g, ga: g });
      i += op.length;
      continue;
    }
    i++;
  }
  return { toks, parent, inComment };
}

const isName = (t: Tok | undefined): t is Tok =>
  !!t && (t.t === "q" || (t.t === "w" && !RESERVED.has(t.up)));

/** Words that end a table reference instead of naming its alias. */
const RESERVED = new Set(
  `ALL AND ANY AS ASC BETWEEN BY CASE CROSS DEFAULT DELETE DESC DISTINCT DO
  ELSE END EXCEPT EXISTS FETCH FOR FROM FULL GROUP HAVING ILIKE IN INNER
  INSERT INTERSECT INTO IS JOIN LATERAL LEFT LIKE LIMIT NATURAL NOT NULL
  OFFSET ON ONLY OR ORDER OUTER RETURNING RIGHT SELECT SET TABLE THEN UNION
  UPDATE USING VALUES WHEN WHERE WINDOW WITH`.split(/\s+/),
);

// ---------------------------------------------------------------------------
// Scope: tables, aliases and CTEs the statement mentions

interface Ref {
  /** Group the reference belongs to. */
  g: number;
  schema: string | null;
  name: string;
  alias: string | null;
  /** Resolved catalog entry; null for CTEs, subqueries and unknown names. */
  rel: RelEntry | null;
  /** Columns of a CTE or subquery, filled once every reference is known. */
  columns: ColumnNode[] | null;
  /** A CTE's reference, or the group a subquery's SELECT sits in. */
  cte?: Cte;
  sub?: number;
  /** Token index of the name, to find the reference a JOIN … ON belongs to. */
  at: number;
}

interface Cte {
  name: string;
  columns: ColumnNode[];
  /** Explicit `name (a, b) AS` list, else the group of its SELECT. */
  explicit: string[] | null;
  g: number;
}

function resolveRelation(
  index: CompletionIndex,
  schema: string | null,
  name: string,
): RelEntry | null {
  const list = index.byName.get(name.toLowerCase());
  if (!list) return null;
  if (schema) {
    const s = schema.toLowerCase();
    return list.find((r) => r.schema.toLowerCase() === s) ?? null;
  }
  let best: RelEntry | null = null;
  for (const r of list) if (!best || r.pathRank < best.pathRank) best = r;
  return best;
}

const REL_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "USING", "TABLE", "TRUNCATE"]);

/** Index of the `)` closing the `(` at `open`, or the last token. */
function closeOf(toks: Tok[], open: number): number {
  // Everything inside sits in deeper groups, so the first `)` back in the
  // opening group is the match.
  for (let i = open + 1; i < toks.length; i++) {
    if (toks[i].v === ")" && toks[i].g === toks[open].g) return i;
  }
  return toks.length - 1;
}

/** Output column names of the SELECT in group `g` (for CTEs and subqueries). */
function selectListColumns(toks: Tok[], g: number, scopeRefs: Ref[]): ColumnNode[] {
  const sel = toks.findIndex((t) => t.g === g && t.up === "SELECT");
  if (sel < 0) return [];
  const out: ColumnNode[] = [];
  let item: Tok[] = [];
  const flush = () => {
    const own = item.filter((t) => t.g === g);
    const last = own[own.length - 1];
    if (!last) return;
    const asAt = own.findIndex((t) => t.up === "AS");
    let name: string | null = null;
    if (asAt >= 0 && isName(own[asAt + 1])) name = own[asAt + 1].v;
    else if (last.v === "*") {
      const before = own[own.length - 2];
      const qual = before?.v === "." ? own[own.length - 3]?.v.toLowerCase() : null;
      for (const r of scopeRefs) {
        if (qual && (r.alias ?? r.name).toLowerCase() !== qual) continue;
        out.push(...refColumns(r));
      }
    } else if (last.v === ")" && own[0]?.t === "w") name = own[0].v;
    else if (last.t === "w" || last.t === "q") name = last.v;
    if (name) out.push({ name, type_name: "", nullable: true });
    item = [];
  };
  for (let i = sel + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.g === g && (t.up === "FROM" || t.v === ")" || t.v === ";")) break;
    if (t.g === g && t.up === "DISTINCT" && item.length === 0) continue;
    if (t.g === g && t.v === ",") flush();
    else item.push(t);
  }
  flush();
  return out;
}

function refColumns(r: Ref): ColumnNode[] {
  return r.cte?.columns ?? r.columns ?? r.rel?.columns ?? [];
}

function collectScope(toks: Tok[], index: CompletionIndex): { refs: Ref[]; ctes: Cte[] } {
  const refs: Ref[] = [];
  const ctes: Cte[] = [];

  // WITH name [(cols)] AS [NOT] [MATERIALIZED] ( … ), …
  const w = toks.findIndex((t) => t.up === "WITH");
  if (w >= 0) {
    let i = w + 1;
    if (toks[i]?.up === "RECURSIVE") i++;
    while (isName(toks[i])) {
      const name = toks[i].v;
      i++;
      let explicit: string[] | null = null;
      if (toks[i]?.v === "(") {
        const close = closeOf(toks, i);
        explicit = toks
          .slice(i + 1, close)
          .filter((t) => t.t === "w" || t.t === "q")
          .map((t) => t.v);
        i = close + 1;
      }
      if (toks[i]?.up !== "AS") break;
      i++;
      while (toks[i]?.up === "NOT" || toks[i]?.up === "MATERIALIZED") i++;
      if (toks[i]?.v !== "(") {
        ctes.push({ name, columns: [], explicit, g: -1 });
        break;
      }
      ctes.push({ name, columns: [], explicit, g: toks[i].ga });
      i = closeOf(toks, i) + 1;
      if (toks[i]?.v !== ",") break;
      i++;
    }
  }

  const cteByName = new Map(ctes.map((c) => [c.name.toLowerCase(), c]));
  for (let k = 0; k < toks.length; k++) {
    const kw = toks[k];
    if (!REL_KEYWORDS.has(kw.up)) continue;
    // `JOIN … USING (col)` lists columns, not a table.
    if (kw.up === "USING" && toks[k + 1]?.v === "(") continue;
    let i = k + 1;
    for (;;) {
      while (["ONLY", "LATERAL", "TABLE", "IF", "EXISTS"].includes(toks[i]?.up ?? "")) i++;
      let ref: Ref | null = null;
      if (toks[i]?.v === "(") {
        ref = { g: kw.g, schema: null, name: "", alias: null, rel: null, columns: null, at: i, sub: toks[i].ga };
        i = closeOf(toks, i) + 1;
      } else if (isName(toks[i])) {
        let schema: string | null = null;
        let name = toks[i].v;
        const at = i;
        if (toks[i + 1]?.v === "." && isName(toks[i + 2])) {
          schema = name;
          name = toks[i + 2].v;
          i += 3;
        } else i++;
        const cte = schema ? undefined : cteByName.get(name.toLowerCase());
        ref = {
          g: kw.g,
          schema,
          name,
          alias: null,
          rel: cte ? null : resolveRelation(index, schema, name),
          columns: null,
          cte,
          at,
        };
      }
      if (!ref) break;
      if (toks[i]?.up === "AS") i++;
      if (isName(toks[i]) && toks[i + 1]?.v !== ".") {
        ref.alias = toks[i].v;
        i++;
      }
      refs.push(ref);
      // FROM a, b and DELETE … USING a, b list several tables.
      if ((kw.up === "FROM" || kw.up === "USING") && toks[i]?.v === ",") {
        i++;
        continue;
      }
      break;
    }
  }

  // Output columns of subqueries and CTEs, innermost first so `select *`
  // over another subquery sees its columns.
  const inGroup = (g: number) => refs.filter((r) => r.g === g);
  for (const r of [...refs].reverse()) {
    if (r.sub !== undefined) r.columns = selectListColumns(toks, r.sub, inGroup(r.sub));
  }
  for (const c of [...ctes].reverse()) {
    c.columns = c.explicit
      ? c.explicit.map((name) => ({ name, type_name: "", nullable: true }))
      : c.g >= 0
        ? selectListColumns(toks, c.g, inGroup(c.g))
        : [];
  }
  return { refs, ctes };
}

// ---------------------------------------------------------------------------
// Matching

const isBoundary = (hay: string, i: number) => {
  if (i === 0) return true;
  const p = hay.charCodeAt(i - 1);
  return p === 95 || p === 46 || p === 32 || p === 36;
};

/**
 * How well `q` matches `hay` (both lowercase), or -1. Prefixes win, then a
 * word inside the name (`limits` in `entity_credit_limits`), then word starts
 * in order (`ecl`). A loose match in the middle of a word is a miss.
 */
export function matchName(hay: string, q: string, marks?: number[]): number {
  if (!q) return 0;
  if (hay.startsWith(q)) {
    if (marks) for (let i = 0; i < q.length; i++) marks.push(i);
    return (hay.length === q.length ? 1200 : 1000) - (hay.length - q.length) * 2;
  }
  for (let at = hay.indexOf(q, 1); at >= 0; at = hay.indexOf(q, at + 1)) {
    if (isBoundary(hay, at)) {
      if (marks) for (let i = 0; i < q.length; i++) marks.push(at + i);
      return 700 - at * 2 - (hay.length - q.length);
    }
  }
  // Word starts: each character continues the current word or starts a new one.
  if (hay[0] !== q[0] && !isBoundary(hay, hay.indexOf(q[0]))) return -1;
  const got: number[] = [];
  let pos = -1;
  let jumps = 0;
  for (let k = 0; k < q.length; k++) {
    const ch = q[k];
    if (pos >= 0 && hay[pos + 1] === ch) {
      pos++;
    } else {
      let j = hay.indexOf(ch, pos + 1);
      while (j >= 0 && !isBoundary(hay, j)) j = hay.indexOf(ch, j + 1);
      if (j < 0) return -1;
      if (pos >= 0) jumps++;
      pos = j;
    }
    got.push(pos);
  }
  if (got[0] !== 0 && !isBoundary(hay, got[0])) return -1;
  if (marks) marks.push(...got);
  return 450 - jumps * 10 - hay.length;
}

// ---------------------------------------------------------------------------
// Keywords

const STATEMENT_START = [
  "SELECT",
  "WITH",
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
  "EXPLAIN",
  "EXPLAIN ANALYZE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
];
const PG_STATEMENT_START = ["SHOW", "VACUUM", "ANALYZE", "COPY", "SET"];
const SQLITE_STATEMENT_START = ["PRAGMA", "VACUUM", "ATTACH"];

const AFTER_FROM = [
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "UNION",
  "RETURNING",
];
const AFTER_JOIN = ["ON", "USING"];

const EXPR_KEYWORDS = [
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "EXISTS",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AS",
  "DISTINCT",
  "TRUE",
  "FALSE",
  "CURRENT_DATE",
  "CURRENT_TIMESTAMP",
  "INTERVAL",
  "ASC",
  "DESC",
  "NULLS LAST",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "JOIN",
  "LEFT JOIN",
  "RETURNING",
];

/**
 * How common each keyword is in everyday SQL, so a fresh install already puts
 * SELECT above SET and FROM above FETCH. Your own habits (below) outweigh it.
 */
const COMMON: Record<string, number> = {
  SELECT: 40,
  FROM: 40,
  WHERE: 35,
  AND: 30,
  ON: 30,
  UPDATE: 25,
  "INSERT INTO": 25,
  JOIN: 25,
  "LEFT JOIN": 25,
  "ORDER BY": 25,
  "GROUP BY": 20,
  LIMIT: 20,
  AS: 20,
  "DELETE FROM": 15,
  IN: 15,
  "IS NULL": 15,
  "IS NOT NULL": 15,
  DESC: 15,
  WITH: 10,
  OR: 10,
  NOT: 10,
  NULL: 10,
  LIKE: 10,
  ILIKE: 10,
  COUNT: 10,
};

/** Keywords that start a statement, counted apart from the same word mid-statement (SET). */
const STARTERS = new Set([...STATEMENT_START, ...PG_STATEMENT_START, ...SQLITE_STATEMENT_START]);
const PHRASES = new Set([...STARTERS, ...AFTER_FROM, ...AFTER_JOIN, ...EXPR_KEYWORDS, "SET", "VALUES", "DEFAULT VALUES"]);

/** The key a keyword's use is counted under: `^SELECT` at a statement's start. */
export function habitKey(word: string, start: boolean): string {
  return start ? `^${word}` : word;
}

/**
 * The completable keywords a query uses, each once, keyed by `habitKey`.
 * Longest phrase wins, so `LEFT JOIN` counts as itself and not as JOIN too.
 */
export function keywordsIn(sql: string): Set<string> {
  const { toks } = scan(sql, 0, sql.length, sql.length);
  const used = new Set<string>();
  let start = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "w") {
      start = t.v === ";" || t.v === "(";
      continue;
    }
    let hit = "";
    let len = 0;
    for (let n = 3; n >= 1 && !hit; n--) {
      const words = toks.slice(i, i + n);
      if (words.length < n || words.some((w) => w.t !== "w")) continue;
      const phrase = words.map((w) => w.up).join(" ");
      if (PHRASES.has(phrase)) {
        hit = phrase;
        len = n;
      }
    }
    if (hit) {
      used.add(habitKey(hit, start && STARTERS.has(hit)));
      i += len - 1;
    }
    start = false;
  }
  return used;
}

/** Score for a keyword you've run `uses` times (decayed): big early, flat later. */
function habitBoost(uses: number): number {
  return uses > 0 ? Math.min(240, Math.round(60 * Math.log2(1 + uses))) : 0;
}

// ---------------------------------------------------------------------------
// The caret's context

type Context =
  | { kind: "none" }
  | { kind: "statement" }
  | { kind: "subquery" }
  | { kind: "relation"; join: boolean }
  | { kind: "after-relation"; join: boolean; update: boolean; insert: boolean }
  | { kind: "expr"; on: boolean }
  | { kind: "insert-columns"; table: Ref | null; listed: Set<string> };

function findContext(toks: Tok[], before: number, caretGroup: number): Context {
  // Walk back through the caret's own group to the clause keyword.
  let k = before - 1;
  const between: Tok[] = [];
  for (; k >= 0; k--) {
    const t = toks[k];
    if (t.v === "(" && t.ga === caretGroup) break;
    if (t.g !== caretGroup) continue;
    if (t.t === "w" && CLAUSE.has(t.up)) break;
    between.unshift(t);
  }
  const kw = k >= 0 ? toks[k] : null;

  if (!kw) return caretGroup === 0 && between.length === 0 ? { kind: "statement" } : { kind: "none" };

  if (kw.v === "(") {
    // INSERT INTO t ( col, … )
    const name = toks[k - 1];
    const into = toks[k - 2]?.up === "INTO" ? toks[k - 2] : toks[k - 4]?.up === "INTO" ? toks[k - 4] : null;
    if (into && isName(name)) return { kind: "insert-columns", table: null, listed: new Set() };
    if (between.length === 0) {
      const prev = toks[k - 1];
      if (!prev || prev.up === "AS" || prev.up === "FROM" || prev.up === "JOIN" || prev.up === "IN" || prev.up === "EXISTS")
        return prev?.up === "IN" ? { kind: "expr", on: false } : { kind: "subquery" };
    }
    return { kind: "expr", on: false };
  }

  const up = kw.up;
  const first = toks.find((t) => t.t === "w")?.up;
  if (up === "AS" || up === "LIMIT" || up === "OFFSET" || up === "WITH") return { kind: "none" };
  if (up === "TABLE" && (first === "CREATE" || toks[k - 1]?.up === "CREATE")) return { kind: "none" };
  if (up === "ON" && first === "CREATE") return { kind: "relation", join: false };
  if (up === "INDEX" || up === "CREATE" || up === "VIEW") return { kind: "none" };

  if (REL_KEYWORDS.has(up)) {
    const last = between[between.length - 1];
    if (between.length === 0 || ((up === "FROM" || up === "USING") && last?.v === ","))
      return { kind: "relation", join: up === "JOIN" };
    return {
      kind: "after-relation",
      join: up === "JOIN",
      update: up === "UPDATE",
      insert: up === "INTO",
    };
  }
  if (up === "BY" || EXPR_CLAUSE.has(up)) return { kind: "expr", on: up === "ON" };
  return { kind: "none" };
}

const EXPR_CLAUSE = new Set([
  "SELECT",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "ON",
  "HAVING",
  "SET",
  "RETURNING",
  "WHEN",
  "THEN",
  "ELSE",
  "CASE",
  "DISTINCT",
  "VALUES",
]);
const CLAUSE = new Set([
  ...REL_KEYWORDS,
  ...EXPR_CLAUSE,
  "BY",
  "AS",
  "LIMIT",
  "OFFSET",
  "WITH",
  "INDEX",
  "CREATE",
  "VIEW",
]);

// ---------------------------------------------------------------------------
// Candidates

interface Ctx {
  index: CompletionIndex;
  usage: Map<string, number>;
  /** Keyword uses across every connection, by `habitKey`. */
  habits: ReadonlyMap<string, number>;
  q: string;
  upperKeywords: boolean;
  out: Completion[];
}

function add(ctx: Ctx, c: Omit<Completion, "marks" | "score">, bonus: number, hay = c.label.toLowerCase()) {
  const marks: number[] = [];
  const m = matchName(hay, ctx.q, marks);
  if (m < 0) return;
  const usage = Math.min(200, (ctx.usage.get(hay) ?? 0) * 40);
  ctx.out.push({ ...c, marks, score: m + bonus + usage });
}

/**
 * A keyword, ranked by how often you run it, then how common it is, then
 * length. `minLen` letters must be typed first, unless it's one you use a lot.
 */
function keyword(ctx: Ctx, word: string, bonus = -150, start = false, minLen = 1) {
  // Keywords only complete what you started typing: no fuzzy, no empty prefix.
  const lc = word.toLowerCase();
  if (!ctx.q || !lc.startsWith(ctx.q) || lc === ctx.q) return;
  const habit = habitBoost(ctx.habits.get(habitKey(word, start)) ?? 0);
  if (ctx.q.length < minLen && habit < HABIT_EARLY) return;
  const text = ctx.upperKeywords ? word : lc;
  const marks = Array.from({ length: ctx.q.length }, (_, i) => i);
  const score = 1000 + bonus - lc.length + (COMMON[word] ?? 0) + habit;
  ctx.out.push({ kind: "keyword", label: text, insert: text, marks, score });
}

/** Boost (about three recent runs) at which a keyword shows from its first letter. */
const HABIT_EARLY = 120;

function relationKind(r: RelEntry): CompletionKind {
  return r.kind === "view" ? "view" : r.kind === "materialized_view" ? "matview" : "table";
}

function relationDetail(r: RelEntry, showSchema: boolean): string {
  const parts: string[] = [];
  if (showSchema) parts.push(r.schema);
  if (r.kind === "table" && r.rows !== null) parts.push(`${formatRowCount(r.rows)} rows`);
  else if (r.kind !== "table")
    parts.push(r.kind === "view" ? "view" : r.kind === "foreign_table" ? "foreign" : "mat view");
  return parts.join(" · ");
}

/** `schema.name` when a bare name would resolve to something else. */
function relationInsert(ctx: Ctx, r: RelEntry, qualified: boolean): string {
  if (qualified) return sqlIdent(r.name);
  const bare = resolveRelation(ctx.index, null, r.name);
  if (r.pathRank >= 99 || bare !== r) return `${sqlIdent(r.schema)}.${sqlIdent(r.name)}`;
  return sqlIdent(r.name);
}

function addRelations(ctx: Ctx, list: RelEntry[], qualified: boolean, related: Map<RelEntry, string>) {
  const multiSchema = ctx.index.schemas.length > 1;
  for (const r of list) {
    const link = related.get(r);
    const rows = r.rows ?? 0;
    const bonus =
      (link ? 250 : 0) +
      (r.pathRank < 99 ? 60 - Math.min(r.pathRank, 10) * 5 : 0) +
      Math.log10(rows + 1) * 4;
    add(
      ctx,
      {
        kind: relationKind(r),
        label: r.name,
        insert: relationInsert(ctx, r, qualified),
        detail: link ?? relationDetail(r, multiSchema && r.pathRank !== 0),
      },
      bonus,
      r.lc,
    );
  }
}

function addColumns(ctx: Ctx, ref: Ref, qualify: string | null, bonus: number, showOwner: boolean) {
  const cols = refColumns(ref);
  const pk = new Set(ref.rel?.table.primary_key ?? []);
  const fk = new Set((ref.rel?.table.foreign_keys ?? []).flatMap((f) => f.columns));
  const owner = ref.alias ?? ref.name;
  for (const c of cols) {
    const type = shortType(c.type_name);
    add(
      ctx,
      {
        kind: "column",
        // A name two tables share shows the alias it will be written with.
        label: qualify ? `${qualify}.${c.name}` : c.name,
        insert: qualify ? `${sqlIdent(qualify)}.${sqlIdent(c.name)}` : sqlIdent(c.name),
        detail: showOwner && owner && !qualify ? (type ? `${type} · ${owner}` : owner) : type,
        key: pk.has(c.name) ? "pk" : fk.has(c.name) ? "fk" : undefined,
      },
      bonus,
    );
  }
}

function shortType(t: string): string {
  return t
    .replace("character varying", "varchar")
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp")
    .replace("double precision", "float8");
}

function addFunctions(ctx: Ctx) {
  if (!ctx.q) return;
  for (const f of ctx.index.functions) addFunction(ctx, f);
}

function addFunction(ctx: Ctx, f: FnEntry) {
  const name = f.builtin ? f.name : sqlIdent(f.name);
  const qualified = f.schema && !f.builtin && f.schema !== "public" ? `${sqlIdent(f.schema)}.${name}` : name;
  add(
    ctx,
    {
      kind: "function",
      label: f.name,
      insert: `${qualified}()`,
      caretBack: f.args ? 1 : 0,
      detail: f.builtin ? "function" : f.returns || "function",
    },
    f.builtin ? -60 : 20,
    f.lc,
  );
}

/** Tables linked by a foreign key to the ones in scope, with a hint naming the link. */
function relatedTables(ctx: Ctx, refs: Ref[]): Map<RelEntry, string> {
  const out = new Map<RelEntry, string>();
  for (const ref of refs) {
    if (!ref.rel) continue;
    for (const link of ctx.index.links.get(ref.rel) ?? []) {
      if (link.other.partition || out.has(link.other)) continue;
      out.set(link.other, link.incoming ? `references ${ref.name}` : `referenced by ${ref.name}`);
    }
  }
  return out;
}

/** `c.id = o.customer_id` for each key between the joined table and the rest. */
function joinConditions(ctx: Ctx, joined: Ref, others: Ref[]) {
  if (!joined.rel) return;
  const a = joined.alias ?? joined.name;
  for (const link of ctx.index.links.get(joined.rel) ?? []) {
    for (const other of others) {
      if (other === joined || other.rel !== link.other) continue;
      const b = other.alias ?? other.name;
      const [mine, theirs] = link.incoming
        ? [link.fk.ref_columns, link.fk.columns]
        : [link.fk.columns, link.fk.ref_columns];
      const text = mine
        .map((col, i) => `${sqlIdent(a)}.${sqlIdent(col)} = ${sqlIdent(b)}.${sqlIdent(theirs[i] ?? col)}`)
        .join(ctx.upperKeywords ? " AND " : " and ");
      add(ctx, { kind: "join", label: text, insert: text, detail: "foreign key" }, 600, text.toLowerCase());
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point

export interface CompleteOptions {
  /** ⌃Space: offer candidates for an empty prefix too. */
  explicit?: boolean;
  /** Keyword uses (`keywordsIn` keys, decayed counts) that rank keywords. */
  habits?: ReadonlyMap<string, number>;
}

const NO_HABITS: ReadonlyMap<string, number> = new Map();

/** Statement bounds around the caret, extended to the caret while you type past its end. */
/**
 * The statements of the text being completed, re-scanned only from its first
 * changed line: completion runs on every keystroke, and a whole-text scan of
 * a 5,000-line editor was a few ms of each one.
 */
const statements = createStatementScanner();

function statementAround(text: string, caret: number): { start: number; end: number } {
  let prev: { start: number; end: number } | null = null;
  for (const r of statements.update(text)) {
    if (caret >= r.start && caret <= r.end) {
      if (caret === r.end && text[r.end - 1] === ";") return { start: caret, end: caret };
      return r;
    }
    if (r.start > caret) return prev && text[prev.end - 1] !== ";" ? { start: prev.start, end: r.start } : { start: caret, end: r.start };
    prev = r;
  }
  if (prev && text[prev.end - 1] !== ";") return { start: prev.start, end: text.length };
  return { start: caret, end: text.length };
}

export function complete(
  text: string,
  caret: number,
  index: CompletionIndex,
  usage: Map<string, number>,
  opts: CompleteOptions = {},
): CompletionResult | null {
  const st = statementAround(text, caret);
  const { toks, parent, inComment } = scan(text, st.start, st.end, caret);
  if (inComment) return null;

  // A caret inside a string: only enum labels complete there.
  const str = toks.find((t) => t.t === "s" && caret > t.s && (caret < t.e || t.open));
  if (str) return enumValues(text, caret, str, toks, index, usage, opts);

  // The word being typed, and the `x.` before it.
  let from = caret;
  let to = caret;
  let prefix: string;
  const quoted = toks.find((t) => t.t === "q" && caret > t.s && (caret < t.e || t.open));
  if (quoted) {
    // `"Order It` completes as a quoted name; the replacement takes the quote.
    from = quoted.s;
    to = quoted.open ? caret : quoted.e;
    prefix = text.slice(from + 1, caret);
  } else {
    while (from > st.start && isIdentPart(text.charCodeAt(from - 1))) from--;
    while (to < st.end && isIdentPart(text.charCodeAt(to))) to++;
    prefix = text.slice(from, caret);
    if (prefix && isDigit(prefix.charCodeAt(0))) return null;
  }

  const before = toks.findIndex((t) => t.e > from);
  const nBefore = before < 0 ? toks.length : before;
  let qualifier: string[] = [];
  let ctxEnd = nBefore;
  if (toks[nBefore - 1]?.v === "." && toks[nBefore - 1].e === from) {
    const a = toks[nBefore - 2];
    if (a && (a.t === "w" || a.t === "q")) {
      qualifier = [a.v];
      ctxEnd = nBefore - 2;
      const b = toks[nBefore - 4];
      if (toks[nBefore - 3]?.v === "." && b && (b.t === "w" || b.t === "q")) {
        qualifier = [b.v, a.v];
        ctxEnd = nBefore - 4;
      }
    } else return null;
  }
  if (!prefix && !qualifier.length && !opts.explicit) return null;

  const caretGroup = ctxEnd > 0 ? toks[ctxEnd - 1].ga : 0;
  const context = findContext(toks, ctxEnd, caretGroup);
  const { refs, ctes } = collectScope(toks, index);

  // Tables visible from the caret: its group and the groups around it.
  const groups = new Set<number>();
  for (let g = caretGroup; g >= 0; g = parent[g]) groups.add(g);
  const visible = refs.filter((r) => groups.has(r.g) && (r.name || r.alias));

  const firstWord = toks.find((t) => t.t === "w");
  const upperKeywords = prefix
    ? prefix !== prefix.toLowerCase()
    : firstWord
      ? firstWord.v === firstWord.up
      : true;
  const ctx: Ctx = { index, usage, habits: opts.habits ?? NO_HABITS, q: prefix.toLowerCase(), upperKeywords, out: [] };

  if (qualifier.length) {
    completeQualified(ctx, context, qualifier, visible);
  } else {
    switch (context.kind) {
      case "none":
        return null;
      case "statement": {
        const extra = index.engine === "postgres" ? PG_STATEMENT_START : SQLITE_STATEMENT_START;
        for (const k of [...STATEMENT_START, ...extra]) keyword(ctx, k, 0, true);
        break;
      }
      case "subquery":
        keyword(ctx, "SELECT", 0, true);
        keyword(ctx, "WITH", 0, true);
        break;
      case "relation": {
        for (const c of ctes)
          add(ctx, { kind: "cte", label: c.name, insert: sqlIdent(c.name), detail: "CTE" }, 300);
        const scope = visible.filter((r) => r.rel);
        addRelations(ctx, index.relations, false, context.join ? relatedTables(ctx, scope) : new Map());
        if (index.schemas.length > 1 && ctx.q) {
          for (const s of index.schemas)
            add(ctx, { kind: "schema", label: s, insert: `${sqlIdent(s)}.`, detail: "schema" }, -40);
        }
        break;
      }
      case "after-relation": {
        const words = context.update
          ? ["SET"]
          : context.insert
            ? ["VALUES", "SELECT", "DEFAULT VALUES"]
            : context.join
              ? [...AFTER_JOIN, ...AFTER_FROM]
              : AFTER_FROM;
        // Aliases are typed here too, so keywords need two letters first.
        if (ctx.q.length >= 2) for (const k of words) keyword(ctx, k, 0);
        break;
      }
      case "insert-columns": {
        const into = refs.find((r) => r.rel && toks[r.at - 1]?.up === "INTO") ?? null;
        if (!into) return null;
        const listed = new Set(
          toks
            .filter((t) => t.g === caretGroup && (t.t === "w" || t.t === "q") && t.e <= from)
            .map((t) => t.v.toLowerCase()),
        );
        for (const c of refColumns(into)) {
          if (listed.has(c.name.toLowerCase())) continue;
          const required = !c.nullable && !c.default;
          add(ctx, { kind: "column", label: c.name, insert: sqlIdent(c.name), detail: shortType(c.type_name) }, required ? 150 : 100);
        }
        break;
      }
      case "expr": {
        if (context.on) {
          // The table this ON belongs to is the last one joined before it.
          const joined = [...visible].reverse().find((r) => r.at < ctxEnd && r.g === caretGroup);
          if (joined) joinConditions(ctx, joined, visible);
        }
        const counts = new Map<string, number>();
        for (const r of visible)
          for (const c of refColumns(r)) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const many = visible.length > 1;
        for (const r of visible) {
          const nearest = r.g === caretGroup ? 300 : 200;
          const cols = refColumns(r);
          const ambiguous = many && cols.some((c) => (counts.get(c.name) ?? 0) > 1);
          if (!ambiguous) addColumns(ctx, r, null, nearest, many);
          else {
            // Qualify only the names two tables share.
            const shared: Ref = { ...r, columns: cols.filter((c) => (counts.get(c.name) ?? 0) > 1) };
            const own: Ref = { ...r, columns: cols.filter((c) => (counts.get(c.name) ?? 0) <= 1) };
            addColumns(ctx, own, null, nearest, many);
            addColumns(ctx, shared, r.alias ?? r.name, nearest - 20, many);
          }
          const name = r.alias ?? r.name;
          if (name)
            add(ctx, { kind: "alias", label: name, insert: sqlIdent(name), detail: r.alias && r.name ? r.name : "table" }, 120);
        }
        addFunctions(ctx);
        // Two letters first, or one for a keyword you run a lot (`select * f` → FROM).
        for (const k of EXPR_KEYWORDS) keyword(ctx, k, -150, false, 2);
        break;
      }
    }
  }

  const items = rank(ctx.out);
  if (items.length === 0) return null;
  // Nothing left to complete: the one match is what you typed.
  if (items.length === 1 && items[0].insert.toLowerCase() === text.slice(from, to).toLowerCase())
    return null;
  return { from, to, prefix, items };
}

function completeQualified(ctx: Ctx, context: Context, qualifier: string[], visible: Ref[]) {
  const index = ctx.index;
  if (qualifier.length === 2) {
    const rel = resolveRelation(index, qualifier[0], qualifier[1]);
    if (rel) addColumns(ctx, refFor(rel), null, 300, false);
    return;
  }
  const q = qualifier[0].toLowerCase();
  const inSchema = index.bySchema.get(q);
  if (context.kind === "relation" || context.kind === "after-relation") {
    if (inSchema) addRelations(ctx, inSchema, true, new Map());
    return;
  }
  const ref =
    visible.find((r) => r.alias?.toLowerCase() === q) ??
    visible.find((r) => !r.alias && r.name.toLowerCase() === q) ??
    visible.find((r) => r.name.toLowerCase() === q);
  if (ref) {
    addColumns(ctx, ref, null, 300, false);
    return;
  }
  if (inSchema) {
    addRelations(ctx, inSchema, true, new Map());
    return;
  }
  const rel = resolveRelation(index, null, qualifier[0]);
  if (rel) addColumns(ctx, refFor(rel), null, 300, false);
}

function refFor(rel: RelEntry): Ref {
  return { g: 0, schema: rel.schema, name: rel.name, alias: null, rel, columns: null, at: -1 };
}

/** `status = '` or `status IN ('open', '` on an enum column. */
function enumValues(
  text: string,
  caret: number,
  str: Tok,
  toks: Tok[],
  index: CompletionIndex,
  usage: Map<string, number>,
  opts: CompleteOptions,
): CompletionResult | null {
  let k = toks.indexOf(str) - 1;
  // Skip earlier items of an IN list.
  while (toks[k]?.v === "," && toks[k - 1]?.t === "s") k -= 2;
  if (toks[k]?.v === "(" && toks[k - 1]?.up === "IN") k -= 2;
  else if (["=", "<>", "!="].includes(toks[k]?.v ?? "")) k -= 1;
  else return null;
  const colTok = toks[k];
  if (!colTok || (colTok.t !== "w" && colTok.t !== "q")) return null;
  const qual = toks[k - 1]?.v === "." ? toks[k - 2]?.v.toLowerCase() : null;
  const { refs } = collectScope(toks, index);
  let type: string | null = null;
  for (const r of refs) {
    if (qual && (r.alias ?? r.name).toLowerCase() !== qual && r.name.toLowerCase() !== qual) continue;
    const c = refColumns(r).find((c) => c.name.toLowerCase() === colTok.v.toLowerCase());
    if (c) {
      type = c.type_name;
      break;
    }
  }
  const labels = type ? index.enums.get(type.replace(/"/g, "").toLowerCase()) : undefined;
  if (!labels) return null;
  const from = str.s + 1;
  const prefix = text.slice(from, caret);
  if (!prefix && !opts.explicit && caret !== from) return null;
  const to = str.open ? caret : str.e - 1;
  const ctx: Ctx = { index, usage, habits: NO_HABITS, q: prefix.toLowerCase(), upperKeywords: false, out: [] };
  labels.forEach((label, i) =>
    add(ctx, { kind: "value", label, insert: str.open ? `${label.replace(/'/g, "''")}'` : label.replace(/'/g, "''"), detail: type ?? "" }, -i),
  );
  const items = rank(ctx.out);
  return items.length ? { from, to, prefix, items } : null;
}

function rank(out: Completion[]): Completion[] {
  // Stable: equal scores keep catalog order (a table's columns as defined).
  out.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const items: Completion[] = [];
  for (const c of out) {
    const key = `${c.kind === "keyword" ? "k" : "o"}:${c.insert}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(c);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

/** `*` in a SELECT list with tables in scope: the columns it stands for. */
export function expandStar(
  text: string,
  caret: number,
  index: CompletionIndex,
): { from: number; to: number; insert: string } | null {
  if (text[caret - 1] !== "*") return null;
  const st = statementAround(text, caret);
  const { toks, parent } = scan(text, st.start, st.end, caret);
  const at = toks.findIndex((t) => t.v === "*" && t.e === caret);
  if (at < 0) return null;
  const star = toks[at];
  let qual: string | null = null;
  let from = star.s;
  if (toks[at - 1]?.v === "." && toks[at - 2]) {
    qual = toks[at - 2].v.toLowerCase();
    from = toks[at - 2].s;
  } else {
    const prev = toks[at - 1];
    if (prev && !(prev.up === "SELECT" || prev.v === "," || prev.up === "DISTINCT")) return null;
  }
  const { refs } = collectScope(toks, index);
  const groups = new Set<number>();
  for (let g = star.g; g >= 0; g = parent[g]) groups.add(g);
  const scope = refs.filter((r) => r.g === star.g || (qual !== null && groups.has(r.g)));
  const chosen = qual
    ? scope.filter((r) => (r.alias ?? r.name).toLowerCase() === qual)
    : scope;
  if (chosen.length === 0) return null;
  const qualify = qual !== null || chosen.length > 1;
  const names = chosen.flatMap((r) =>
    refColumns(r).map((c) =>
      qualify ? `${sqlIdent(r.alias ?? r.name)}.${sqlIdent(c.name)}` : sqlIdent(c.name),
    ),
  );
  return names.length ? { from, to: caret, insert: names.join(", ") } : null;
}

/**
 * The one catalog table or view a statement reads, or null: a plain SELECT
 * over exactly one relation (no CTEs, subqueries or joins), so a query tab can
 * offer that table's Structure.
 */
export function tableRead(sql: string, index: CompletionIndex): RelEntry | null {
  const { toks } = scan(sql, 0, sql.length, sql.length);
  if (toks[0]?.up !== "SELECT") return null;
  const { refs, ctes } = collectScope(toks, index);
  if (ctes.length > 0 || refs.length !== 1) return null;
  return refs[0].sub === undefined ? refs[0].rel : null;
}
