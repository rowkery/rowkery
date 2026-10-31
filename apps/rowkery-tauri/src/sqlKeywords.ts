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

/**
 * MySQL's reserved words: bare, they aren't names there. A mirror of
 * `MYSQL_RESERVED` in crates/rowkery-core/src/db/introspect.rs, kept equal by
 * test/sqlKeywords.test.ts.
 */
export const MYSQL_RESERVED: readonly string[] = [
  "accessible", "add", "all", "alter", "analyze", "and", "as", "asc", "asensitive", "before", "between",
  "bigint", "binary", "blob", "both", "by", "call", "cascade", "case", "change", "char", "character", "check",
  "collate", "column", "condition", "constraint", "continue", "convert", "create", "cross", "cube",
  "cume_dist", "current_date", "current_time", "current_timestamp", "current_user", "cursor", "database",
  "databases", "day_hour", "day_microsecond", "day_minute", "day_second", "dec", "decimal", "declare",
  "default", "delayed", "delete", "dense_rank", "desc", "describe", "deterministic", "distinct", "distinctrow",
  "div", "double", "drop", "dual", "each", "else", "elseif", "empty", "enclosed", "escaped", "except",
  "exists", "exit", "explain", "false", "fetch", "first_value", "float", "float4", "float8", "for", "force",
  "foreign", "from", "fulltext", "function", "generated", "get", "grant", "group", "grouping", "groups",
  "having", "high_priority", "hour_microsecond", "hour_minute", "hour_second", "if", "ignore", "in", "index",
  "infile", "inner", "inout", "insensitive", "insert", "int", "int1", "int2", "int3", "int4", "int8",
  "integer", "intersect", "interval", "into", "io_after_gtids", "io_before_gtids", "is", "iterate", "join",
  "json_table", "key", "keys", "kill", "lag", "last_value", "lateral", "lead", "leading", "leave", "left",
  "like", "limit", "linear", "lines", "load", "localtime", "localtimestamp", "lock", "long", "longblob",
  "longtext", "loop", "low_priority", "master_bind", "master_ssl_verify_server_cert", "match", "maxvalue",
  "mediumblob", "mediumint", "mediumtext", "middleint", "minute_microsecond", "minute_second", "mod",
  "modifies", "natural", "no_write_to_binlog", "not", "nth_value", "ntile", "null", "numeric", "of", "offset",
  "on", "optimize", "optimizer_costs", "option", "optionally", "or", "order", "out", "outer", "outfile",
  "over", "partition", "percent_rank", "precision", "primary", "procedure", "purge", "range", "rank", "read",
  "read_write", "reads", "real", "recursive", "references", "regexp", "release", "rename", "repeat", "replace",
  "require", "resignal", "restrict", "return", "returning", "revoke", "right", "rlike", "row", "row_number",
  "rows", "schema", "schemas", "second_microsecond", "select", "sensitive", "separator", "set", "show",
  "signal", "smallint", "spatial", "specific", "sql", "sql_big_result", "sql_calc_found_rows",
  "sql_small_result", "sqlexception", "sqlstate", "sqlwarning", "ssl", "starting", "stored", "straight_join",
  "system", "table", "terminated", "then", "tinyblob", "tinyint", "tinytext", "to", "trailing", "trigger",
  "true", "undo", "union", "unique", "unlock", "unsigned", "update", "usage", "use", "using", "utc_date",
  "utc_time", "utc_timestamp", "values", "varbinary", "varchar", "varcharacter", "varying", "virtual", "when",
  "where", "while", "window", "with", "write", "xor", "year_month", "zerofill",
];

const MYSQL_RESERVED_SET = new Set(MYSQL_RESERVED);

/** Whether `ident` must be quoted on MySQL (core's `quote_ident` for MySQL). */
export function mysqlNeedsQuoting(ident: string): boolean {
  return needsQuoting(ident) || MYSQL_RESERVED_SET.has(ident.toLowerCase());
}
