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

    /// What is running now; `transactions` from the pool, `None` when
    /// core can't say.
    pub fn now(&self, transactions: Option<usize>) -> BusyWork {
        BusyWork {
            unknown: transactions.is_none(),
            transactions: transactions.unwrap_or(0),
            writes: self.count(Work::Write),
            commits: self.count(Work::Commit),
            imports: self.count(Work::Import),
            sql_files: self.count(Work::SqlFile),
        }
    }
}

/// One running piece of work; it stops counting when dropped.
pub struct Held {
    busy: Arc<Busy>,
    work: Work,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.busy.0[self.work as usize].fetch_sub(1, Ordering::SeqCst);
    }
}

/// A write's events, passed on; it counts as running until it finishes.
pub(crate) struct HoldUntilFinished {
    pub inner: SharedSink,
    pub held: Mutex<Option<Held>>,
}

impl EventSink for HoldUntilFinished {
    fn push(&self, event: CoreEvent) {
        let ended = matches!(event, CoreEvent::QueryFinished { .. });
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
    /// Core didn't answer, so Rowkery can't tell what is running.
    pub unknown: bool,
    /// Query tabs that may hold the user's open transaction.
    pub transactions: usize,
    pub writes: usize,
    pub commits: usize,
    pub imports: usize,
    pub sql_files: usize,
}

impl BusyWork {
    pub fn is_idle(&self) -> bool {
        *self == Self::default()
    }

    /// The quit dialog's text, one line per kind of work and what quitting
    /// does to it; `None` when nothing would be lost.
    pub fn quit_warning(&self) -> Option<String> {
        let mut lines = Vec::new();
        if self.unknown {
            lines.push("Rowkery can't tell whether work is running.".to_string());
        }
        let mut say = |n: usize, one: &str, many: &str, then_one: &str, then_many: &str| match n {
            0 => {}
            1 => lines.push(format!("{one} {then_one}")),
            n => lines.push(format!("{n} {many} {then_many}")),
        };
        say(
            self.transactions,
            "A query tab has an open transaction.",
            "query tabs have open transactions.",
            "It is rolled back.",
            "They are rolled back.",
        );
        say(
            self.commits,
            "A commit of staged edits is running.",
            "commits of staged edits are running.",
            "It may or may not be saved.",
            "They may or may not be saved.",
        );
        say(
            self.writes,
            "A query tab is running a write.",
            "query tabs are running writes.",
            "It may still finish on the server.",
            "They may still finish on the server.",
        );
        say(
            self.imports,
            "A CSV import is running.",
            "CSV imports are running.",
            "It is rolled back.",
            "They are rolled back.",
        );
        say(
            self.sql_files,
            "A SQL file is running.",
            "SQL files are running.",
            "What it hasn't committed is rolled back.",
            "What they haven't committed is rolled back.",
        );
        (!lines.is_empty()).then(|| lines.join("\n"))
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
            transactions: 1,
            ..BusyWork::default()
        };
        assert_eq!(
            txn.quit_warning().as_deref(),
            Some("A query tab has an open transaction. It is rolled back.")
        );
        let more = BusyWork {
            transactions: 3,
            imports: 1,
            sql_files: 2,
            ..BusyWork::default()
        };
        assert!(!more.is_idle());
        assert_eq!(
            more.quit_warning().as_deref(),
            Some(
                "3 query tabs have open transactions. They are rolled back.\n\
                 A CSV import is running. It is rolled back.\n\
                 2 SQL files are running. What they haven't committed is rolled back."
            )
        );
    }

    #[test]
    fn not_knowing_says_so_instead_of_naming_a_transaction() {
        let busy = Busy::default();
        let work = busy.now(None);
        assert!(!work.is_idle());
        assert_eq!(work.transactions, 0);
        assert_eq!(
            work.quit_warning().as_deref(),
            Some("Rowkery can't tell whether work is running.")
        );
    }

    #[test]
    fn a_held_piece_of_work_counts_until_dropped() {
        let busy = Arc::new(Busy::default());
        let held = busy.hold(Work::Commit);
        let other = busy.hold(Work::Commit);
        assert_eq!(busy.now(Some(0)).commits, 2);
        drop(held);
        drop(other);
        assert!(busy.now(Some(0)).is_idle());
    }
}
