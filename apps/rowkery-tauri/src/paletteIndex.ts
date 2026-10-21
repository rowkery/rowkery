import { parsePostgresUrl } from "./connectionUrl";
import type { SidebarSchema, SidebarTable } from "./schemaTree";
import { formatRowCount } from "./types";

export type PaletteGroup = "tables" | "queries" | "connections" | "commands";

export const GROUP_ORDER: PaletteGroup[] = [
  "tables",
  "queries",
  "connections",
  "commands",
];

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  tables: "Tables",
  queries: "Recent queries",
  connections: "Connections",
  commands: "Commands",
};

/** `t:users` / `q:select` / `>new tab` limit search to one group. */
const SCOPE_PREFIX: [string, PaletteGroup][] = [
  ["t:", "tables"],
  ["q:", "queries"],
  [">", "commands"],
];

/** The prefix each group header prints; connections match by name and have none. */
export const GROUP_PREFIX: Record<PaletteGroup, string | null> = {
  tables: "t:",
  queries: "q:",
  connections: null,
  commands: ">",
};

export type PaletteTarget =
  | { kind: "table"; table: SidebarTable }
  | { kind: "query"; sql: string }
  | { kind: "connection"; id: string }
  | { kind: "command"; id: string }
  /** A pasted connection string: the New Connection sheet, filled from it. */
  | { kind: "connection-url"; url: string }
  /** A pasted SQLite file path: opened as a connection named after it. */
  | { kind: "sqlite-path"; path: string };

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  /** Text that is matched and shown, e.g. `public.failed_jobs`. */
  label: string;
  /** `label` lowercased once, so a keystroke never allocates per item. */
  hay: string;
  /** Dim text after the label (connection address, schema). */
  detail?: string;
  /** Right-aligned hint: row count, time ago. */
  meta?: string;
  /** Right-aligned shortcut keycap. */
  keys?: string;
  /** Lowercased synonyms (commands.ts); a hit on one scores as a label hit. */
  syn?: string[];
  /** Times picked from ⌘K (commands): ranks near-ties and the empty list. */
  uses?: number;
  target: PaletteTarget;
}

export interface PaletteHit {
  item: PaletteItem;
  score: number;
  /** Indices into `item.label` to highlight. */
  marks: number[];
}

export interface PaletteSection {
  group: PaletteGroup;
  hits: PaletteHit[];
}

export function item(
  group: PaletteGroup,
  id: string,
  label: string,
  target: PaletteTarget,
  extra: Pick<PaletteItem, "detail" | "meta" | "keys" | "syn" | "uses"> = {},
): PaletteItem {
  return { id, group, label, hay: label.toLowerCase(), target, ...extra };
}

/**
 * Tables, flattened once per schema load. Partitions are left out: their
 * parent already stands for them and `events_p0…p99` would bury it.
 */
export function buildTableIndex(schemas: SidebarSchema[]): PaletteItem[] {
  const tables: PaletteItem[] = [];
  const multiDb = new Set(schemas.map((s) => s.database)).size > 1;
  for (const s of schemas) {
    for (const t of [...s.tables, ...s.views]) {
      const rows = formatRowCount(t.rows);
      tables.push(
        item(
          "tables",
          `t:${t.key}`,
          `${s.schema}.${t.name}`,
          {
            kind: "table",
            table: t,
          },
          {
            detail: multiDb ? s.database : undefined,
            meta: rows ? `${rows} rows` : undefined,
          },
        ),
      );
    }
  }
  return tables;
}

function isBoundary(hay: string, i: number): boolean {
  if (i === 0) return true;
  const prev = hay.charCodeAt(i - 1);
  // . _ space - /
  return (
    prev === 46 || prev === 95 || prev === 32 || prev === 45 || prev === 47
  );
}

const MISS = -Infinity;

/**
 * Substring hits beat scattered ones; word-start, earlier and shorter labels
 * rank higher. Returns MISS when `q` does not match. Allocation-free, so it
 * can run over every table of a large schema on each keystroke.
 */
export function scoreMatch(hay: string, q: string): number {
  const at = hay.indexOf(q);
  if (at >= 0) {
    let score = 1000 - at - (hay.length - q.length) * 0.25;
    if (isBoundary(hay, at)) {
      score += 300;
      // The whole last segment: `users` → `public.users` over `users_old`.
      if (at + q.length === hay.length) score += 200;
    }
    return score;
  }
  // In-order characters, e.g. `fj` → failed_jobs. Word starts earn more.
  let from = 0;
  let prev = -2;
  let score = 200;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === " ") continue;
    const j = hay.indexOf(ch, from);
    if (j < 0) return MISS;
    if (j === prev + 1) score += 8;
    else if (isBoundary(hay, j)) score += 12;
    else score -= Math.min(j - from, 10);
    prev = j;
    from = j + 1;
  }
  return score - hay.length * 0.25;
}

/** Positions `scoreMatch` matched, computed only for the rows shown. */
export function matchMarks(hay: string, q: string): number[] {
  const at = hay.indexOf(q);
  const marks: number[] = [];
  if (at >= 0) {
    for (let i = 0; i < q.length; i++) marks.push(at + i);
    return marks;
  }
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const j = hay.indexOf(ch, from);
    if (j < 0) break;
    marks.push(j);
    from = j + 1;
  }
  return marks;
}

export function parseScope(raw: string): {
  scope: PaletteGroup | null;
  query: string;
} {
  const trimmed = raw.trimStart();
  for (const [prefix, group] of SCOPE_PREFIX) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return { scope: group, query: trimmed.slice(prefix.length).trim() };
    }
  }
  return { scope: null, query: raw.trim() };
}

export const MAX_PER_GROUP = 8;
export const MAX_SCOPED = 60;

/**
 * Nudges which group leads when their best hits tie: `fail` should land on
 * the `failed_jobs` table before a recent query that mentions it.
 */
const GROUP_BIAS: Record<PaletteGroup, number> = {
  tables: 40,
  commands: 20,
  connections: 20,
  queries: 0,
};

/**
 * The label's score, or a synonym's when that is better: `help` finds
 * Keyboard shortcuts. A synonym counts only as a substring (its scattered
 * letters would match nearly anything) and scores a little under the same
 * hit on a label, so `copy` puts the Copy… commands above Duplicate row.
 */
function scoreItem(it: PaletteItem, q: string): { score: number; viaSynonym: boolean } {
  const score = scoreMatch(it.hay, q);
  let best = score;
  if (it.syn) {
    for (const s of it.syn) {
      if (s.indexOf(q) < 0) continue;
      const alt = scoreMatch(s, q) * SYNONYM_WEIGHT;
      if (alt > best) best = alt;
    }
  }
  return { score: best, viaSynonym: best > score };
}

/** A synonym hit's share of the same hit on a label: just outside a tie (`TIE`). */
const SYNONYM_WEIGHT = 0.85;

/** Command scores within this fraction of each other tie, and use decides. */
const TIE = 0.1;

interface Ranked {
  it: PaletteItem;
  score: number;
  viaSynonym: boolean;
}

/**
 * Commands (a few dozen) are ranked whole: by score, then each run of scores
 * within `TIE` of the run's best is reordered by use (stable, so registry
 * order breaks equal use). With no query the most used come first.
 */
function rankCommands(items: PaletteItem[], q: string, limit: number): Ranked[] {
  const hits: Ranked[] = [];
  for (const it of items) {
    const s = q ? scoreItem(it, q) : { score: 0, viaSynonym: false };
    if (s.score !== MISS) hits.push({ it, ...s });
  }
  hits.sort((a, b) => b.score - a.score);
  const byUse = (a: Ranked, b: Ranked) => (b.it.uses ?? 0) - (a.it.uses ?? 0);
  const out: Ranked[] = [];
  for (let i = 0; i < hits.length && out.length < limit; ) {
    const head = hits[i].score;
    let j = i + 1;
    while (j < hits.length && head - hits[j].score <= Math.abs(head) * TIE) j++;
    out.push(...hits.slice(i, j).sort(byUse));
    i = j;
  }
  return out.slice(0, limit);
}

/**
 * Filter every group and order the groups by their best hit, so `new tab`
 * puts Commands first and `users` puts Tables first. Each group keeps its
 * best `limit` hits in a small sorted buffer instead of sorting every match.
 */
export function searchPalette(
  groups: Record<PaletteGroup, PaletteItem[]>,
  query: string,
  scope: PaletteGroup | null,
  emptyGroups: PaletteGroup[],
): PaletteSection[] {
  const q = query.toLowerCase();
  const limit = scope ? MAX_SCOPED : MAX_PER_GROUP;
  const wanted = scope ? [scope] : q ? GROUP_ORDER : emptyGroups;
  const out: PaletteSection[] = [];
  for (const group of wanted) {
    const items = groups[group];
    if (group === "commands") {
      const ranked = rankCommands(items, q, limit);
      if (ranked.length === 0) continue;
      out.push({
        group,
        hits: ranked.map((h) => ({
          item: h.it,
          score: h.score + GROUP_BIAS[group],
          // A synonym hit highlights nothing in the label.
          marks: q && !h.viaSynonym ? matchMarks(h.it.hay, q) : [],
        })),
      });
      continue;
    }
    const top: PaletteItem[] = [];
    const scores: number[] = [];
    if (!q) {
      for (let i = 0; i < items.length && i < limit; i++) {
        top.push(items[i]);
        scores.push(0);
      }
    } else {
      for (const it of items) {
        const score = scoreMatch(it.hay, q);
        if (score === MISS) continue;
        if (top.length === limit && score <= scores[limit - 1]) continue;
        let i = top.length;
        while (i > 0 && scores[i - 1] < score) i--;
        top.splice(i, 0, it);
        scores.splice(i, 0, score);
        if (top.length > limit) {
          top.pop();
          scores.pop();
        }
      }
    }
    if (top.length === 0) continue;
    out.push({
      group,
      hits: top.map((it, i) => ({
        item: it,
        score: scores[i] + GROUP_BIAS[group],
        marks: q ? matchMarks(it.hay, q) : [],
      })),
    });
  }
  if (q) {
    // Stable: ties keep GROUP_ORDER.
    out.sort((a, b) => b.hits[0].score - a.hits[0].score);
  }
  return out;
}

/**
 * An absolute, `~/` or `C:\` path ending in .sqlite / .sqlite3 / .db / .db3.
 * Not `~\`: core expands only `~/` (expand_home).
 */
const SQLITE_PATH = /^(?:~\/|\/|[A-Za-z]:[\\/])[^\r\n]*\.(?:sqlite3?|db3?)$/i;

/**
 * ⌘K's first row for a pasted connection string or SQLite file path, above
 * every group; null for anything else (and for scoped input such as `t:`).
 */
export function pastedItem(raw: string): PaletteItem | null {
  const text = raw.trim().replace(/^(["'])(.*)\1$/s, "$2");
  if (!text || /^(t:|q:|>)/i.test(text)) return null;
  if (SQLITE_PATH.test(text)) {
    return item("connections", "paste:file", "Open SQLite file", { kind: "sqlite-path", path: text }, { detail: text });
  }
  const form = parsePostgresUrl(text);
  if (!form || !(form.host || form.database)) return null;
  const where = [form.host, form.database].filter(Boolean).join("/");
  return item("connections", "paste:url", "New connection from URL", { kind: "connection-url", url: text }, { detail: where });
}

/**
 * Builds a value when the browser is idle (after a short timeout where there
 * is no `requestIdleCallback`, as in WebKit), or at once when asked for
 * first. ⌘K's table index is built this way after a schema lands, so neither
 * the schema's paint nor ⌘K's open pays for it.
 */
export function idleBuild<T>(build: () => T): { get: () => T; cancel: () => void } {
  let value: { v: T } | null = null;
  const get = () => {
    if (!value) value = { v: build() };
    return value.v;
  };
  const w = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(get, { timeout: 2000 });
    return { get, cancel: () => w.cancelIdleCallback?.(h) };
  }
  const h = setTimeout(get, 50);
  return { get, cancel: () => clearTimeout(h) };
}

/** Double-quote an identifier only when Postgres/SQLite would need it. */
export function sqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** One line, collapsed whitespace, for showing a stored query. */
export function queryLabel(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
