import type { SchemaCatalog, TableNode } from "./types";
import { rowEstimateValue } from "./types";

export interface SidebarTable {
  /** `database.schema.table`, stable across refreshes. */
  key: string;
  database: string;
  schema: string;
  name: string;
  table: TableNode;
  rows: number | null;
  /** Partitions folded under a partitioned parent. Empty for ordinary tables. */
  partitions: SidebarTable[];
}

export interface SidebarSchema {
  key: string;
  database: string;
  schema: string;
  tables: SidebarTable[];
  /** Top-level tables; partitions are not counted separately. */
  count: number;
  /** Views and materialized views, listed in their own section. */
  views: SidebarTable[];
}

export function isView(t: SidebarTable) {
  return t.table.kind === "view" || t.table.kind === "materialized_view";
}

/** A table rows can be imported into: not a view, and not a foreign table, whose rows live elsewhere. */
export function takesImport(t: SidebarTable) {
  return !isView(t) && t.table.kind !== "foreign_table";
}

/** Every table, partition and view, flat. */
export function allTables(schemas: SidebarSchema[]): SidebarTable[] {
  return schemas.flatMap((s) => [...s.tables.flatMap((t) => [t, ...t.partitions]), ...s.views]);
}

export function tableKey(database: string, schema: string, name: string) {
  return `${database}.${schema}.${name}`;
}

/** Group partitions under their parent so `events_p0…p99` fold into one row. */
export function buildSchemaTree(
  catalog: SchemaCatalog | null,
): SidebarSchema[] {
  if (!catalog) return [];
  const out: SidebarSchema[] = [];
  for (const db of catalog.databases) {
    for (const schema of db.schemas) {
      const byName = new Map<string, SidebarTable>();
      for (const table of schema.tables) {
        byName.set(table.name, {
          key: tableKey(db.name, schema.name, table.name),
          database: db.name,
          schema: schema.name,
          name: table.name,
          table,
          rows: rowEstimateValue(table.row_estimate),
          partitions: [],
        });
      }
      const top: SidebarTable[] = [];
      for (const item of byName.values()) {
        const parent = item.table.partition_of
          ? byName.get(item.table.partition_of)
          : undefined;
        if (parent && parent !== item) {
          parent.partitions.push(item);
          // Partitions arrive without columns: they are their parent's.
          if (!item.table.columns?.length)
            item.table = { ...item.table, columns: parent.table.columns };
        } else top.push(item);
      }
      for (const item of top) {
        if (item.partitions.length === 0) continue;
        item.partitions.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
        // Partitioned parents report no tuples of their own; show the total.
        const known = item.partitions
          .map((p) => p.rows)
          .filter((n): n is number => n !== null);
        if (known.length > 0) item.rows = known.reduce((a, b) => a + b, 0);
      }
      top.sort((a, b) => a.name.localeCompare(b.name));
      const tables = top.filter((t) => !isView(t));
      out.push({
        key: `${db.name}.${schema.name}`,
        database: db.name,
        schema: schema.name,
        tables,
        count: tables.length,
        views: top.filter(isView),
      });
    }
  }
  return out;
}

/** Keep tables (and parents of partitions) and views whose name contains `query`. */
export function filterSchemaTree(
  schemas: SidebarSchema[],
  query: string,
): SidebarSchema[] {
  const q = query.trim().toLowerCase();
  if (!q) return schemas;
  const hit = (name: string) => name.toLowerCase().includes(q);
  return schemas
    .map((s) => {
      const tables: SidebarTable[] = [];
      for (const t of s.tables) {
        const parts = t.partitions.filter((p) => hit(p.name));
        if (hit(t.name) || parts.length > 0) {
          tables.push({ ...t, partitions: hit(t.name) ? t.partitions : parts });
        }
      }
      const views = s.views.filter((v) => hit(v.name));
      return { ...s, tables, count: tables.length, views };
    })
    .filter((s) => s.tables.length > 0 || s.views.length > 0);
}

export function findTable(
  schemas: SidebarSchema[],
  key: string,
): SidebarTable | undefined {
  for (const s of schemas) {
    for (const t of s.tables) {
      if (t.key === key) return t;
      const p = t.partitions.find((x) => x.key === key);
      if (p) return p;
    }
    const v = s.views.find((x) => x.key === key);
    if (v) return v;
  }
  return undefined;
}

/** A row count the window saw itself, and the catalog's count it was seen over. */
export interface SeenCount {
  rows: number;
  over: number | null;
}

/**
 * The tree with the row counts the window has seen itself (`seen`, by table
 * key) over the catalog's: Postgres's estimate only moves at ANALYZE, so a
 * table the grid just emptied would still read 2. A catalog count that has
 * moved since (ANALYZE ran, SQLite counted again) is newer and wins. The
 * same tree when no count differs.
 */
export function withSeenCounts(schemas: SidebarSchema[], seen: Record<string, SeenCount>): SidebarSchema[] {
  const over = (t: SidebarTable): SidebarTable => {
    const partitions = t.partitions.map(over);
    const s = seen[t.key];
    const rows = s && s.over === t.rows ? s.rows : t.rows;
    return rows === t.rows && partitions.every((p, i) => p === t.partitions[i]) ? t : { ...t, rows, partitions };
  };
  let changed = false;
  const out = schemas.map((s) => {
    const tables = s.tables.map(over);
    if (tables.every((t, i) => t === s.tables[i])) return s;
    changed = true;
    return { ...s, tables };
  });
  return changed ? out : schemas;
}
