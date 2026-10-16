//! What a query run reports as it goes (`rowkery-bridge` hands these to an
//! `EventSink`: the webview's channel, or a queue in tests).

use crate::safety::SafetyHold;
use crate::RowBatch;

/// What a finished query knows beyond its counts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QueryDetail {
    /// From the start of the run to the first row; `None` without rows.
    pub first_row_ms: Option<u64>,
    /// The server's SQLSTATE when it refused the statement (`42P01`).
    pub sqlstate: Option<String>,
    /// 1-based character offset of the error in the statement.
    pub error_position: Option<u32>,
    /// The rows came from a cursor page (a query tab's free-form read).
    pub paged: bool,
    /// The cursor holds more rows: `fetch_more` continues it.
    pub more: bool,
    /// The run reached the most rows a tab holds and left the rest out.
    pub capped: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CoreEvent {
    QueryStarted {
        query_id: u64,
        tab_id: u64,
    },
    /// The run is waiting for a free connection (every one the saved
    /// connection may hold is busy), or, with `waiting` false, has one now.
    QueryWaiting {
        query_id: u64,
        tab_id: u64,
        waiting: bool,
    },
    QueryBatch {
        query_id: u64,
        tab_id: u64,
        batch: RowBatch,
        first: bool,
    },
    QueryFinished {
        query_id: u64,
        tab_id: u64,
        row_count: u64,
        rows_affected: Option<u64>,
        elapsed_ms: u64,
        error: Option<String>,
        cancelled: bool,
        detail: QueryDetail,
    },
    /// Safe mode stopped the query before it reached the database.
    QueryHeld {
        query_id: u64,
        tab_id: u64,
        hold: SafetyHold,
    },
}
