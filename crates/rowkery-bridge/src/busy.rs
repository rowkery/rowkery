//! Work a quit, or an Automatic update's restart, would cut short: a tab's
//! write, a commit of staged edits, a CSV import and a SQL file run are
//! counted while they run; an open transaction is the pool's to say.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rowkery_core::CoreEvent;
use serde::Serialize;

use crate::{EventSink, SharedSink};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Work {
    /// A query tab's statement that may write.
    Write,
    /// Staged row edits being committed.
    Commit,
    Import,
    SqlFile,
}

/// How many of each [`Work`] are running.
#[derive(Default)]
pub(crate) struct Busy([AtomicUsize; 4]);

impl Busy {
    /// Counts `work` as running until the returned guard is dropped.
    pub fn hold(self: &Arc<Self>, work: Work) -> Held {
        self.0[work as usize].fetch_add(1, Ordering::SeqCst);
        Held {
            busy: self.clone(),
            work,
        }
    }

    fn count(&self, work: Work) -> usize {
        self.0[work as usize].load(Ordering::SeqCst)
    }

    /// What is running now; `transaction` from the pool.
    pub fn now(&self, transaction: bool) -> BusyWork {
        BusyWork {
            transaction,
            writes: self.count(Work::Write),
            commits: self.count(Work::Commit),
            imports: self.count(Work::Import),
            sql_files: self.count(Work::SqlFile),
        }
    }
}

/// One running piece of work; it stops counting when dropped.
pub(crate) struct Held {
    busy: Arc<Busy>,
    work: Work,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.busy.0[self.work as usize].fetch_sub(1, Ordering::SeqCst);
    }
}

/// A write's events, passed on; it counts as running until it finishes (or
/// safe mode holds it).
pub(crate) struct HoldUntilFinished {
    pub inner: SharedSink,
    pub held: Mutex<Option<Held>>,
}

impl EventSink for HoldUntilFinished {
    fn push(&self, event: CoreEvent) {
        let ended = matches!(
            event,
            CoreEvent::QueryFinished { .. } | CoreEvent::QueryHeld { .. }
        );
        self.inner.push(event);
        if ended {
            if let Ok(mut held) = self.held.lock() {
                held.take();
            }
        }
    }
}

/// What quitting now would cut short.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BusyWork {
    /// A query tab may hold the user's open transaction.
    pub transaction: bool,
    pub writes: usize,
    pub commits: usize,
    pub imports: usize,
    pub sql_files: usize,
}

impl BusyWork {
    pub fn is_idle(&self) -> bool {
        *self == Self::default()
    }

    /// The quit dialog's text, naming what would be lost; `None` when
    /// nothing would be.
    pub fn quit_warning(&self) -> Option<String> {
        let mut lost = Vec::new();
        if self.transaction {
            lost.push("a query tab's open transaction (rolled back)".to_string());
        }
        let mut say = |n: usize, one: &str, many: &str, what: &str| match n {
            0 => {}
            1 => lost.push(format!("{one} ({what})")),
            n => lost.push(format!("{n} {many} ({what})")),
        };
        say(
            self.commits,
            "a commit of staged edits",
            "commits of staged edits",
            "may or may not be saved",
        );
        say(
            self.writes,
            "a running write",
            "running writes",
            "may still finish on the server",
        );
        say(self.imports, "a CSV import", "CSV imports", "rolled back");
        say(
            self.sql_files,
            "a SQL file run",
            "SQL file runs",
            "what isn't committed yet is rolled back",
        );
        match lost.as_slice() {
            [] => None,
            [one] => Some(format!("Quitting now ends {one}.")),
            [rest @ .., last] => Some(format!("Quitting now ends {} and {last}.", rest.join(", "))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_running_says_nothing() {
        assert!(BusyWork::default().is_idle());
        assert_eq!(BusyWork::default().quit_warning(), None);
    }

    #[test]
    fn the_warning_names_what_would_be_lost() {
        let txn = BusyWork {
            transaction: true,
            ..BusyWork::default()
        };
        assert_eq!(
            txn.quit_warning().as_deref(),
            Some("Quitting now ends a query tab's open transaction (rolled back).")
        );
        let more = BusyWork {
            transaction: true,
            imports: 1,
            sql_files: 2,
            ..BusyWork::default()
        };
        assert!(!more.is_idle());
        assert_eq!(
            more.quit_warning().as_deref(),
            Some(
                "Quitting now ends a query tab's open transaction (rolled back), \
                 a CSV import (rolled back) and 2 SQL file runs (what isn't \
                 committed yet is rolled back)."
            )
        );
    }

    #[test]
    fn a_held_piece_of_work_counts_until_dropped() {
        let busy = Arc::new(Busy::default());
        let held = busy.hold(Work::Commit);
        let other = busy.hold(Work::Commit);
        assert_eq!(busy.now(false).commits, 2);
        drop(held);
        drop(other);
        assert!(busy.now(false).is_idle());
    }
}
