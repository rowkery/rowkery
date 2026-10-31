use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::Value;
use crate::query_util::sql_literal;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineKind {
    Sqlite,
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SchemaCatalog {
    pub databases: Vec<DatabaseNode>,
    /// Postgres `current_schemas(false)`: where unqualified names resolve, first wins.
    #[serde(default)]
    pub search_path: Vec<String>,
    /// Postgres enum types, for completing their labels.
    #[serde(default)]
    pub enums: Vec<EnumNode>,
    /// User-defined functions (not `pg_catalog`, not owned by an extension).
    #[serde(default)]
    pub functions: Vec<FunctionNode>,
    /// Lookups built from the tables the first time they're asked for
    /// ([`Self::inherited_by`], [`Self::table`]). Built once: a catalog whose
    /// tables are added or removed afterwards must be a new one.
    #[serde(skip)]
    pub(crate) derived: Derived,
}

/// Derived from the tables, so two catalogs are equal whether or not it has
/// been built yet.
#[derive(Clone, Debug, Default)]
pub(crate) struct Derived(std::sync::OnceLock<Lookups>);

#[derive(Clone, Debug, Default)]
pub(crate) struct Lookups {
    /// Each table's direct partitions and child tables.
    children: HashMap<SchemaTable, Vec<SchemaTable>>,
    /// Where each table is: database, schema and table index (the first,
    /// when two databases have the same name).
    at: HashMap<SchemaTable, (usize, usize, usize)>,
}

/// `(schema, name)`.
type SchemaTable = (String, String);

impl PartialEq for Derived {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl SchemaCatalog {
    fn lookups(&self) -> &Lookups {
        self.derived.0.get_or_init(|| {
            let mut found = Lookups::default();
            for (d, db) in self.databases.iter().enumerate() {
                for (i, s) in db.schemas.iter().enumerate() {
                    for (j, t) in s.tables.iter().enumerate() {
                        found
                            .at
                            .entry((s.name.clone(), t.name.clone()))
                            .or_insert((d, i, j));
                        for parent in &t.inherits_from {
                            found
                                .children
                                .entry(parent.clone())
                                .or_default()
                                .push((s.name.clone(), t.name.clone()));
                        }
                    }
                }
            }
            found
        })
    }

    /// The direct partitions and child tables of `schema.name`, as
    /// `(schema, name)`, wherever they live.
    pub fn inherited_by(&self, schema: &str, name: &str) -> &[(String, String)] {
        self.lookups()
            .children
            .get(&(schema.to_string(), name.to_string()))
            .map_or(&[], Vec::as_slice)
    }

    /// The table `schema.name` with that exact spelling, in any database.
    pub fn table(&self, schema: &str, name: &str) -> Option<&TableNode> {
        let &(d, i, j) = self
            .lookups()
            .at
            .get(&(schema.to_string(), name.to_string()))?;
        Some(&self.databases[d].schemas[i].tables[j])
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnumNode {
    pub schema: String,
    pub name: String,
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FunctionNode {
    pub schema: String,
    pub name: String,
    /// `pg_get_function_identity_arguments`, e.g. `user_id bigint, since date`.
    pub args: String,
    pub returns: String,
}

/// Indexes of one table, fetched when its Structure opens (Postgres).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableIndexes {
    pub schema: String,
    pub table: String,
    pub indexes: Vec<IndexNode>,
    pub index_bytes: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatabaseNode {
    pub name: String,
    pub schemas: Vec<SchemaNode>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
}

/// What kind of relation a [`TableNode`] is. Views are browsed like tables.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableKind {
    #[default]
    Table,
    View,
    /// Postgres only.
    MaterializedView,
    /// Postgres only: rows kept outside the database (`CREATE FOREIGN TABLE`).
    ForeignTable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableNode {
    pub name: String,
    #[serde(default)]
    pub kind: TableKind,
    pub columns: Vec<ColumnNode>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<IndexNode>,
    pub row_estimate: RowEstimate,
    /// Postgres: name of the partitioned parent (same schema) when this table is a partition.
    #[serde(default)]
    pub partition_of: Option<String>,
    /// Postgres: every table this one is a partition or child table of
    /// (`pg_inherits`), as `(schema, name)`, in any schema. Its rows are
    /// theirs too: `SELECT` from a parent reads them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inherits_from: Vec<(String, String)>,
    /// Postgres: a partition (`relispartition`), in any schema. Its one
    /// parent in `inherits_from` holds its rows as its own; a child table
    /// made with `INHERITS` is a table of its own as well.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_partition: bool,
    /// Outgoing foreign keys. "Referenced by" is derived from the whole catalog.
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyNode>,
    /// Approximate on-disk size of the table heap (Postgres: `relpages`, no stat calls).
    #[serde(default)]
    pub table_bytes: Option<i64>,
    /// Approximate on-disk size of all indexes on the table.
    #[serde(default)]
    pub index_bytes: Option<i64>,
    /// `indexes` and `index_bytes` were left out of the catalog load; fetch
    /// them with `table_indexes` when they are needed.
    #[serde(default)]
    pub indexes_deferred: bool,
    /// Postgres `COMMENT ON TABLE` (`obj_description`); None without one and on SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ForeignKeyNode {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT`.
    pub on_delete: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ColumnNode {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    /// Postgres `COMMENT ON COLUMN` (`col_description`); None without one and on SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IndexNode {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(default)]
    pub primary: bool,
    /// Access method (`btree`, `gin`, …). None for SQLite.
    #[serde(default)]
    pub method: Option<String>,
    /// Approximate size from `relpages`.
    #[serde(default)]
    pub size_bytes: Option<i64>,
    /// Index scans since stats reset (`pg_stat_user_indexes.idx_scan`).
    #[serde(default)]
    pub scans: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RowEstimate {
    Exact(u64),
    Approximate(u64),
    Unknown,
}

impl RowEstimate {
    pub fn display(&self) -> String {
        match self {
            RowEstimate::Exact(n) => format_rows(*n),
            RowEstimate::Approximate(n) => format!("~{}", format_rows(*n)),
            RowEstimate::Unknown => "—".into(),
        }
    }
}

fn format_rows(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// Words that can't stand bare as a name: Postgres's reserved and column-name
/// keywords, and SQLite's keywords. A name that is one of them is quoted.
const KEYWORDS: &[&str] = &[
    "abort",
    "action",
    "add",
    "after",
    "all",
    "alter",
    "always",
    "analyse",
    "analyze",
    "and",
    "any",
    "array",
    "as",
    "asc",
    "asymmetric",
    "attach",
    "authorization",
    "autoincrement",
    "before",
    "begin",
    "between",
    "bigint",
    "binary",
    "bit",
    "boolean",
    "both",
    "by",
    "cascade",
    "case",
    "cast",
    "char",
    "character",
    "check",
    "coalesce",
    "collate",
    "collation",
    "column",
    "commit",
    "concurrently",
    "conflict",
    "constraint",
    "create",
    "cross",
    "current",
    "current_catalog",
    "current_date",
    "current_role",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_user",
    "database",
    "dec",
    "decimal",
    "default",
    "deferrable",
    "deferred",
    "delete",
    "desc",
    "detach",
    "distinct",
    "do",
    "drop",
    "each",
    "else",
    "end",
    "escape",
    "except",
    "exclude",
    "exclusive",
    "exists",
    "explain",
    "extract",
    "fail",
    "false",
    "fetch",
    "filter",
    "first",
    "float",
    "following",
    "for",
    "foreign",
    "freeze",
    "from",
    "full",
    "generated",
    "glob",
    "grant",
    "greatest",
    "group",
    "grouping",
    "groups",
    "having",
    "if",
    "ignore",
    "ilike",
    "immediate",
    "in",
    "index",
    "indexed",
    "initially",
    "inner",
    "inout",
    "insert",
    "instead",
    "int",
    "integer",
    "intersect",
    "interval",
    "into",
    "is",
    "isnull",
    "join",
    "key",
    "last",
    "lateral",
    "leading",
    "least",
    "left",
    "like",
    "limit",
    "localtime",
    "localtimestamp",
    "match",
    "materialized",
    "national",
    "natural",
    "nchar",
    "no",
    "none",
    "normalize",
    "not",
    "nothing",
    "notnull",
    "null",
    "nullif",
    "nulls",
    "numeric",
    "of",
    "offset",
    "on",
    "only",
    "or",
    "order",
    "others",
    "out",
    "outer",
    "over",
    "overlaps",
    "overlay",
    "partition",
    "placing",
    "plan",
    "position",
    "pragma",
    "preceding",
    "precision",
    "primary",
    "query",
    "raise",
    "range",
    "real",
    "recursive",
    "references",
    "regexp",
    "reindex",
    "release",
    "rename",
    "replace",
    "restrict",
    "returning",
    "right",
    "rollback",
    "row",
    "rows",
    "savepoint",
    "select",
    "session_user",
    "set",
    "setof",
    "similar",
    "smallint",
    "some",
    "substring",
    "symmetric",
    "system_user",
    "table",
    "tablesample",
    "temp",
    "temporary",
    "then",
    "ties",
    "time",
    "timestamp",
    "to",
    "trailing",
    "transaction",
    "treat",
    "trigger",
    "trim",
    "true",
    "unbounded",
    "union",
    "unique",
    "update",
    "user",
    "using",
    "vacuum",
    "values",
    "varchar",
    "variadic",
    "verbose",
    "view",
    "virtual",
    "when",
    "where",
    "window",
    "with",
    "without",
];

/// Reserved words of MySQL 8.4 and MariaDB, space separated: on MySQL a
/// name that is one of them (or a [`KEYWORDS`] word) is quoted.
const MYSQL_RESERVED: &str =
    "accessible add all alter analyze and as asc asensitive before between bigint binary \
    blob both by call cascade case change char character check collate column condition \
    constraint continue convert create cross cube cume_dist current_date current_time \
    current_timestamp current_user cursor database databases day_hour day_microsecond \
    day_minute day_second dec decimal declare default delayed delete dense_rank desc \
    describe deterministic distinct distinctrow div double drop dual each else elseif empty \
    enclosed escaped except exists exit explain false fetch first_value float float4 float8 \
    for force foreign from fulltext function generated get grant group grouping groups \
    having high_priority hour_microsecond hour_minute hour_second if ignore in index infile \
    inner inout insensitive insert int int1 int2 int3 int4 int8 integer intersect interval \
    into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag \
    last_value lateral lead leading leave left like limit linear lines load localtime \
    localtimestamp lock long longblob longtext loop low_priority master_bind \
    master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint \
    minute_microsecond minute_second mod modifies natural no_write_to_binlog not nth_value \
    ntile null numeric of offset on optimize optimizer_costs option optionally or order out \
    outer outfile over partition percent_rank precision primary procedure purge range rank \
    read read_write reads real recursive references regexp release rename repeat replace \
    require resignal restrict return returning revoke right rlike row row_number rows \
    schema schemas second_microsecond select sensitive separator set show signal smallint \
    spatial specific sql sql_big_result sql_calc_found_rows sql_small_result sqlexception \
    sqlstate sqlwarning ssl starting stored straight_join system table terminated then \
    tinyblob tinyint tinytext to trailing trigger true undo union unique unlock unsigned \
    update usage use using utc_date utc_time utc_timestamp values varbinary varchar \
    varcharacter varying virtual when where while window with write xor year_month zerofill";

/// Whether `ident` must be quoted to mean itself: anything but a lowercase
/// letter or `_` followed by lowercase letters, digits and `_`, or a keyword.
pub fn needs_quoting(ident: &str) -> bool {
    let mut chars = ident.chars();
    let plain = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    !plain || KEYWORDS.binary_search(&ident).is_ok()
}

/// Quote a single SQL identifier for the given engine, only when it needs
/// it, so generated SQL reads as a person would write it (`public.wallet_tx`,
/// `"Order"`, `"user"`).
pub fn quote_ident(engine: EngineKind, ident: &str) -> String {
    let mysql_reserved = || {
        let lower = ident.to_ascii_lowercase();
        MYSQL_RESERVED.split_ascii_whitespace().any(|w| w == lower)
    };
    match engine {
        EngineKind::Mysql if needs_quoting(ident) || mysql_reserved() => {
            format!("`{}`", ident.replace('`', "``"))
        }
        EngineKind::Sqlite | EngineKind::Postgres if needs_quoting(ident) => {
            format!("\"{}\"", ident.replace('"', "\"\""))
        }
        _ => ident.to_string(),
    }
}

/// Qualified `schema.table` (or bare table for SQLite) for SQL generation.
pub fn qualified_table_sql(engine: EngineKind, schema: &str, table: &str) -> String {
    match engine {
        EngineKind::Sqlite => quote_ident(engine, table),
        // A MySQL schema is a database: `shop`.`orders`.
        EngineKind::Postgres | EngineKind::Mysql => format!(
            "{}.{}",
            quote_ident(engine, schema),
            quote_ident(engine, table)
        ),
    }
}

/// Build `SELECT * FROM …` for browsing a table with the connection's quoting rules.
pub fn table_browse_sql(engine: EngineKind, schema: &str, table: &str, limit: u32) -> String {
    table_browse_query(engine, schema, table, &BrowseOptions::first_page(limit))
}

/// One `ORDER BY` column of a table browse.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseOrder {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

/// What a table tab shows: an optional filter and sort, and the page of rows.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowseOptions {
    /// The columns to select, in order; empty selects `*`. A table tab with
    /// hidden columns names the rest explicitly.
    #[serde(default)]
    pub columns: Vec<String>,
    /// The body of a `WHERE`, as the user typed it. Wrapped in parentheses.
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub order: Vec<BrowseOrder>,
    /// Rows per page; 0 loads them all (no `LIMIT`).
    pub limit: u32,
    /// Rows already loaded: the next page starts here when it can't start
    /// `after` the last of them.
    #[serde(default)]
    pub offset: u32,
    /// The table's primary key (never NULL). With it pages are ordered by
    /// `order` then the key, and continue by keyset from `after`.
    #[serde(default)]
    pub key: Vec<String>,
    /// The last loaded row, by column name: the next page holds the rows
    /// that sort after it.
    #[serde(default)]
    pub after: Option<HashMap<String, Value>>,
}

impl BrowseOptions {
    pub fn first_page(limit: u32) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    /// What pages are ordered by: the chosen sort, then the key columns it
    /// leaves out, so every row has one place.
    pub fn page_order(&self) -> Vec<BrowseOrder> {
        let mut order = self.order.clone();
        for k in &self.key {
            if !order.iter().any(|o| &o.column == k) {
                order.push(BrowseOrder {
                    column: k.clone(),
                    desc: false,
                });
            }
        }
        order
    }

    /// Whether the next page continues by keyset (else `OFFSET`).
    pub fn pages_by_key(&self) -> bool {
        !self.key.is_empty()
    }
}

/// Whether `text` is the `<type name>` the Postgres driver shows for a
/// value it can't decode. The cell's type isn't sent back with the row, so
/// any text of that shape counts: a real value like `<b>` only costs the
/// keyset (the page falls back to OFFSET), never a wrong page.
fn is_type_placeholder(text: &str) -> bool {
    text.strip_prefix('<')
        .and_then(|t| t.strip_suffix('>'))
        .is_some_and(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '"' | '$'))
        })
}

/// `WHERE` terms for the rows after `after` in `order` (NULLS LAST): the
/// expanded chain `c1 ▷ v1 OR (c1 = v1 AND c2 ▷ v2) OR …`, or a row
/// comparison `(k1, k2) > (v1, v2)` when the order is only the key. `None`
/// when a value can't be written as a literal (bytes, NaN, a `<type name>`
/// placeholder): page by OFFSET.
fn keyset_predicate(
    engine: EngineKind,
    order: &[BrowseOrder],
    key: &[String],
    after: &HashMap<String, Value>,
) -> Option<String> {
    let mut cols = Vec::with_capacity(order.len());
    for o in order {
        let value = after.get(&o.column)?;
        let literal = match value {
            Value::Null => None,
            // A cell shown as `<type name>` (a type the core doesn't decode)
            // is no value to compare with.
            Value::Text(t) if is_type_placeholder(t) => return None,
            v => Some(sql_literal(engine, v)?),
        };
        let not_null = key.contains(&o.column);
        if not_null && literal.is_none() {
            return None;
        }
        cols.push((quote_ident(engine, &o.column), o.desc, literal, not_null));
    }
    // Only the key, all one way: one row comparison an index can range-scan.
    if cols.len() > 1 && cols.iter().all(|(_, desc, _, nn)| *nn && !*desc) {
        let names: Vec<&str> = cols.iter().map(|(c, ..)| c.as_str()).collect();
        let values: Vec<&str> = cols
            .iter()
            .filter_map(|(_, _, v, _)| v.as_deref())
            .collect();
        return Some(format!("({}) > ({})", names.join(", "), values.join(", ")));
    }
    let mut terms = Vec::new();
    for (i, (col, desc, value, not_null)) in cols.iter().enumerate() {
        // After a NULL (they sort last) comes nothing more in this column.
        let Some(v) = value else { continue };
        let op = if *desc { "<" } else { ">" };
        let after_v = if *not_null {
            format!("{col} {op} {v}")
        } else {
            format!("({col} {op} {v} OR {col} IS NULL)")
        };
        let mut parts: Vec<String> = cols[..i]
            .iter()
            .map(|(c, _, v, _)| match v {
                Some(v) => format!("{c} = {v}"),
                None => format!("{c} IS NULL"),
            })
            .collect();
        parts.push(after_v);
        terms.push(if parts.len() == 1 {
            parts.pop().unwrap_or_default()
        } else {
            format!("({})", parts.join(" AND "))
        });
    }
    if terms.is_empty() {
        return Some("FALSE".into());
    }
    Some(terms.join("\n   OR "))
}

/// `SELECT * FROM t [WHERE (…)] [ORDER BY …] [LIMIT n [OFFSET m]];` with the
/// connection's quoting rules (`SELECT a, b` when `columns` names them). The
/// filter text is inserted as typed. With a `key`, the order ends with it
/// (NULLS LAST) and a page given `after` starts past that row instead of
/// using OFFSET; when `after` lacks a sort or key column (it was not
/// selected), the page falls back to OFFSET.
pub fn table_browse_query(
    engine: EngineKind,
    schema: &str,
    table: &str,
    opts: &BrowseOptions,
) -> String {
    let from = qualified_table_sql(engine, schema, table);
    let list = if opts.columns.is_empty() {
        "*".to_string()
    } else {
        opts.columns
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut sql = format!("SELECT {list} FROM {from}");
    let order = opts.page_order();
    let keyset = match (&opts.after, opts.pages_by_key()) {
        (Some(after), true) => keyset_predicate(engine, &order, &opts.key, after),
        _ => None,
    };
    // A trailing `;` would end the statement inside the parentheses.
    let filter = opts.filter.as_deref().unwrap_or("").trim();
    let filter = filter.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    if !filter.is_empty() {
        // A `--` comment would swallow the closing parenthesis.
        let close = if filter.contains("--") { "\n)" } else { ")" };
        sql.push_str(&format!("\nWHERE ({filter}{close}"));
        if let Some(k) = &keyset {
            sql.push_str(&format!("\n  AND ({k})"));
        }
    } else if let Some(k) = &keyset {
        sql.push_str(&format!("\nWHERE {k}"));
    }
    if !order.is_empty() {
        let cols: Vec<String> = order
            .iter()
            .map(|o| {
                let name = quote_ident(engine, &o.column);
                let dir = if o.desc { " DESC" } else { "" };
                // Keyset pages put NULLs last whatever the engine's default.
                // MySQL has no NULLS LAST and sorts them first going up.
                let nulls_last = opts.pages_by_key() && !opts.key.contains(&o.column);
                match engine {
                    EngineKind::Mysql if nulls_last && !o.desc => {
                        format!("{name} IS NULL, {name}")
                    }
                    EngineKind::Mysql => format!("{name}{dir}"),
                    _ if nulls_last => format!("{name}{dir} NULLS LAST"),
                    _ => format!("{name}{dir}"),
                }
            })
            .collect();
        sql.push_str(&format!("\nORDER BY {}", cols.join(", ")));
    }
    if opts.limit > 0 {
        sql.push_str(&format!("\nLIMIT {}", opts.limit));
        if opts.offset > 0 && keyset.is_none() {
            sql.push_str(&format!(" OFFSET {}", opts.offset));
        }
    }
    sql.push(';');
    sql
}

/// `SELECT count(*)` over what a table tab shows: the same table and WHERE
/// as `table_browse_query`, no order, no limit (the SQL line's exact count).
pub fn table_count_query(
    engine: EngineKind,
    schema: &str,
    table: &str,
    filter: Option<&str>,
) -> String {
    let from = qualified_table_sql(engine, schema, table);
    let filter = filter.unwrap_or("").trim();
    let filter = filter.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    if filter.is_empty() {
        format!("SELECT count(*) FROM {from};")
    } else {
        let close = if filter.contains("--") { "\n)" } else { ")" };
        format!("SELECT count(*) FROM {from}\nWHERE ({filter}{close};")
    }
}

/// SQL for the schema table menu **SELECT LIMIT 100** (same as browse at limit 100).
pub fn table_select_limit_sql(engine: EngineKind, schema: &str, table: &str) -> String {
    table_browse_sql(engine, schema, table, 100)
}

impl SchemaCatalog {
    pub fn all_tables(&self) -> Vec<TableRef> {
        let mut out = Vec::new();
        for db in &self.databases {
            for schema in &db.schemas {
                for table in &schema.tables {
                    out.push(TableRef {
                        database: db.name.clone(),
                        schema: schema.name.clone(),
                        table: table.name.clone(),
                    });
                }
            }
        }
        out
    }

    pub fn find_table(&self, database: &str, schema: &str, table: &str) -> Option<&TableNode> {
        self.databases
            .iter()
            .find(|d| d.name == database)
            .and_then(|d| d.schemas.iter().find(|s| s.name == schema))
            .and_then(|s| s.tables.iter().find(|t| t.name == table))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TableRef {
    pub database: String,
    pub schema: String,
    pub table: String,
}

impl TableRef {
    pub fn palette_label(&self) -> String {
        if self.schema.is_empty() || self.schema == "main" {
            self.table.clone()
        } else {
            format!("{}.{}", self.schema, self.table)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn identifiers_are_quoted_only_when_needed() {
        assert!(
            KEYWORDS.windows(2).all(|w| w[0] < w[1]),
            "KEYWORDS must stay sorted"
        );
        let q = |s| quote_ident(EngineKind::Postgres, s);
        assert_eq!(q("wallet_tx"), "wallet_tx");
        assert_eq!(q("_tmp2"), "_tmp2");
        assert_eq!(q("Order"), "\"Order\"");
        assert_eq!(q("user"), "\"user\"");
        assert_eq!(q("order"), "\"order\"");
        assert_eq!(q("2fa"), "\"2fa\"");
        assert_eq!(q("first name"), "\"first name\"");
        assert_eq!(q("a\"b"), "\"a\"\"b\"");
        assert_eq!(q(""), "\"\"");
        assert_eq!(
            qualified_table_sql(EngineKind::Postgres, "public", "wallet_tx"),
            "public.wallet_tx"
        );
    }

    #[test]
    fn count_query_shares_the_browse_where() {
        assert_eq!(
            table_count_query(EngineKind::Postgres, "public", "wallet_tx", None),
            "SELECT count(*) FROM public.wallet_tx;"
        );
        assert_eq!(
            table_count_query(
                EngineKind::Postgres,
                "public",
                "wallet_tx",
                Some(" status = 'pending'; ")
            ),
            "SELECT count(*) FROM public.wallet_tx\nWHERE (status = 'pending');"
        );
        assert_eq!(
            table_count_query(EngineKind::Sqlite, "main", "t", Some("a = 1 -- note")),
            "SELECT count(*) FROM t\nWHERE (a = 1 -- note\n);"
        );
    }

    use super::*;

    #[test]
    fn comments_are_optional_on_the_wire() {
        // A catalog cached before comments existed still loads.
        let old = r#"{"name":"t","columns":[{"name":"id","type_name":"int8","nullable":false}],
            "primary_key":[],"indexes":[],"row_estimate":"Unknown"}"#;
        let table: TableNode = serde_json::from_str(old).expect("old table");
        assert!(table.comment.is_none() && table.columns[0].comment.is_none());
        // No comment: no key, so cached catalogs don't grow.
        let json = serde_json::to_string(&table).unwrap();
        assert!(!json.contains("comment"));
        let mut table = table;
        table.comment = Some("Ledger".into());
        table.columns[0].comment = Some("Key".into());
        let back: TableNode =
            serde_json::from_str(&serde_json::to_string(&table).unwrap()).unwrap();
        assert_eq!(back, table);
    }

    #[test]
    fn quote_ident_doubles_quotes() {
        assert_eq!(quote_ident(EngineKind::Postgres, "User"), "\"User\"");
        assert_eq!(
            quote_ident(EngineKind::Postgres, "weird\"name"),
            "\"weird\"\"name\""
        );
    }

    #[test]
    fn browse_sql_postgres() {
        let sql = table_browse_sql(EngineKind::Postgres, "public", "users", 100);
        assert_eq!(sql, "SELECT * FROM public.users\nLIMIT 100;");
    }

    #[test]
    fn select_limit_sql_postgres() {
        let sql = table_select_limit_sql(EngineKind::Postgres, "public", "users");
        assert_eq!(sql, "SELECT * FROM public.users\nLIMIT 100;");
    }

    #[test]
    fn browse_query_filter_order_page() {
        let opts = BrowseOptions {
            filter: Some(" status = 'pending'; ".into()),
            order: vec![BrowseOrder {
                column: "created_at".into(),
                desc: true,
            }],
            limit: 100,
            offset: 200,
            ..BrowseOptions::default()
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "orders", &opts),
            "SELECT * FROM public.orders\nWHERE (status = 'pending')\nORDER BY created_at DESC\nLIMIT 100 OFFSET 200;"
        );
    }

    #[test]
    fn browse_query_sqlite_and_edge_cases() {
        let opts = BrowseOptions {
            filter: Some("id > 3 -- recent".into()),
            order: vec![
                BrowseOrder {
                    column: "a\"b".into(),
                    desc: false,
                },
                BrowseOrder {
                    column: "id".into(),
                    desc: false,
                },
            ],
            limit: 50,
            offset: 0,
            ..BrowseOptions::default()
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "items", &opts),
            "SELECT * FROM items\nWHERE (id > 3 -- recent\n)\nORDER BY \"a\"\"b\", id\nLIMIT 50;"
        );
        // A blank filter adds no WHERE.
        let blank = BrowseOptions {
            filter: Some("  ;".into()),
            ..BrowseOptions::first_page(10)
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "items", &blank),
            "SELECT * FROM items\nLIMIT 10;"
        );
    }

    fn after(pairs: &[(&str, Value)]) -> Option<HashMap<String, Value>> {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn keyset_first_page_orders_by_key() {
        let opts = BrowseOptions {
            key: vec!["id".into()],
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts),
            "SELECT * FROM public.t\nORDER BY id\nLIMIT 1000;"
        );
    }

    #[test]
    fn keyset_next_page_by_key_skips_offset() {
        let opts = BrowseOptions {
            key: vec!["id".into()],
            offset: 1000,
            after: after(&[
                ("id", Value::Int(9_007_199_254_740_993)),
                ("name", Value::Text("x".into())),
            ]),
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts),
            "SELECT * FROM public.t\nWHERE id > 9007199254740993\nORDER BY id\nLIMIT 1000;"
        );
    }

    #[test]
    fn keyset_composite_key_is_a_row_comparison() {
        let opts = BrowseOptions {
            filter: Some("kind = 'a'".into()),
            key: vec!["tenant".into(), "id".into()],
            after: after(&[("tenant", Value::Text("o'k".into())), ("id", Value::Int(7))]),
            ..BrowseOptions::first_page(500)
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "t", &opts),
            "SELECT * FROM t\nWHERE (kind = 'a')\n  AND ((tenant, id) > ('o''k', 7))\nORDER BY tenant, id\nLIMIT 500;"
        );
    }

    #[test]
    fn keyset_mixed_directions_expand_with_null_tail() {
        let order = vec![
            BrowseOrder {
                column: "score".into(),
                desc: true,
            },
            BrowseOrder {
                column: "name".into(),
                desc: false,
            },
        ];
        let opts = BrowseOptions {
            order: order.clone(),
            key: vec!["id".into()],
            after: after(&[
                ("score", Value::Float(2.5)),
                ("name", Value::Text("b".into())),
                ("id", Value::Int(3)),
            ]),
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts),
            "SELECT * FROM public.t\nWHERE (score < '2.5' OR score IS NULL)\n   OR (score = '2.5' AND (name > 'b' OR name IS NULL))\n   OR (score = '2.5' AND name = 'b' AND id > 3)\nORDER BY score DESC NULLS LAST, name NULLS LAST, id\nLIMIT 1000;"
        );
        // The last row's sort value was NULL: only NULLs (by key) follow.
        let opts = BrowseOptions {
            order,
            key: vec!["id".into()],
            after: after(&[
                ("score", Value::Null),
                ("name", Value::Null),
                ("id", Value::Int(3)),
            ]),
            ..BrowseOptions::first_page(1000)
        };
        assert!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts)
                .contains("WHERE (score IS NULL AND name IS NULL AND id > 3)\n")
        );
    }

    #[test]
    fn keyset_falls_back_to_offset() {
        // A value with no literal (bytes) or a missing column: OFFSET.
        let opts = BrowseOptions {
            key: vec!["id".into()],
            offset: 1000,
            after: after(&[("id", Value::Bytes(vec![1]))]),
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts),
            "SELECT * FROM public.t\nORDER BY id\nLIMIT 1000 OFFSET 1000;"
        );
        // A sort value the driver showed as `<type name>` (it couldn't
        // decode it) is no literal: OFFSET, not `'<rev_st>'`.
        let opts = BrowseOptions {
            order: vec![BrowseOrder {
                column: "st".into(),
                desc: false,
            }],
            key: vec!["id".into()],
            offset: 50,
            after: after(&[
                ("st", Value::Text("<rev_st>".into())),
                ("id", Value::Int(7)),
            ]),
            ..BrowseOptions::first_page(50)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "t", &opts),
            "SELECT * FROM public.t\nORDER BY st NULLS LAST, id\nLIMIT 50 OFFSET 50;"
        );
        assert!(is_type_placeholder("<_text>"));
        assert!(is_type_placeholder("<public.geometry>"));
        assert!(!is_type_placeholder("<>"));
        assert!(!is_type_placeholder("<a b>"));
        assert!(!is_type_placeholder("plain"));
        // No key (no primary key): OFFSET, the sort as chosen.
        let opts = BrowseOptions {
            order: vec![BrowseOrder {
                column: "a".into(),
                desc: true,
            }],
            offset: 10,
            after: after(&[("a", Value::Int(1))]),
            ..BrowseOptions::first_page(10)
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "t", &opts),
            "SELECT * FROM t\nORDER BY a DESC\nLIMIT 10 OFFSET 10;"
        );
        // Page size All: no LIMIT.
        assert_eq!(
            table_browse_query(
                EngineKind::Sqlite,
                "main",
                "t",
                &BrowseOptions::first_page(0)
            ),
            "SELECT * FROM t;"
        );
    }

    #[test]
    fn browse_query_explicit_columns() {
        let opts = BrowseOptions {
            columns: vec![
                "id".into(),
                "wallet_id".into(),
                "Note".into(),
                "user".into(),
            ],
            key: vec!["id".into()],
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "wallet_tx", &opts),
            "SELECT id, wallet_id, \"Note\", \"user\" FROM public.wallet_tx\nORDER BY id\nLIMIT 1000;"
        );
        // Hidden columns can still sort; the next page continues by keyset
        // when the last row carries the sort and key columns.
        let opts = BrowseOptions {
            columns: vec!["id".into(), "amount".into()],
            order: vec![BrowseOrder {
                column: "amount".into(),
                desc: true,
            }],
            key: vec!["id".into()],
            after: after(&[("id", Value::Int(4)), ("amount", Value::Int(10))]),
            ..BrowseOptions::first_page(10)
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "t", &opts),
            "SELECT id, amount FROM t\nWHERE (amount < 10 OR amount IS NULL)\n   OR (amount = 10 AND id > 4)\nORDER BY amount DESC NULLS LAST, id\nLIMIT 10;"
        );
        // The key column is hidden: the last row can't place the page, so OFFSET.
        let opts = BrowseOptions {
            columns: vec!["amount".into()],
            key: vec!["id".into()],
            offset: 10,
            after: after(&[("amount", Value::Int(10))]),
            ..BrowseOptions::first_page(10)
        };
        assert_eq!(
            table_browse_query(EngineKind::Sqlite, "main", "t", &opts),
            "SELECT amount FROM t\nORDER BY id\nLIMIT 10 OFFSET 10;"
        );
    }

    #[test]
    fn browse_query_primary_and_secondary_sort() {
        let opts = BrowseOptions {
            order: vec![
                BrowseOrder {
                    column: "status".into(),
                    desc: false,
                },
                BrowseOrder {
                    column: "amount".into(),
                    desc: true,
                },
            ],
            key: vec!["id".into()],
            ..BrowseOptions::first_page(1000)
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "wallet_tx", &opts),
            "SELECT * FROM public.wallet_tx\nORDER BY status NULLS LAST, amount DESC NULLS LAST, id\nLIMIT 1000;"
        );
        // Without a key: the two keys as chosen, engine NULL order.
        let opts = BrowseOptions {
            key: vec![],
            ..opts
        };
        assert_eq!(
            table_browse_query(EngineKind::Postgres, "public", "wallet_tx", &opts),
            "SELECT * FROM public.wallet_tx\nORDER BY status, amount DESC\nLIMIT 1000;"
        );
    }

    #[test]
    fn browse_sql_sqlite() {
        let sql = table_browse_sql(EngineKind::Sqlite, "main", "items", 500);
        assert_eq!(sql, "SELECT * FROM items\nLIMIT 500;");
    }

    #[test]
    fn mysql_names_take_backticks() {
        let q = |name: &str| quote_ident(EngineKind::Mysql, name);
        assert_eq!(q("orders"), "orders");
        // Reserved in MySQL, not in Postgres.
        assert_eq!(q("rank"), "`rank`");
        assert_eq!(q("Key"), "`Key`");
        assert_eq!(q("Order"), "`Order`");
        assert_eq!(q("a`b"), "`a``b`");
        assert_eq!(quote_ident(EngineKind::Postgres, "rank"), "rank");
        assert_eq!(
            qualified_table_sql(EngineKind::Mysql, "shop", "order items"),
            "shop.`order items`"
        );
    }

    #[test]
    fn mysql_keyset_pages_put_nulls_last_without_nulls_last() {
        let mut opts = BrowseOptions::first_page(50);
        opts.key = vec!["id".into()];
        opts.order = vec![
            BrowseOrder {
                column: "rank".into(),
                desc: false,
            },
            BrowseOrder {
                column: "seen".into(),
                desc: true,
            },
        ];
        let sql = table_browse_query(EngineKind::Mysql, "shop", "t", &opts);
        assert_eq!(
            sql,
            "SELECT * FROM shop.t\nORDER BY `rank` IS NULL, `rank`, seen DESC, id\nLIMIT 50;"
        );
    }
}
