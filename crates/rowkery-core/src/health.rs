//! Database health: what will hurt soon, read from the server's catalog and
//! statistics (Postgres) or the file's own pages (SQLite), for the Health
//! tab and the agents' `health` tool.
//!
//! Postgres checks read the catalog and statistics only, never a table's
//! rows, so a report costs milliseconds on any size of database. SQLite
//! walks the file's pages for sizes, and only while the file is small. Nothing here changes the database:
//! a finding carries the SQL that fixes it, for the user to open in a query
//! tab, where safe mode applies.

use serde::{Deserialize, Serialize};

/// One read of a database's health.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HealthReport {
    pub database: String,
    /// `Postgres 16.4`, `SQLite 3.46.0`.
    pub server: String,
    pub size: Option<SizeTile>,
    /// Share of block reads served from memory, 0 to 1.
    pub cache_hit: Option<f64>,
    pub connections: Option<ConnectionsTile>,
    /// When the server's usage statistics began (Unix seconds); `None` when
    /// they were never reset, or the engine keeps none.
    pub stats_since: Option<i64>,
    /// The oldest unfrozen transaction, as a share of the wraparound limit.
    pub transaction_age: Option<f64>,
    pub checks: Vec<HealthCheck>,
    pub slow_queries: SlowQueries,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SizeTile {
    pub total_bytes: i64,
    /// `None` when the split isn't known (a large SQLite file).
    pub table_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionsTile {
    pub used: i64,
    pub max: i64,
    /// Running a statement now (of the sessions this login can see).
    pub active: i64,
}

/// What a check looks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    IdsRunningOut,
    TransactionAge,
    ReplicationSlots,
    UnusedIndexes,
    DuplicateIndexes,
    ForeignKeysWithoutIndex,
    DeadRows,
    NeverAnalyzed,
    LongTransactions,
    FreePages,
}

/// How a finding should be read: `Soon` breaks something on its own if
/// left; the rest cost speed or space.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Soon,
    Waste,
    Slow,
    Upkeep,
    Tidy,
}

impl CheckKind {
    pub fn severity(self) -> Severity {
        match self {
            Self::IdsRunningOut | Self::TransactionAge | Self::ReplicationSlots => Severity::Soon,
            Self::UnusedIndexes | Self::FreePages => Severity::Waste,
            Self::ForeignKeysWithoutIndex => Severity::Slow,
            Self::DeadRows | Self::NeverAnalyzed | Self::LongTransactions => Severity::Upkeep,
            Self::DuplicateIndexes => Severity::Tidy,
        }
    }

    /// How far to trust what the check finds.
    pub fn trust(self, sqlite: bool) -> &'static str {
        match self {
            Self::IdsRunningOut => "The date assumes inserts keep the pace seen since the statistics were last reset. Without a reset time (Postgres 15 and later keep none until a reset), there is no date.",
            Self::TransactionAge => "Exact, from the catalog.",
            Self::ReplicationSlots => "Exact. A slot is inactive while its replica or consumer is disconnected, so it may still come back.",
            Self::UnusedIndexes => "Usage counts come from this server only. An index used only on a read replica, or by a job that hasn't run since the statistics began, looks unused here.",
            Self::DuplicateIndexes => "Compares key columns, their order, operator classes and collations. Keep whichever index a constraint or your code names.",
            Self::ForeignKeysWithoutIndex if sqlite => "The row count is estimated from the file's pages.",
            Self::ForeignKeysWithoutIndex => "The row count is the planner's estimate.",
            Self::DeadRows => "Row counts are estimates kept by the statistics collector.",
            Self::NeverAnalyzed if sqlite => "Only tables with an index are listed: without one, the planner has nothing to choose.",
            Self::NeverAnalyzed => "The row count is an estimate kept by the statistics collector.",
            Self::LongTransactions => "Read at the moment of the check; it may have finished since.",
            Self::FreePages => "Exact, from the file header.",
        }
    }
}

/// One check's outcome.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HealthCheck {
    pub check: CheckKind,
    pub severity: Severity,
    pub trust: String,
    #[serde(flatten)]
    pub state: CheckState,
}

impl HealthCheck {
    pub fn new(check: CheckKind, sqlite: bool, state: CheckState) -> Self {
        Self {
            check,
            severity: check.severity(),
            trust: check.trust(sqlite).to_string(),
            state,
        }
    }

    /// Fine when nothing was found, Found otherwise.
    pub fn of(check: CheckKind, sqlite: bool, items: Vec<HealthItem>) -> Self {
        let state = if items.is_empty() {
            CheckState::Fine
        } else {
            CheckState::Found { items }
        };
        Self::new(check, sqlite, state)
    }

    pub fn items(&self) -> &[HealthItem] {
        match &self.state {
            CheckState::Found { items } => items,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CheckState {
    Fine,
    Found {
        items: Vec<HealthItem>,
    },
    /// The login may not see what the check reads; `role` would let it.
    NeedsRole {
        role: String,
    },
    /// The check failed for another reason (an old server, a lost view).
    Unavailable {
        message: String,
    },
}

/// One thing a check found.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HealthItem {
    pub schema: Option<String>,
    pub table: Option<String>,
    /// The index, column, slot or session it is about, when not the table.
    pub name: Option<String>,
    /// What it weighs on disk, when that is the point.
    pub bytes: Option<i64>,
    pub detail: Detail,
    /// SQL that fixes it, to open in a query tab. Never run by Health.
    pub fix: Option<String>,
}

/// A finding's numbers, by check.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Detail {
    IdsRunningOut {
        type_name: String,
        used: i64,
        max: i64,
        /// At the pace seen since the statistics began; `None` without one.
        days_left: Option<f64>,
    },
    TransactionAge {
        age: i64,
        limit: i64,
    },
    ReplicationSlot {
        slot_type: String,
        /// WAL the slot keeps on disk.
        wal_bytes: i64,
    },
    UnusedIndex,
    DuplicateIndex {
        /// The index that already covers it.
        covered_by: String,
    },
    ForeignKeyWithoutIndex {
        constraint: String,
        columns: Vec<String>,
        /// The parent table's schema (`None` on SQLite) and name, apart so
        /// a name with a dot in it reads one way.
        parent_schema: Option<String>,
        parent_table: String,
        /// `None` when only "over the limit" is known (a large SQLite file).
        rows: Option<i64>,
    },
    DeadRows {
        dead: i64,
        live: i64,
        /// Since the last vacuum of either kind; `None` when never.
        vacuumed_secs_ago: Option<f64>,
    },
    NeverAnalyzed {
        rows: Option<i64>,
    },
    LongTransaction {
        pid: i32,
        user: Option<String>,
        idle_secs: f64,
        xact_secs: Option<f64>,
    },
    FreePages {
        free_bytes: i64,
        file_bytes: i64,
    },
}

/// The queries the server spends its time on (Postgres `pg_stat_statements`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SlowQueries {
    Ranked {
        queries: Vec<SlowQuery>,
        /// Other logins' queries were left out: the login can't see them.
        partial: bool,
    },
    /// `pg_stat_statements` is off: not created in this database
    /// (`CREATE EXTENSION`), or not loaded by the server
    /// (`shared_preload_libraries`).
    Off {
        loaded: bool,
    },
    NeedsRole {
        role: String,
    },
    Unavailable {
        message: String,
    },
    /// The engine keeps no query statistics (SQLite).
    None,
}

/// A query as `pg_stat_statements` keeps it: constants already replaced by
/// `$1`, `$2`, ….
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlowQuery {
    pub query: String,
    pub user: Option<String>,
    pub calls: i64,
    pub total_ms: f64,
    pub mean_ms: f64,
    pub rows: i64,
    /// Share of the database's total query time, 0 to 1.
    pub share: f64,
}

/// The role that lets a login see every session and query statistic.
pub const MONITOR_ROLE: &str = "pg_monitor";

/// Thresholds the plan settled on; the Health docs page lists them.
pub mod limits {
    /// An id's sequence past this share of its column's range.
    pub const IDS_USED: f64 = 0.7;
    /// Transaction age past this share of the wraparound limit.
    pub const XACT_AGE: f64 = 0.5;
    /// Postgres refuses writes near 2^31 transactions of age.
    pub const XACT_LIMIT: i64 = 2_147_483_647;
    /// WAL an inactive replication slot may hold.
    pub const SLOT_WAL_BYTES: i64 = 1 << 30;
    /// Smallest index worth calling unused.
    pub const UNUSED_INDEX_BYTES: i64 = 10 << 20;
    /// Smallest table for foreign key, dead row and analyze checks.
    pub const ROWS: i64 = 10_000;
    /// Dead rows past this share of the table.
    pub const DEAD_SHARE: f64 = 0.2;
    /// A vacuum longer ago than this.
    pub const VACUUM_DAYS: i64 = 7;
    /// Idle in a transaction longer than this.
    pub const IDLE_XACT_SECS: i64 = 300;
    /// Free pages past this share of the file, and at least
    /// [`FREE_BYTES`].
    pub const FREE_SHARE: f64 = 0.1;
    pub const FREE_BYTES: i64 = 1 << 20;
    /// Largest SQLite file whose pages are walked for sizes.
    pub const SQLITE_WALK_BYTES: i64 = 1 << 30;
    /// Slowest queries listed.
    pub const SLOW_QUERIES: i64 = 10;
}

/// Days until a sequence runs out at `inserts` rows over `secs` seconds.
pub fn days_left(used: i64, max: i64, inserts: i64, secs: f64) -> Option<f64> {
    if inserts <= 0 || secs < 3600.0 {
        return None;
    }
    let per_sec = inserts as f64 / secs;
    Some((max - used).max(0) as f64 / per_sec / 86_400.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_left_needs_a_pace() {
        assert_eq!(days_left(70, 100, 0, 86_400.0), None);
        assert_eq!(days_left(70, 100, 10, 60.0), None);
        // 10 a day, 30 to go.
        assert_eq!(days_left(70, 100, 10, 86_400.0), Some(3.0));
        assert_eq!(days_left(120, 100, 10, 86_400.0), Some(0.0));
    }

    #[test]
    fn checks_serialize_flat() {
        let check = HealthCheck::of(
            CheckKind::UnusedIndexes,
            false,
            vec![HealthItem {
                schema: Some("public".into()),
                table: Some("orders".into()),
                name: Some("orders_note_idx".into()),
                bytes: Some(12 << 20),
                detail: Detail::UnusedIndex,
                fix: Some("DROP INDEX CONCURRENTLY public.orders_note_idx".into()),
            }],
        );
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["check"], "unused_indexes");
        assert_eq!(json["severity"], "waste");
        assert_eq!(json["state"], "found");
        assert_eq!(json["items"][0]["detail"]["kind"], "unused_index");
        let fine = HealthCheck::of(CheckKind::DeadRows, false, Vec::new());
        assert_eq!(serde_json::to_value(&fine).unwrap()["state"], "fine");
    }
}
