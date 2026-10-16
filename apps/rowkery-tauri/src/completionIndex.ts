/**
 * What the editor completes from: one index per schema load, built from the
 * catalog the window already has (no extra queries), plus a static list of
 * common built-in functions and a usage map from the local query history.
 * `sqlComplete.ts` reads it on every keystroke, so everything here is
 * lowercased and grouped up front.
 */

import type {
  ColumnNode,
  ForeignKeyNode,
  SchemaCatalog,
  TableKind,
  TableNode,
} from "./types";
import { rowEstimateValue } from "./types";
import type { HistoryEntry } from "./queryHistory";

export type Engine = "postgres" | "sqlite";

export interface RelEntry {
  schema: string;
  name: string;
  /** `name` lowercased, for matching. */
  lc: string;
  kind: TableKind;
  table: TableNode;
  columns: ColumnNode[];
  rows: number | null;
  /** Position of the schema in the search path; 99 when a name needs `schema.`. */
  pathRank: number;
  /** Partitions resolve (`from events_p3`) but are never suggested. */
  partition: boolean;
}

export interface FkLink {
  fk: ForeignKeyNode;
  /** The table on the other end. */
  other: RelEntry;
  /** True when `other` references this table (an incoming key). */
  incoming: boolean;
}

export interface FnEntry {
  name: string;
  lc: string;
  schema: string | null;
  /** Argument list shown beside the name; empty for none. */
  args: string;
  returns: string;
  builtin: boolean;
}

export interface CompletionIndex {
  engine: Engine;
  relations: RelEntry[];
  /** Lowercased name → every relation with it (all schemas, partitions too). */
  byName: Map<string, RelEntry[]>;
  /** Lowercased schema → its relations. */
  bySchema: Map<string, RelEntry[]>;
  schemas: string[];
  /** Foreign keys touching each relation, both directions. */
  links: Map<RelEntry, FkLink[]>;
  /** Lowercased enum type name (bare and `schema.name`) → labels. */
  enums: Map<string, string[]>;
  functions: FnEntry[];
}

const POSTGRES_FUNCTIONS = `count sum avg min max coalesce nullif greatest least
  date_trunc date_part extract age to_char to_date to_timestamp make_interval
  lower upper length trim ltrim rtrim substring replace concat concat_ws
  split_part position left right strpos regexp_replace regexp_match
  regexp_matches starts_with string_agg array_agg json_agg jsonb_agg
  json_build_object jsonb_build_object jsonb_set jsonb_array_elements
  jsonb_array_length jsonb_each jsonb_object_keys jsonb_pretty to_jsonb to_json
  lag lead first_value last_value ntile round ceil floor abs mod trunc
  generate_series unnest array_length array_position cardinality md5 encode
  decode format pg_size_pretty pg_total_relation_size pg_relation_size
  pg_sleep pg_cancel_backend pg_terminate_backend bool_and bool_or
  percentile_cont date_bin`;
const POSTGRES_NO_ARGS = "now random gen_random_uuid row_number rank dense_rank pg_backend_pid version";

const SQLITE_FUNCTIONS = `count sum avg min max total group_concat coalesce
  ifnull nullif iif length lower upper trim ltrim rtrim substr replace instr
  printf format abs round datetime date time julianday strftime unixepoch
  json json_extract json_object json_array json_group_array json_each typeof
  hex quote lag lead`;
const SQLITE_NO_ARGS = "random changes last_insert_rowid row_number rank dense_rank";

function builtins(engine: Engine): FnEntry[] {
  const withArgs = engine === "postgres" ? POSTGRES_FUNCTIONS : SQLITE_FUNCTIONS;
  const noArgs = engine === "postgres" ? POSTGRES_NO_ARGS : SQLITE_NO_ARGS;
  const out: FnEntry[] = [];
  for (const [list, args] of [
    [withArgs, "…"],
    [noArgs, ""],
  ] as const) {
    for (const name of list.split(/\s+/)) {
      if (name) out.push({ name, lc: name, schema: null, args, returns: "", builtin: true });
    }
  }
  return out;
}

function pathRankFor(engine: Engine, searchPath: string[], schema: string): number {
  if (engine === "sqlite") return schema === "main" ? 0 : 99;
  if (searchPath.length === 0) return schema === "public" ? 0 : 99;
  const i = searchPath.indexOf(schema);
  return i < 0 ? 99 : i;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function buildCompletionIndex(
  catalog: SchemaCatalog,
  engine: Engine,
): CompletionIndex {
  const searchPath = catalog.search_path ?? [];
  const relations: RelEntry[] = [];
  const byName = new Map<string, RelEntry[]>();
  const bySchema = new Map<string, RelEntry[]>();
  const byKey = new Map<string, RelEntry>();
  const schemas: string[] = [];

  for (const db of catalog.databases) {
    for (const schema of db.schemas) {
      schemas.push(schema.name);
      const rank = pathRankFor(engine, searchPath, schema.name);
      const parents = new Map(schema.tables.map((t) => [t.name, t]));
      for (const table of schema.tables) {
        const parent = table.partition_of ? parents.get(table.partition_of) : undefined;
        const partition = !!parent && parent !== table;
        // Partitions arrive without columns: they are their parent's.
        const columns =
          table.columns && table.columns.length > 0
            ? table.columns
            : partition
              ? (parent.columns ?? [])
              : [];
        const entry: RelEntry = {
          schema: schema.name,
          name: table.name,
          lc: table.name.toLowerCase(),
          kind: table.kind ?? "table",
          table,
          columns,
          rows: rowEstimateValue(table.row_estimate),
          pathRank: rank,
          partition,
        };
        push(byName, entry.lc, entry);
        byKey.set(`${schema.name}\0${table.name}`, entry);
        if (!partition) {
          relations.push(entry);
          push(bySchema, schema.name.toLowerCase(), entry);
        }
      }
    }
  }

  // Partitioned parents report no tuples of their own; use their partitions'.
  for (const list of byName.values()) {
    for (const e of list) {
      if (!e.partition || e.rows === null) continue;
      const parent = byKey.get(`${e.schema}\0${e.table.partition_of}`);
      if (parent) parent.rows = (parent.rows ?? 0) + e.rows;
    }
  }

  const links = new Map<RelEntry, FkLink[]>();
  for (const from of byKey.values()) {
    for (const fk of from.table.foreign_keys ?? []) {
      const to = byKey.get(`${fk.ref_schema}\0${fk.ref_table}`);
      if (!to) continue;
      push(links, from, { fk, other: to, incoming: false });
      if (to !== from) push(links, to, { fk, other: from, incoming: true });
    }
  }

  const enums = new Map<string, string[]>();
  for (const e of catalog.enums ?? []) {
    enums.set(e.name.toLowerCase(), e.labels);
    enums.set(`${e.schema}.${e.name}`.toLowerCase(), e.labels);
  }

  const functions: FnEntry[] = [
    ...(catalog.functions ?? []).map((f) => ({
      name: f.name,
      lc: f.name.toLowerCase(),
      schema: f.schema,
      args: f.args,
      returns: f.returns,
      builtin: false,
    })),
    ...builtins(engine),
  ];

  return { engine, relations, byName, bySchema, schemas, links, enums, functions };
}

const built = new WeakMap<SchemaCatalog, CompletionIndex>();

/** The index for a catalog, built on first use and kept while the catalog lives. */
export function completionIndexFor(
  catalog: SchemaCatalog,
  engine: Engine,
): CompletionIndex {
  let index = built.get(catalog);
  if (!index || index.engine !== engine) {
    index = buildCompletionIndex(catalog, engine);
    built.set(catalog, index);
  }
  return index;
}

/** Days for a history entry's weight to halve. */
const HALF_LIFE_DAYS = 7;

/**
 * How much each lowercased word shows up in recent queries, newer runs
 * weighing more. Each query counts a word once, so `id` in a long query
 * doesn't outweigh a table you open every day.
 */
export function usageFromHistory(
  history: HistoryEntry[],
  now = Date.now(),
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const entry of history) {
    const days = Math.max(0, now - entry.at) / 86_400_000;
    const weight = Math.pow(0.5, days / HALF_LIFE_DAYS);
    const seen = new Set<string>();
    for (const m of entry.sql.matchAll(/"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)/g)) {
      const word = (m[1] ? m[1].replace(/""/g, '"') : m[2]).toLowerCase();
      if (seen.has(word)) continue;
      seen.add(word);
      usage.set(word, (usage.get(word) ?? 0) + weight);
    }
  }
  return usage;
}
