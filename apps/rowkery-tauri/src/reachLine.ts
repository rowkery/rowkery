import type { RowChange } from "./api";
import type { Reach } from "./proposals";

/**
 * What else a batch writes, for the edits bar: "deleting this row also
 * deletes 14 kiosk_sessions and 37 payouts", "these changes also delete
 * 2 payouts, 1 kiosk_sessions and add 1 row to audit_log". Counts, not rows: which change caused which isn't known.
 */
export function reachLine(changes: RowChange[], reach: Reach): string {
  const one = changes.length === 1;
  const lead = !one ? "these changes" : changes[0].op === "delete" ? "deleting this row" : changes[0].op === "insert" ? "adding this row" : "this edit";
  const verb = (word: "delete" | "add" | "change") => (one ? `${word}s` : word);
  const rows = (n: number) => `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
  const deleted = reach.tables.filter((t) => t.deleted > 0).map((t) => `${t.deleted.toLocaleString()} ${t.table}`);
  const others = [
    ...reach.tables.filter((t) => t.inserted > 0).map((t) => `${verb("add")} ${rows(t.inserted)} to ${t.table}`),
    ...reach.tables.filter((t) => t.updated > 0).map((t) => `${verb("change")} ${rows(t.updated)} in ${t.table}`),
    reach.unnamed > 0 ? `${verb("change")} ${rows(reach.unnamed)} in tables Rowkery can't name` : null,
  ].filter((c): c is string => !!c);
  // One "and" per line: the deleted tables take commas when more follows.
  const clauses = deleted.length ? [`${verb("delete")} ${others.length ? deleted.join(", ") : joinAnd(deleted)}`, ...others] : others;
  return `${lead} also ${joinAnd(clauses)}`;
}

function joinAnd(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
