import { firstLine } from "./comments";
import { ResultRows } from "./resultStore";
import type { SidebarSchema, SidebarTable } from "./schemaTree";
import { summarizeRows } from "./columnProfile";
import { formatBytes, type Column, type QueryResultDto, type Value } from "./types";

/**
 * ⌘K "All tables as rows": every table, partition and view of the loaded
 * catalog as a result, built in memory (no query), so the grid can sort and
 * copy it like any other.
 */

const KIND: Record<string, string> = {
  table: "table",
  view: "view",
  materialized_view: "mat view",
};

const text = (s: string | null | undefined): Value => (s ? { Text: s } : { Null: null });
const int = (n: number | null | undefined): Value => (n == null ? { Null: null } : { Int: n });

function row(t: SidebarTable, partition: boolean): Value[] {
  const node = t.table;
  const bytes = node.table_bytes == null ? null : node.table_bytes + (node.index_bytes ?? 0);
  return [
    text(t.name),
    text(t.schema),
    text(partition ? "partition" : (KIND[node.kind ?? "table"] ?? node.kind)),
    int(t.rows),
    text(bytes == null ? null : formatBytes(bytes)),
    int(node.columns?.length),
    text(node.partition_of),
    text(firstLine(node.comment)),
  ];
}

/** The rows, and the one-line SQL comment the tab shows in place of a query. */
export function catalogResult(schemas: SidebarSchema[]): { result: QueryResultDto; sql: string } {
  const rows: Value[][] = [];
  for (const s of schemas) {
    for (const t of s.tables) {
      rows.push(row(t, false));
      for (const p of t.partitions) rows.push(row(p, true));
    }
    for (const v of s.views) rows.push(row(v, false));
  }
  const columns: Column[] = [
    { name: "name", type_name: "text" },
    { name: "schema", type_name: "text" },
    { name: "kind", type_name: "text" },
    { name: "≈ rows", type_name: "int8" },
    { name: "size", type_name: "text" },
    { name: "columns", type_name: "int4" },
    { name: "partition of", type_name: "text" },
    { name: "comment", type_name: "text" },
  ];
  // Built here, so profiled here: once, over the rows this result will ever have.
  const resultRows = ResultRows.fromValues(rows);
  resultRows.setProfiles(summarizeRows(columns, resultRows));
  const databases = [...new Set(schemas.map((s) => s.database))].join(", ");
  const n = rows.length.toLocaleString();
  return {
    sql: `-- ${n} tables and views in ${databases || "this database"}, from the catalog`,
    result: {
      columns,
      rows: resultRows,
      row_count: rows.length,
      elapsed_ms: 0,
      error: null,
      cancelled: false,
    },
  };
}
