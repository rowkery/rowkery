//! Binary wire values of the types tokio-postgres has no conversion for
//! without optional crates, written the way Postgres's own text output
//! writes them (with its default `IntervalStyle` and a C or English
//! `lc_monetary`), so a cell shows, copies and edits as psql would show it.

use super::format_time_of_day;

/// `interval`: microseconds, days, months, each kept apart as Postgres does.
pub(super) fn interval(b: &[u8]) -> Option<String> {
    let time = i64::from_be_bytes(b.get(0..8)?.try_into().ok()?);
    let days = i32::from_be_bytes(b.get(8..12)?.try_into().ok()?);
    let months = i32::from_be_bytes(b.get(12..16)?.try_into().ok()?);
    if b.len() != 16 {
        return None;
    }
    match (time, days, months) {
        (i64::MAX, i32::MAX, i32::MAX) => return Some("infinity".into()),
        (i64::MIN, i32::MIN, i32::MIN) => return Some("-infinity".into()),
        _ => {}
    }
    let mut out = String::new();
    // After a negative part, a positive one says so (`-3 days +04:00:00`).
    let mut before = false;
    let mut part = |value: i64, unit: &str| {
        if value == 0 {
            return;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        let plus = if before && value > 0 { "+" } else { "" };
        let plural = if value != 1 { "s" } else { "" };
        out.push_str(&format!("{plus}{value} {unit}{plural}"));
        before = value < 0;
    };
    part((months / 12) as i64, "year");
    part((months % 12) as i64, "mon");
    part(days as i64, "day");
    if out.is_empty() || time != 0 {
        let sign = if time < 0 {
            "-"
        } else if before {
            "+"
        } else {
            ""
        };
        let space = if out.is_empty() { "" } else { " " };
        // Hours run past 24: an interval's time is not a time of day.
        let abs = time.unsigned_abs();
        let hours = abs / 3_600_000_000;
        let rest = format_time_of_day((abs % 3_600_000_000) as i64);
        out.push_str(&format!("{space}{sign}{hours:02}{}", &rest[2..]));
    }
    Some(out)
}

/// `inet` and `cidr`: family, prefix bits, whether it is a cidr, address
/// length, then the address. An inet shows its prefix only when it isn't
/// the whole address; a cidr always does.
pub(super) fn inet(b: &[u8]) -> Option<String> {
    let [family, bits, is_cidr, len, address @ ..] = b else {
        return None;
    };
    let address = match (*family, *len as usize, address.len()) {
        (2, 4, 4) => format!(
            "{}.{}.{}.{}",
            address[0], address[1], address[2], address[3]
        ),
        (3, 16, 16) => ipv6(address.try_into().ok()?),
        _ => return None,
    };
    let full = if *family == 2 { 32 } else { 128 };
    Some(if *is_cidr != 0 || *bits != full {
        format!("{address}/{bits}")
    } else {
        address
    })
}

/// An IPv6 address as Postgres writes it: the longest run of two or more
/// zero groups as `::`, and the last four bytes in dotted form after `::`
/// or `::ffff:` (but `::1` stays `::1`).
fn ipv6(bytes: [u8; 16]) -> String {
    let words: Vec<u16> = bytes
        .chunks(2)
        .map(|w| u16::from_be_bytes([w[0], w[1]]))
        .collect();
    let (mut best, mut run) = ((0usize, 0usize), (0usize, 0usize));
    for (i, w) in words.iter().enumerate() {
        if *w == 0 {
            if run.1 == 0 {
                run.0 = i;
            }
            run.1 += 1;
            if run.1 > best.1 {
                best = run;
            }
        } else {
            run.1 = 0;
        }
    }
    let (base, len) = if best.1 >= 2 { best } else { (usize::MAX, 0) };
    let mut out = String::new();
    let mut i = 0;
    while i < 8 {
        if i == base {
            out.push(':');
            if base + len == 8 {
                out.push(':');
            }
            i += len;
            continue;
        }
        if i != 0 {
            out.push(':');
        }
        let ipv4_tail = i == 6
            && base == 0
            && (len == 6 || (len == 7 && words[7] != 1) || (len == 5 && words[5] == 0xffff));
        if ipv4_tail {
            out.push_str(&format!(
                "{}.{}.{}.{}",
                bytes[12], bytes[13], bytes[14], bytes[15]
            ));
            break;
        }
        out.push_str(&format!("{:x}", words[i]));
        i += 1;
    }
    out
}

/// `macaddr` and `macaddr8`: the bytes as lower-case hex pairs.
pub(super) fn macaddr(b: &[u8]) -> Option<String> {
    if b.len() != 6 && b.len() != 8 {
        return None;
    }
    Some(
        b.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// `money`: cents as an int8, written `-$1,234.50`.
pub(super) fn money(b: &[u8]) -> Option<String> {
    let cents = i64::from_be_bytes(b.try_into().ok()?);
    let abs = cents.unsigned_abs();
    let whole = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let sign = if cents < 0 { "-" } else { "" };
    Some(format!("{sign}${grouped}.{:02}", abs % 100))
}

/// `bit` and `varbit`: the length in bits, then the bits, high first.
pub(super) fn bits(b: &[u8]) -> Option<String> {
    let len = usize::try_from(i32::from_be_bytes(b.get(0..4)?.try_into().ok()?)).ok()?;
    let data = &b[4..];
    if data.len() != len.div_ceil(8) {
        return None;
    }
    Some(
        (0..len)
            .map(|i| {
                if data[i / 8] & (0x80 >> (i % 8)) != 0 {
                    '1'
                } else {
                    '0'
                }
            })
            .collect(),
    )
}

/// `timetz`: the time of day, then the zone as seconds west of UTC,
/// written as an offset east (`+05:30`).
pub(super) fn timetz(b: &[u8]) -> Option<String> {
    if b.len() != 12 {
        return None;
    }
    let time = i64::from_be_bytes(b[0..8].try_into().ok()?);
    let west = i32::from_be_bytes(b[8..12].try_into().ok()?);
    let sign = if west > 0 { '-' } else { '+' };
    let east = west.unsigned_abs();
    let (h, m, s) = (east / 3600, east / 60 % 60, east % 60);
    let mut zone = format!("{sign}{h:02}");
    if m != 0 || s != 0 {
        zone.push_str(&format!(":{m:02}"));
    }
    if s != 0 {
        zone.push_str(&format!(":{s:02}"));
    }
    Some(format!("{}{zone}", format_time_of_day(time)))
}

/// `"char"`: one byte, written as itself, or as `\ooo` past ASCII.
pub(super) fn char(b: &[u8]) -> Option<String> {
    match b {
        [] => Some(String::new()),
        [byte] if byte.is_ascii() => Some((*byte as char).to_string()),
        [byte] => Some(format!("\\{byte:03o}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interval_of(time: i64, days: i32, months: i32) -> String {
        let mut b = time.to_be_bytes().to_vec();
        b.extend(days.to_be_bytes());
        b.extend(months.to_be_bytes());
        interval(&b).expect("interval")
    }

    #[test]
    fn intervals_read_as_postgres_writes_them() {
        assert_eq!(interval_of(0, 0, 0), "00:00:00");
        assert_eq!(
            interval_of(14_706_500_000, -3, 14),
            "1 year 2 mons -3 days +04:05:06.5"
        );
        assert_eq!(interval_of(0, -1, 0), "-1 days");
        assert_eq!(interval_of(-14_400_000_000, 0, 0), "-04:00:00");
        assert_eq!(interval_of(-1_000_000, 1, 0), "1 day -00:00:01");
        assert_eq!(interval_of(360_000_000_000, 0, 0), "100:00:00");
        assert_eq!(interval_of(0, 0, -1), "-1 mons");
        assert_eq!(interval_of(i64::MAX, i32::MAX, i32::MAX), "infinity");
    }

    fn inet_of(family: u8, bits: u8, cidr: bool, address: &[u8]) -> String {
        let mut b = vec![family, bits, cidr as u8, address.len() as u8];
        b.extend(address);
        inet(&b).expect("inet")
    }

    #[test]
    fn addresses_read_as_postgres_writes_them() {
        assert_eq!(inet_of(2, 32, false, &[10, 1, 2, 3]), "10.1.2.3");
        assert_eq!(inet_of(2, 8, true, &[10, 0, 0, 0]), "10.0.0.0/8");
        let v6 =
            |words: [u16; 8]| -> Vec<u8> { words.iter().flat_map(|w| w.to_be_bytes()).collect() };
        let mapped = v6([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
        assert_eq!(inet_of(3, 128, false, &mapped), "::ffff:1.2.3.4");
        assert_eq!(
            inet_of(3, 128, false, &v6([0, 0, 0, 0, 0, 0, 0x0102, 0x0304])),
            "::1.2.3.4"
        );
        assert_eq!(inet_of(3, 128, false, &v6([0, 0, 0, 0, 0, 0, 0, 1])), "::1");
        assert_eq!(
            inet_of(3, 64, false, &v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])),
            "2001:db8::1/64"
        );
        assert_eq!(
            inet_of(3, 128, false, &v6([1, 0, 0, 1, 0, 0, 0, 1])),
            "1:0:0:1::1"
        );
        assert_eq!(
            inet_of(3, 128, false, &v6([0, 0, 1, 0, 0, 0, 0, 0])),
            "0:0:1::"
        );
    }

    #[test]
    fn money_bits_zones_and_chars() {
        assert_eq!(money(&(-123_450i64).to_be_bytes()).unwrap(), "-$1,234.50");
        assert_eq!(
            money(&123_456_789i64.to_be_bytes()).unwrap(),
            "$1,234,567.89"
        );
        assert_eq!(money(&0i64.to_be_bytes()).unwrap(), "$0.00");
        assert_eq!(bits(&[0, 0, 0, 4, 0b0101_0000]).unwrap(), "0101");
        let mut tz = 43_200_000_000i64.to_be_bytes().to_vec();
        tz.extend((-19_800i32).to_be_bytes());
        assert_eq!(timetz(&tz).unwrap(), "12:00:00+05:30");
        assert_eq!(
            macaddr(&[8, 0, 0x2b, 1, 2, 3]).unwrap(),
            "08:00:2b:01:02:03"
        );
        assert_eq!(char(b"a").unwrap(), "a");
    }
}
