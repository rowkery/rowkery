import type { ResultRows } from "./resultStore";
export type Value =
  | { Null: null }
  | { Bool: boolean }
  | { Int: number }
  /** An integer outside ±(2^53 − 1), as its exact digits (a number would round it). */
  | { BigInt: string }
  | { Float: number }
  | { Text: string }
  /** `Bytes` may be only a prefix (binary frames send 16 bytes); `byteLength` is the size. */
  | { Bytes: number[]; byteLength?: number };

export interface Column {
  name: string;
  type_name: string;
}

export interface QueryResultDto {
  columns: Column[];
  /** Grows in place while the run streams (`useResultRows` re-renders on it). */
  rows: ResultRows;
  row_count: number;
  elapsed_ms: number;
  error: string | null;
  cancelled: boolean;
  /** Safe mode stopped the query before it reached the database. */
  hold?: SafetyHold | null;
  /** Rows a statement without a result set changed. */
  affected_rows?: number | null;
  /** From the start of the run to the first row (the database and the network). */
  first_row_ms?: number | null;
  /** Rows frames the result arrived in. */
  frames?: number;
  /** The server's SQLSTATE when it refused the statement. */
  sqlstate?: string | null;
  /** 1-based character offset of the error in the statement. */
  error_position?: number | null;
  /** The server's DETAIL and HINT lines, as psql prints them (`DETAIL:  Key (email)=(a@b.c) already exists.`). */
  error_detail?: string | null;
  /** The run reached the most rows a tab holds and left the rest out. */
  capped?: boolean;
  /** The server's warnings, one per line (`there is no transaction in progress`). */
  warning?: string | null;
  /** Stopped without the server's answer: it may still finish the statement. */
  forced?: boolean;
}

/** Whether writes run, wait for confirmation, or are refused. Only a label
 * (`environment`) never changes this. */
export type SafeMode = "off" | "confirm" | "read_only";

export const SAFE_MODES: { value: SafeMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "confirm", label: "Confirm writes" },
  { value: "read_only", label: "Read-only" },
];

export interface StatementCheck {
  kind: "read" | "session" | "write" | "schema";
  /** `DELETE`, `DROP TABLE`, `CREATE INDEX`, … */
  verb: string;
  target: string | null;
  /** DROP, TRUNCATE, or DELETE / UPDATE with no WHERE. */
  destructive: boolean;
  unlocks_writes: boolean;
}

export interface SafetyHold {
  /** `confirm`: runs once the user confirms. `refuse`: never runs. */
  action: "confirm" | "refuse";
  mode: SafeMode;
  statements: StatementCheck[];
}

export interface SchemaCatalog {
  databases: DatabaseNode[];
  /** Postgres `current_schemas(false)`; empty for SQLite and older cores. */
  search_path?: string[];
  enums?: EnumNode[];
  /** User-defined functions (Postgres). */
  functions?: FunctionNode[];
}

export interface EnumNode {
  schema: string;
  name: string;
  labels: string[];
}

export interface FunctionNode {
  schema: string;
  name: string;
  args: string;
  returns: string;
}

/** Index details for one table, fetched when Structure opens (Postgres). */
export interface TableIndexes {
  schema: string;
  table: string;
  indexes: IndexNode[];
  index_bytes: number | null;
}

export interface DatabaseNode {
  name: string;
  schemas: SchemaNode[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export interface ColumnNode {
  name: string;
  type_name: string;
  nullable: boolean;
  default?: string | null;
  /** Postgres `COMMENT ON COLUMN`; absent without one and on SQLite. */
  comment?: string | null;
}

export interface IndexNode {
  name: string;
  columns: string[];
  unique: boolean;
  primary?: boolean;
  /** Access method (btree, gin, …). Null for SQLite. */
  method?: string | null;
  size_bytes?: number | null;
  /** Scans since the stats were last reset. */
  scans?: number | null;
}

export interface ForeignKeyNode {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  on_delete: string;
}

export type RowEstimate =
  | { Exact: number }
  | { Approximate: number }
  | "Unknown";

export type TableKind = "table" | "view" | "materialized_view" | "foreign_table";

export interface TableNode {
  name: string;
  /** Missing on catalogs from older cores: treat as a table. */
  kind?: TableKind;
  columns?: ColumnNode[];
  primary_key?: string[];
  indexes?: IndexNode[];
  row_estimate?: RowEstimate;
  /** Postgres: partitioned parent in the same schema. */
  partition_of?: string | null;
  foreign_keys?: ForeignKeyNode[];
  table_bytes?: number | null;
  index_bytes?: number | null;
  /** `indexes` and `index_bytes` load with `tableIndexes` when needed. */
  indexes_deferred?: boolean;
  /** Postgres `COMMENT ON TABLE`; absent without one and on SQLite. */
  comment?: string | null;
}

export function rowEstimateValue(est: RowEstimate | undefined): number | null {
  if (!est || est === "Unknown") return null;
  if ("Exact" in est) return est.Exact;
  return est.Approximate;
}

/** 1234 → "1.2k", 48_600_000 → "48.6M". */
export function formatRowCount(n: number | null): string {
  if (n === null) return "";
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}k`;
  return String(n);
}

/** 1536 → "1.5 kB", 3_355_443 → "3.2 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trimZero(v)} ${units[i]}`;
}

/** 212 → "212 ms", 1834 → "1.83 s". */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function trimZero(v: number): string {
  const s = v >= 100 ? Math.round(v).toString() : v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Deployment a connection points at; coloured so production stands out. */
export type ConnectionEnv = "prd" | "stg" | "dev" | "local";

/** Picker order: safest first, production last. */
export const CONNECTION_ENVS: { value: ConnectionEnv; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "dev", label: "Development" },
  { value: "stg", label: "Staging" },
  { value: "prd", label: "Production" },
];

export type ConnectionRecord =
  | {
      kind: "sqlite";
      id: string;
      name: string;
      path: string;
      environment?: ConnectionEnv | null;
      safe_mode?: SafeMode;
      /** The bundled sample database (core `sample.rs`). */
      sample?: boolean;
      /** Readable by the MCP server (`Rowkery --mcp`). Off by default. */
      allow_mcp?: boolean;
      /** Tables the MCP server keeps from agents (`schema.table`). */
      mcp_hidden_tables?: string[];
      /** Sharing ends at this Unix ms; unset shares until turned off. */
      mcp_until?: number | null;
      /** Don't keep 24 h samples of what MCP calls returned. */
      mcp_samples_off?: boolean;
      /** Longest one agent query may run, in seconds (`MCP_TIMEOUTS`); unset is 10. */
      mcp_timeout_s?: number | null;
      /** Databases and tables shared with agents (mcpAccess.ts); unset on connections saved before it. */
      mcp_access?: McpAccess | null;
      /** Sensitive columns per database, as `schema.table.column`: agents get stand-ins. */
      masked_columns?: MaskedColumns;
    }
  | {
      kind: "postgres";
      id: string;
      name: string;
      host: string;
      port: number;
      database: string;
      username: string;
      ssl_mode?: SslMode;
      /** CA file for `verify` against a private CA; the system store when unset. */
      ssl_root_cert?: string | null;
      ssh?: SshConfig | null;
      /** A Cloud SQL instance, reached through the built-in connector; `host` then only names it. */
      cloud_sql?: CloudSqlConfig | null;
      environment?: ConnectionEnv | null;
      safe_mode?: SafeMode;
      /** Readable by the MCP server (`Rowkery --mcp`). Off by default. */
      allow_mcp?: boolean;
      /** Tables the MCP server keeps from agents (`schema.table`). */
      mcp_hidden_tables?: string[];
      /** Sharing ends at this Unix ms; unset shares until turned off. */
      mcp_until?: number | null;
      /** Don't keep 24 h samples of what MCP calls returned. */
      mcp_samples_off?: boolean;
      /** Longest one agent query may run, in seconds (`MCP_TIMEOUTS`); unset is 10. */
      mcp_timeout_s?: number | null;
      /** Databases and tables shared with agents (mcpAccess.ts); unset on connections saved before it. */
      mcp_access?: McpAccess | null;
      /** Sensitive columns per database, as `schema.table.column`: agents get stand-ins. */
      masked_columns?: MaskedColumns;
    };

/** Per database (SQLite `main`): its sensitive columns as `schema.table.column`. */
export type MaskedColumns = Record<string, string[]>;

/** Per database (SQLite `main`): how its tables are shared. A database with no entry isn't. */
export type McpAccess = Record<string, McpDbAccess>;

export interface McpDbAccess {
  /** `picked`: only `tables` (Only ticked). `all`: every table but `tables` (All but unticked). */
  mode: "picked" | "all";
  /** `schema.table` names. */
  tables?: string[];
}

export type SslMode = "disable" | "prefer" | "require" | "verify";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  auth_method: "keyfile" | "password";
  private_key_path?: string | null;
  trust_host?: boolean;
}

export interface CloudSqlConfig {
  /** `project:region:instance`, the console's Connection name. */
  instance: string;
  ip_type?: CloudSqlIpType;
  /** The gcloud login on this computer, or a service account key in the keychain. */
  credentials?: "gcloud" | "key";
}

export type CloudSqlIpType = "public" | "private" | "psc";

export interface ConnectionSecrets {
  db_password?: string | null;
  ssh_password?: string | null;
  ssh_key_passphrase?: string | null;
  /** A Cloud SQL connection's service account key (the file's JSON). */
  gcp_key?: string | null;
}

export interface ConnectionListDto {
  connections: ConnectionRecord[];
}

export function formatCell(value: Value): string {
  return safeFormatCell(value);
}

/** Never throws — malformed or missing cells must not blank the webview. */
export function safeFormatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const v = value as Record<string, unknown>;
  if ("Null" in v) return "NULL";
  if ("Bool" in v) return v.Bool ? "true" : "false";
  if ("Int" in v) return String(v.Int);
  if ("BigInt" in v) return String(v.BigInt);
  if ("Float" in v) return String(v.Float);
  if ("Text" in v) return String(v.Text);
  if ("Bytes" in v) {
    const bytes = v.Bytes;
    if (typeof v.byteLength === "number") return `<${v.byteLength} bytes>`;
    if (Array.isArray(bytes)) {
      return `<${bytes.length} bytes>`;
    }
    return "<bytes>";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "<unprintable>";
  }
}

export function connectionSubtitle(record: ConnectionRecord): string {
  if (record.kind === "sqlite") return record.path;
  if (record.cloud_sql) return `${record.cloud_sql.instance}/${record.database} · Cloud SQL`;
  const base = `${record.host}:${record.port}/${record.database}`;
  return record.ssh ? `${base} · ssh` : base;
}

export function engineForConnection(record: ConnectionRecord): "sqlite" | "postgres" {
  return record.kind;
}
