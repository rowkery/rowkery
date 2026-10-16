import type { RowEstimate, SchemaCatalog } from "./types";

/** One table's row count (src-tauri `table_counts`, SQLite). */
export interface TableCount {
  database: string;
  table: string;
  rows: RowEstimate;
}

/**
 * The catalog with SQLite's row counts filled in. They arrive after the
 * catalog is shown (counting was most of what introspection cost); tables
 * not counted keep what they had. Returns the same catalog when nothing
 * changed, so React skips the render.
 */
export function applyTableCounts(catalog: SchemaCatalog, counts: TableCount[]): SchemaCatalog {
  const byKey = new Map(counts.map((c) => [`${c.database}\0${c.table}`, c.rows]));
  let changed = false;
  const databases = catalog.databases.map((db) => {
    const schemas = db.schemas.map((schema) => {
      const tables = schema.tables.map((t) => {
        const rows = byKey.get(`${db.name}\0${t.name}`);
        if (rows === undefined || JSON.stringify(rows) === JSON.stringify(t.row_estimate)) return t;
        changed = true;
        return { ...t, row_estimate: rows };
      });
      return tables.some((t, i) => t !== schema.tables[i]) ? { ...schema, tables } : schema;
    });
    return schemas.some((s, i) => s !== db.schemas[i]) ? { ...db, schemas } : db;
  });
  return changed ? { ...catalog, databases } : catalog;
}
