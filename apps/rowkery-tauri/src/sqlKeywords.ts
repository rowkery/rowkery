/**
 * Words that can't stand bare as a name: Postgres's reserved and column-name
 * keywords and SQLite's keywords. A mirror of `KEYWORDS` in
 * crates/rowkery-core/src/db/introspect.rs (core's `quote_ident`), kept equal
 * by test/sqlKeywords.test.ts, so the chips quote a column exactly as core's
 * SQL does.
 */
export const SQL_KEYWORDS: readonly string[] = [
  "abort", "action", "add", "after", "all", "alter", "always", "analyse", "analyze", "and", "any", "array",
  "as", "asc", "asymmetric", "attach", "authorization", "autoincrement", "before", "begin", "between",
  "bigint", "binary", "bit", "boolean", "both", "by", "cascade", "case", "cast", "char", "character", "check",
  "coalesce", "collate", "collation", "column", "commit", "concurrently", "conflict", "constraint", "create",
  "cross", "current", "current_catalog", "current_date", "current_role", "current_schema", "current_time",
  "current_timestamp", "current_user", "database", "dec", "decimal", "default", "deferrable", "deferred",
  "delete", "desc", "detach", "distinct", "do", "drop", "each", "else", "end", "escape", "except", "exclude",
  "exclusive", "exists", "explain", "extract", "fail", "false", "fetch", "filter", "first", "float",
  "following", "for", "foreign", "freeze", "from", "full", "generated", "glob", "grant", "greatest", "group",
  "grouping", "groups", "having", "if", "ignore", "ilike", "immediate", "in", "index", "indexed", "initially",
  "inner", "inout", "insert", "instead", "int", "integer", "intersect", "interval", "into", "is", "isnull",
  "join", "key", "last", "lateral", "leading", "least", "left", "like", "limit", "localtime", "localtimestamp",
  "match", "materialized", "national", "natural", "nchar", "no", "none", "normalize", "not", "nothing",
  "notnull", "null", "nullif", "nulls", "numeric", "of", "offset", "on", "only", "or", "order", "others",
  "out", "outer", "over", "overlaps", "overlay", "partition", "placing", "plan", "position", "pragma",
  "preceding", "precision", "primary", "query", "raise", "range", "real", "recursive", "references", "regexp",
  "reindex", "release", "rename", "replace", "restrict", "returning", "right", "rollback", "row", "rows",
  "savepoint", "select", "session_user", "set", "setof", "similar", "smallint", "some", "substring",
  "symmetric", "system_user", "table", "tablesample", "temp", "temporary", "then", "ties", "time", "timestamp",
  "to", "trailing", "transaction", "treat", "trigger", "trim", "true", "unbounded", "union", "unique",
  "update", "user", "using", "vacuum", "values", "varchar", "variadic", "verbose", "view", "virtual", "when",
  "where", "window", "with", "without",
];

const KEYWORD_SET = new Set(SQL_KEYWORDS);

/** Whether `ident` must be quoted to mean itself (core's `needs_quoting`). */
export function needsQuoting(ident: string): boolean {
  return !/^[a-z_][a-z0-9_]*$/.test(ident) || KEYWORD_SET.has(ident);
}
