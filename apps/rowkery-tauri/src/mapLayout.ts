import { allTables, tableKey, type SidebarSchema, type SidebarTable } from "./schemaTree";
import type { ForeignKeyNode } from "./types";

/**
 * The schema map (Map view on a table tab): the centre table, the tables it
 * points to on the left and the tables that point to it on the right, laid
 * out in columns by distance. Built from the catalog the window already has
 * (foreign keys, read both ways), so it needs no query.
 */

/** How far from the centre the map reaches: 1 or 2 steps, or every connected table. */
export type MapDepth = 1 | 2 | "all";

/** "All" stays off above this many tables: a map that big helps nobody. */
export const MAP_ALL_LIMIT = 150;

/** A box's size and spacing, in CSS px; SchemaMap.css matches them. */
export const BOX_WIDTH = 220;
export const BOX_HEAD = 34;
export const BOX_ROW = 22;
export const BOX_PAD = 6;
export const COL_GAP = 120;
export const ROW_GAP = 24;

/** A box's height with its 1 px border: the head, then a row per key column. */
export function boxHeight(rows: number): number {
  return 2 + BOX_HEAD + rows * BOX_ROW + (rows ? BOX_PAD : 0);
}

/** The middle of a column's row on a box's side (the head's for a column not listed). */
export function rowY(box: MapBox, column: string | undefined): number {
  const i = column === undefined ? -1 : box.columns.findIndex((c) => c.name === column);
  return i < 0 ? box.y + 1 + BOX_HEAD / 2 : box.y + 1 + BOX_HEAD + i * BOX_ROW + BOX_ROW / 2;
}

export interface MapKeyColumn {
  name: string;
  type: string;
  /** "pk", "fk" (it points somewhere) or "ref" (only pointed at). */
  kind: "pk" | "fk" | "ref";
}

export interface MapBox {
  key: string;
  table: SidebarTable;
  /** Steps from the centre; 0 for the centre. */
  dist: number;
  /** Negative: it is pointed to (left); positive: it points (right). */
  col: number;
  columns: MapKeyColumn[];
  x: number;
  y: number;
  height: number;
}

export interface MapEdge {
  id: string;
  /** The table with the foreign key, and the table it points to. */
  from: string;
  to: string;
  fk: ForeignKeyNode;
  /** The columns pointed at (SQLite leaves them blank for the primary key). */
  refColumns: string[];
  /** "1" when the foreign key is also the child's whole primary key. */
  childEnd: "1" | "n";
}

export interface SchemaMapLayout {
  boxes: MapBox[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Distinct tables the centre points to, and that point to it. */
  pointsTo: number;
  pointedFrom: number;
}

/** SQLite leaves the target columns blank when they are the parent's primary key. */
export function refColumnsOf(fk: ForeignKeyNode, target: SidebarTable | undefined): string[] {
  if (fk.ref_columns.every((c) => c)) return fk.ref_columns;
  return target?.table.primary_key?.length ? target.table.primary_key : [];
}

/** Postgres spells some types long-hand; show the names people type. */
export function shortType(type: string): string {
  return type
    .replace(/^timestamp(\(\d+\))? with time zone/, "timestamptz$1")
    .replace(/^timestamp(\(\d+\))? without time zone/, "timestamp$1")
    .replace(/^time(\(\d+\))? with time zone/, "timetz$1")
    .replace(/^time(\(\d+\))? without time zone/, "time$1")
    .replace(/^character varying/, "varchar")
    .replace(/^character\b/, "char");
}

/** "on delete cascade"; nothing for the default (no action). */
export function onDeleteLabel(action: string): string | null {
  return action && action !== "NO ACTION" ? `on delete ${action.toLowerCase()}` : null;
}

interface Link {
  from: SidebarTable;
  to: SidebarTable;
  fk: ForeignKeyNode;
}

/** Every foreign key between two tables of the catalog, by table key both ways. */
function linksOf(schemas: SidebarSchema[]) {
  const byKey = new Map<string, SidebarTable>();
  for (const t of allTables(schemas)) byKey.set(t.key, t);
  const out = new Map<string, Link[]>();
  const into = new Map<string, Link[]>();
  for (const t of byKey.values()) {
    for (const fk of t.table.foreign_keys ?? []) {
      const to = byKey.get(tableKey(t.database, fk.ref_schema, fk.ref_table));
      if (!to) continue;
      const link = { from: t, to, fk };
      out.set(t.key, [...(out.get(t.key) ?? []), link]);
      into.set(to.key, [...(into.get(to.key) ?? []), link]);
    }
  }
  return { byKey, out, into };
}

/**
 * Lays out the map around `centreKey`. The left side follows foreign keys out
 * of the centre (what it points to, then what those point to); the right side
 * follows them in. A table sits in the column of its fewest steps, breadth
 * first with names in order, so the layout is the same every time.
 */
export function layoutSchemaMap(
  schemas: SidebarSchema[],
  centreKey: string,
  depth: MapDepth,
): SchemaMapLayout | null {
  const { byKey, out, into } = linksOf(schemas);
  const centre = byKey.get(centreKey);
  if (!centre) return null;
  const max = depth === "all" ? Infinity : depth;

  const placed = new Map<string, { dist: number; col: number }>([[centre.key, { dist: 0, col: 0 }]]);
  const order = [centre.key];
  for (const sideOf of [-1, 1] as const) {
    let frontier = [centre.key];
    for (let dist = 1; dist <= max && frontier.length; dist++) {
      const next: string[] = [];
      for (const key of frontier) {
        const reach = (sideOf < 0 ? (out.get(key) ?? []).map((l) => l.to) : (into.get(key) ?? []).map((l) => l.from)).sort(
          (a, b) => a.name.localeCompare(b.name),
        );
        for (const t of reach) {
          if (placed.has(t.key)) continue;
          placed.set(t.key, { dist, col: sideOf * dist });
          order.push(t.key);
          next.push(t.key);
        }
      }
      frontier = next;
    }
  }

  // The links among the placed tables, and the key columns each box lists.
  const edges: MapEdge[] = [];
  const keyCols = new Map<string, Set<string>>();
  const want = (key: string, cols: string[]) => {
    const set = keyCols.get(key) ?? new Set<string>();
    cols.forEach((c) => set.add(c));
    keyCols.set(key, set);
  };
  for (const key of order) {
    for (const l of out.get(key) ?? []) {
      // Two tables in one column (both one step out, say) would cross every
      // box between them: the map leaves that line out; Structure lists it.
      const to = placed.get(l.to.key);
      if (!to || (l.to.key !== key && to.col === placed.get(key)!.col)) continue;
      const refColumns = refColumnsOf(l.fk, l.to);
      const pk = l.from.table.primary_key ?? [];
      const whole = pk.length > 0 && pk.length === l.fk.columns.length && pk.every((c) => l.fk.columns.includes(c));
      edges.push({ id: `${l.from.key}:${l.fk.name}`, from: l.from.key, to: l.to.key, fk: l.fk, refColumns, childEnd: whole ? "1" : "n" });
      want(l.to.key, refColumns);
    }
  }

  // Rows inside a column follow what they attach to in the column nearer the
  // centre, so lines cross as little as a fixed rule allows; then by name.
  const columns = new Map<number, string[]>();
  for (const key of order) {
    const { col } = placed.get(key)!;
    columns.set(col, [...(columns.get(col) ?? []), key]);
  }
  const boxColumns = new Map<string, MapKeyColumn[]>();
  const rank = new Map<string, number>();
  const cols = [...columns.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  for (const c of cols) {
    const keys = columns.get(c)!;
    if (c !== 0) {
      const inner = c > 0 ? c - 1 : c + 1;
      const score = (key: string) => {
        let best = Infinity;
        for (const e of edges) {
          const other = e.from === key ? e.to : e.to === key ? e.from : null;
          if (!other || placed.get(other)?.col !== inner) continue;
          const otherCols = boxColumns.get(other) ?? [];
          const attach = other === e.from ? e.fk.columns[0] : e.refColumns[0];
          const at = Math.max(0, otherCols.findIndex((k) => k.name === attach));
          best = Math.min(best, (rank.get(other) ?? 0) * 1000 + at);
        }
        return best;
      };
      const scores = new Map(keys.map((k) => [k, score(k)]));
      keys.sort(
        (a, b) => scores.get(a)! - scores.get(b)! || byKey.get(a)!.name.localeCompare(byKey.get(b)!.name),
      );
    }
    keys.forEach((k, i) => {
      rank.set(k, i);
      boxColumns.set(k, keyColumnsOf(byKey.get(k)!, keyCols.get(k)));
    });
  }

  // Columns left to right; each column centred on the tallest.
  const heights = new Map<string, number>();
  for (const [k, list] of boxColumns) heights.set(k, boxHeight(list.length));
  const colHeight = (c: number) => columns.get(c)!.reduce((sum, k) => sum + heights.get(k)!, 0) + ROW_GAP * (columns.get(c)!.length - 1);
  const ordered = [...columns.keys()].sort((a, b) => a - b);
  const height = Math.max(...ordered.map(colHeight));
  const boxes: MapBox[] = [];
  ordered.forEach((c, i) => {
    let y = (height - colHeight(c)) / 2;
    for (const key of columns.get(c)!) {
      const p = placed.get(key)!;
      boxes.push({
        key,
        table: byKey.get(key)!,
        dist: p.dist,
        col: c,
        columns: boxColumns.get(key)!,
        x: i * (BOX_WIDTH + COL_GAP),
        y,
        height: heights.get(key)!,
      });
      y += heights.get(key)! + ROW_GAP;
    }
  });

  const neighbours = (links: Link[] | undefined, pick: (l: Link) => SidebarTable) =>
    new Set((links ?? []).map(pick).filter((t) => t.key !== centre.key).map((t) => t.key)).size;
  return {
    boxes,
    edges,
    width: ordered.length * BOX_WIDTH + (ordered.length - 1) * COL_GAP,
    height,
    pointsTo: neighbours(out.get(centre.key), (l) => l.to),
    pointedFrom: neighbours(into.get(centre.key), (l) => l.from),
  };
}

/** Primary key, foreign key and pointed-at columns, in the table's column order. */
function keyColumnsOf(t: SidebarTable, pointedAt: Set<string> | undefined): MapKeyColumn[] {
  const pk = new Set(t.table.primary_key ?? []);
  const fk = new Set((t.table.foreign_keys ?? []).flatMap((f) => f.columns));
  const out: MapKeyColumn[] = [];
  for (const c of t.table.columns ?? []) {
    const kind = pk.has(c.name) ? "pk" : fk.has(c.name) ? "fk" : pointedAt?.has(c.name) ? "ref" : null;
    if (kind) out.push({ name: c.name, type: shortType(c.type_name), kind });
  }
  return out;
}

/** The box beside `from` in the direction of an arrow key, or null at the edge. */
export function stepFrom(boxes: MapBox[], from: string, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null {
  const at = boxes.find((b) => b.key === from);
  if (!at) return null;
  const mid = (b: MapBox) => b.y + b.height / 2;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const same = boxes.filter((b) => b.x === at.x).sort((a, b) => a.y - b.y);
    const i = same.indexOf(at) + (key === "ArrowDown" ? 1 : -1);
    return same[i]?.key ?? null;
  }
  const xs = [...new Set(boxes.map((b) => b.x))].sort((a, b) => a - b);
  const x = xs[xs.indexOf(at.x) + (key === "ArrowRight" ? 1 : -1)];
  if (x === undefined) return null;
  const near = boxes
    .filter((b) => b.x === x)
    .sort((a, b) => Math.abs(mid(a) - mid(at)) - Math.abs(mid(b) - mid(at)));
  return near[0]?.key ?? null;
}
