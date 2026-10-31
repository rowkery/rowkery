//! The session's `TimeZone`, followed as the server reports it (at login and
//! after every `SET TIME ZONE`), so `timestamptz` shows in it as psql shows it.

use std::sync::{Arc, Mutex};

use jiff::tz::TimeZone;

/// Microseconds from the Unix epoch to Postgres's (2000-01-01).
const PG_EPOCH_MICROS: i64 = 946_684_800_000_000;

/// Shared by a session and the task driving its connection.
#[derive(Clone, Default)]
pub(super) struct SessionZone(Arc<Mutex<Followed>>);

#[derive(Default)]
struct Followed {
    /// As the server last reported it.
    name: String,
    /// `None` when the name isn't one we can resolve (`localtime`: the
    /// server's own zone): timestamptz then shows in UTC, as `+00`.
    zone: Option<TimeZone>,
}

impl SessionZone {
    /// Called with the connection's `TimeZone` after each poll.
    pub(super) fn follow(&self, reported: Option<&str>) {
        let Some(name) = reported else { return };
        let Ok(mut followed) = self.0.lock() else {
            return;
        };
        if followed.name != name {
            followed.zone = resolve(name);
            followed.name = name.to_string();
        }
    }

    /// The zone for the rows about to be decoded.
    pub(super) fn current(&self) -> Option<TimeZone> {
        self.0.lock().ok().and_then(|f| f.zone.clone())
    }
}

/// A `TimeZone` as Postgres reports it: a tz database name (`Asia/Kolkata`,
/// `EST5EDT`), a POSIX rule (`<+05:30>-05:30`, `UTC+3`), or a bare offset
/// (`+05:30`, which Postgres reads the POSIX way: west of Greenwich).
fn resolve(name: &str) -> Option<TimeZone> {
    // The server's own local zone, which this machine can't know.
    if name.eq_ignore_ascii_case("localtime") {
        return None;
    }
    if let Ok(zone) = jiff::tz::db().get(name) {
        return Some(zone);
    }
    // Postgres writes `:` inside a `<…>` label, which a POSIX rule can't
    // hold; the label is only a name, so it goes.
    let mut rule = String::with_capacity(name.len() + 2);
    let mut in_label = false;
    for c in name.chars() {
        match c {
            '<' => in_label = true,
            '>' => in_label = false,
            ':' if in_label => continue,
            _ => {}
        }
        rule.push(c);
    }
    if name.starts_with(['+', '-']) || name.starts_with(|c: char| c.is_ascii_digit()) {
        rule = format!("<{}>{name}", name.replace(':', ""));
    }
    TimeZone::posix(&rule).ok()
}

/// A timestamptz's microseconds (UTC, from 2000-01-01) as local
/// microseconds in `zone` and the offset Postgres writes after them
/// (`+05:30`, `-05`, `+05:53:28`). `None` outside the years the zone rules
/// cover, where the value stays in UTC.
pub(super) fn localize(utc_micros: i64, zone: &TimeZone) -> Option<(i64, String)> {
    let at = jiff::Timestamp::from_microsecond(utc_micros.checked_add(PG_EPOCH_MICROS)?).ok()?;
    let seconds = i64::from(zone.to_offset(at).seconds());
    let local = utc_micros.checked_add(seconds * 1_000_000)?;
    let (sign, abs) = if seconds < 0 {
        ('-', -seconds)
    } else {
        ('+', seconds)
    };
    let (h, m, s) = (abs / 3600, (abs / 60) % 60, abs % 60);
    let offset = match (m, s) {
        (0, 0) => format!("{sign}{h:02}"),
        (_, 0) => format!("{sign}{h:02}:{m:02}"),
        _ => format!("{sign}{h:02}:{m:02}:{s:02}"),
    };
    Some((local, offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-01-15 12:00:00 UTC, from 2000-01-01.
    const JAN: i64 = 821_793_600_000_000;

    #[test]
    fn offsets_read_as_postgres_writes_them() {
        let at = |name: &str| {
            let zone = resolve(name).unwrap_or_else(|| panic!("{name}"));
            localize(JAN, &zone).unwrap().1
        };
        assert_eq!(at("Asia/Kolkata"), "+05:30");
        assert_eq!(at("America/New_York"), "-05");
        assert_eq!(at("Etc/UTC"), "+00");
        assert_eq!(at("<+05:30>-05:30"), "+05:30");
        assert_eq!(at("UTC+3"), "-03");
        // A bare offset is POSIX: west of Greenwich.
        assert_eq!(at("+05:30"), "-05:30");
        assert!(resolve("localtime").is_none());
    }

    #[test]
    fn local_time_moves_by_the_offset() {
        let zone = resolve("Asia/Kolkata").unwrap();
        let (local, _) = localize(JAN, &zone).unwrap();
        assert_eq!(local - JAN, (5 * 3600 + 30 * 60) * 1_000_000);
        assert!(localize(i64::MAX - 1, &zone).is_none());
    }
}
