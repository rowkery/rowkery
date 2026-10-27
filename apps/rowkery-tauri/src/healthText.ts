import type { HealthCheck, HealthCheckKind, HealthItem, HealthReport, HealthSeverity } from "./api";
import { formatAge } from "./sessionRows";
import { formatBytes, formatRowCount } from "./types";

/**
 * The Health tab's words: a finding's one-line title and the line under it,
 * what each check means and what "fine" reads as. Kept apart from the view
 * so the copy is tested without a DOM.
 */

/** The order findings are listed in: what breaks first, then cost. */
export const SEVERITY_ORDER: HealthSeverity[] = ["soon", "waste", "slow", "upkeep", "tidy"];

export const SEVERITY_LABEL: Record<HealthSeverity, string> = {
  soon: "Soon",
  waste: "Waste",
  slow: "Slow",
  upkeep: "Upkeep",
  tidy: "Tidy",
};

/** The tag's tooltip: what the word means. */
export const SEVERITY_HINT: Record<HealthSeverity, string> = {
  soon: "Will break if nothing changes",
  waste: "Costs disk and writes",
  slow: "Makes queries slower",
  upkeep: "Maintenance is behind",
  tidy: "Worth cleaning up",
};

/** What a check is called where it couldn't run ("Slowest queries need pg_monitor"). */
export const CHECK_NAME: Record<HealthCheckKind, string> = {
  ids_running_out: "IDs running out",
  transaction_age: "Transaction age",
  replication_slots: "Replication slots",
  unused_indexes: "Unused indexes",
  duplicate_indexes: "Repeated indexes",
  foreign_keys_without_index: "Foreign keys without an index",
  dead_rows: "Dead rows",
  never_analyzed: "Never analyzed",
  long_transactions: "Idle transactions",
  free_pages: "Free pages",
};

/** Within a severity, the order the plan lists the checks in. */
const CHECK_ORDER = Object.keys(CHECK_NAME) as HealthCheckKind[];

/** Why it matters, in the inspector. */
export const CHECK_WHY: Record<HealthCheckKind, string> = {
  ids_running_out: "When the numbers run out, every insert fails with “integer out of range”.",
  transaction_age: "Past the limit, Postgres stops taking writes until the database is vacuumed.",
  replication_slots: "An inactive slot keeps every WAL file since it stopped, until the disk fills.",
  unused_indexes: "Every insert and update still writes to them, and they take space.",
  duplicate_indexes: "The longer index already answers the same lookups; this one only costs writes and space.",
  foreign_keys_without_index:
    "A delete or update on the parent reads the whole child table to check it, and joins can't use an index.",
  dead_rows: "Scans and the cache carry the dead rows too, so reads slow down and the table grows.",
  never_analyzed: "Without statistics the planner guesses the table's size, which leads to bad plans.",
  long_transactions: "An open transaction holds its locks and stops vacuum from clearing dead rows anywhere.",
  free_pages: "The file keeps the space of deleted rows until it is vacuumed.",
};

/** The query tab a fix opens in. */
export const FIX_TITLE: Record<HealthCheckKind, string> = {
  ids_running_out: "Widen IDs",
  transaction_age: "Freeze old tables",
  replication_slots: "Drop replication slot",
  unused_indexes: "Drop unused indexes",
  duplicate_indexes: "Drop repeated indexes",
  foreign_keys_without_index: "Index foreign keys",
  dead_rows: "Vacuum tables",
  never_analyzed: "Analyze tables",
  long_transactions: "End idle transactions",
  free_pages: "Vacuum the file",
};

/** What the fix does that isn't obvious from the SQL. */
export const FIX_NOTE: Partial<Record<HealthCheckKind, string>> = {
  ids_running_out:
    "Changing the type rewrites the table and locks it while it runs. Columns that reference it need bigint too.",
  transaction_age: "Freezing reads the whole table. It doesn't block reads or writes.",
  replication_slots: "Drop a slot only once you know its replica or consumer won't come back.",
  foreign_keys_without_index: "CONCURRENTLY builds the index without blocking writes.",
  free_pages: "VACUUM rewrites the whole file and needs as much free disk again.",
};

/** One line in the Fine list. */
export function fineLabel(check: HealthCheckKind, report: HealthReport): string {
  switch (check) {
    case "ids_running_out":
      return "No ID is close to running out";
    case "transaction_age":
      return report.transaction_age === null
        ? "Transaction age is fine"
        : `Transaction age ${percent(report.transaction_age)} of the limit`;
    case "replication_slots":
      return "Replication slots keep up";
    case "unused_indexes":
      return "Every large index is used";
    case "duplicate_indexes":
      return "No index repeats another";
    case "foreign_keys_without_index":
      return "Every foreign key has an index";
    case "dead_rows":
      return "Vacuum keeps up";
    case "never_analyzed":
      return "Every large table is analyzed";
    case "long_transactions":
      return "No idle transactions over 5 minutes";
    case "free_pages":
      return "Little free space in the file";
  }
}

/** 0.812 → "81%", 0.004 → "0.4%". */
export function percent(share: number): string {
  const p = share * 100;
  return p > 0 && p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** 1_700_000_000 → "1.7 billion"; 84_000 → "84k". */
export function formatCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)} billion`;
  return formatRowCount(n);
}

/** 3 → "3 days", 40 → "about 6 weeks", 400 → "about 13 months". */
export function formatDays(days: number): string {
  if (days < 1) return "less than a day";
  if (days < 14) return `${Math.round(days)} ${Math.round(days) === 1 ? "day" : "days"}`;
  if (days < 120) return `about ${Math.round(days / 7)} weeks`;
  if (days < 730) return `about ${Math.round(days / 30)} months`;
  return `about ${Math.round(days / 365)} years`;
}

/** 1_725_000_000 → "3 Sep". */
export function formatDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `orders` or `audit.orders` (the public schema goes without saying). */
export function tableName(item: HealthItem): string {
  const table = item.table ?? "";
  return item.schema && item.schema !== "public" ? `${item.schema}.${table}` : table;
}

/** What one item is about, in the inspector's list. */
export function itemLabel(item: HealthItem): string {
  const d = item.detail;
  switch (d.kind) {
    case "ids_running_out":
      return `${tableName(item)}.${item.name}`;
    case "foreign_key_without_index":
      return `${tableName(item)} (${d.columns.join(", ")})`;
    case "long_transaction":
      return `Session ${d.pid}${d.user ? ` · ${d.user}` : ""}`;
    case "replication_slot":
      return item.name ?? "";
    case "unused_index":
    case "duplicate_index":
      return item.name ?? "";
    default:
      return tableName(item) || (item.name ?? "");
  }
}

/** The number beside it. */
export function itemValue(item: HealthItem): string {
  const d = item.detail;
  switch (d.kind) {
    case "ids_running_out":
      return percent(d.used / d.max);
    case "transaction_age":
      return percent(d.age / d.limit);
    case "dead_rows":
      return `${percent(d.dead / Math.max(1, d.dead + d.live))} dead`;
    case "never_analyzed":
    case "foreign_key_without_index":
      return rowsText(d.rows);
    case "long_transaction":
      return formatAge(d.idle_secs);
    default:
      return formatBytes(item.bytes);
  }
}

/** 120M rows, or "10k+ rows" when only the limit is known. */
function rowsText(rows: number | null): string {
  return rows === null ? "10k+ rows" : `${formatRowCount(rows)} rows`;
}

function sumBytes(items: HealthItem[]): number {
  return items.reduce((n, i) => n + (i.bytes ?? 0), 0);
}

/** A finding's card: its title, the line under it and its weight on the right. */
export interface FindingText {
  title: string;
  line: string;
  weight: string;
}

export function findingText(check: HealthCheck & { state: "found" }, report: HealthReport): FindingText {
  const items = check.items;
  const n = items.length;
  if (!n) return { title: CHECK_NAME[check.check], line: "", weight: "" };
  const one = n === 1 ? items[0] : null;
  const since = report.stats_since === null ? "since the statistics began" : `since ${formatDate(report.stats_since)}`;
  switch (check.check) {
    case "ids_running_out": {
      const d = items[0].detail;
      if (d.kind !== "ids_running_out") break;
      const when = d.days_left === null ? null : formatDays(d.days_left);
      return {
        title: one
          ? when
            ? `${itemLabel(one)} runs out of numbers in ${when}`
            : `${itemLabel(one)} has used ${percent(d.used / d.max)} of its numbers`
          : `${n} IDs are running out of numbers`,
        line: `${d.type_name} column · ${percent(d.used / d.max)} of ${d.max.toLocaleString("en-US")} used`,
        weight: formatCount(d.used),
      };
    }
    case "transaction_age": {
      const share = report.transaction_age ?? 0;
      return {
        title: `Transaction age is ${percent(share)} of the limit`,
        line: `past it, Postgres stops taking writes · ${plural(n, "table holds", "tables hold")} it back`,
        weight: percent(share),
      };
    }
    case "replication_slots":
      return {
        title: one
          ? `Replication slot ${one.name} holds ${formatBytes(one.bytes)} of WAL`
          : `${n} inactive replication slots hold ${formatBytes(sumBytes(items))} of WAL`,
        line: "inactive, so the WAL piles up on disk",
        weight: formatBytes(sumBytes(items)),
      };
    case "unused_indexes":
      return {
        title: `${plural(n, "index", "indexes")} nobody has used ${since}`,
        line: `${n === 1 ? "it slows" : "they slow"} every write and take${n === 1 ? "s" : ""} space`,
        weight: formatBytes(sumBytes(items)),
      };
    case "duplicate_indexes": {
      const d = one?.detail;
      return {
        title:
          one && d?.kind === "duplicate_index"
            ? `${one.name} repeats ${d.covered_by}`
            : `${n} indexes repeat another index`,
        line: `the longer index already covers ${n === 1 ? "it" : "them"}`,
        weight: formatBytes(sumBytes(items)),
      };
    }
    case "foreign_keys_without_index": {
      const d = one?.detail;
      if (one && d?.kind === "foreign_key_without_index") {
        const parent = tableName({ ...one, schema: d.parent_schema, table: d.parent_table });
        return {
          title: `${tableName(one)}.${d.columns.join(", ")} has no index`,
          line: `foreign key · each delete on ${parent} reads ${d.rows === null ? "the whole table" : rowsText(d.rows)}`,
          weight: rowsText(d.rows),
        };
      }
      return {
        title: `${n} foreign keys have no index`,
        line: "each delete on a parent reads the whole child table",
        weight: "",
      };
    }
    case "dead_rows": {
      const d = one?.detail;
      if (one && d?.kind === "dead_rows") {
        const last = d.vacuumed_secs_ago === null ? "never vacuumed" : `last vacuum ${formatDays(d.vacuumed_secs_ago / 86_400)} ago`;
        return {
          title: `${tableName(one)}: ${itemValue(one)} rows, ${last}`,
          line: "vacuum can't keep up · scans read the dead rows too",
          weight: formatBytes(one.bytes),
        };
      }
      return {
        title: `${n} tables are over 20% dead rows`,
        line: "vacuum can't keep up · scans read the dead rows too",
        weight: formatBytes(sumBytes(items)),
      };
    }
    case "never_analyzed":
      return {
        title: one ? `${tableName(one)} has never been analyzed` : `${n} tables have never been analyzed`,
        line: "the planner guesses their size",
        weight: one ? itemValue(one) : "",
      };
    case "long_transactions": {
      const d = one?.detail;
      return {
        title:
          one && d?.kind === "long_transaction"
            ? `Session ${d.pid} has sat in a transaction for ${formatAge(d.idle_secs)}`
            : `${n} sessions sit idle in a transaction`,
        line: "holds its locks and stops vacuum",
        weight: "",
      };
    }
    case "free_pages": {
      const d = items[0].detail;
      if (d.kind !== "free_pages") break;
      return {
        title: `${formatBytes(d.free_bytes)} of the file is free pages`,
        line: `${percent(d.free_bytes / Math.max(1, d.file_bytes))} of the file · VACUUM gives it back`,
        weight: formatBytes(d.free_bytes),
      };
    }
  }
  return { title: CHECK_NAME[check.check], line: "", weight: "" };
}

/** The checks with findings, worst first. */
export function foundChecks(report: HealthReport): (HealthCheck & { state: "found" })[] {
  return report.checks
    .filter((c): c is HealthCheck & { state: "found" } => c.state === "found")
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check),
    );
}

/** Every item's fix, one per line, for the inspector and the query tab. */
export function fixSql(check: HealthCheck & { state: "found" }): string {
  return check.items
    .map((i) => i.fix)
    .filter((f): f is string => !!f)
    .join("\n");
}

/** The once-a-day toast: the first "Soon" finding's title, or null. */
export function soonToast(report: HealthReport): string | null {
  const soon = foundChecks(report).filter((c) => c.severity === "soon");
  if (!soon.length) return null;
  const first = findingText(soon[0], report).title;
  return soon.length === 1 ? first : `${first}, and ${soon.length - 1} more`;
}

/** The server's query time in one short figure: 212 ms, 1.4 s. */
export function formatQueryMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * How to turn pg_stat_statements on. Creating the extension is enough on
 * Amazon RDS and Google Cloud SQL, which load it already; a server of your
 * own may need it loaded first. `loaded` says the server loads it for sure.
 */
export function pgssSteps(loaded: boolean): { where: string; how: string; sql: boolean }[] {
  const create = { where: "In this database", how: "CREATE EXTENSION pg_stat_statements;", sql: true };
  if (loaded) return [create];
  return [
    create,
    {
      where: "If Postgres says it isn't loaded",
      how: "Add pg_stat_statements to shared_preload_libraries (postgresql.conf, or the RDS parameter group) and restart the server.",
      sql: false,
    },
  ];
}
