// The Health tab's words: finding titles, order, fixes, the once-a-day toast.
import { describe, expect, test } from "vitest";
import type { HealthCheck, HealthItem, HealthReport } from "../src/api";
import {
  findingText,
  fineLabel,
  fixSql,
  formatDays,
  foundChecks,
  itemLabel,
  itemValue,
  percent,
  pgssSteps,
  soonToast,
} from "../src/healthText";

const item = (over: Partial<HealthItem>): HealthItem => ({
  schema: "public",
  table: "orders",
  name: null,
  bytes: null,
  detail: { kind: "unused_index" },
  fix: null,
  ...over,
});

const found = (check: HealthCheck["check"], severity: HealthCheck["severity"], items: HealthItem[]): HealthCheck => ({
  check,
  severity,
  trust: "",
  state: "found",
  items,
});

const report = (checks: HealthCheck[]): HealthReport => ({
  database: "shop",
  server: "Postgres 16.4",
  size: null,
  cache_hit: null,
  connections: null,
  stats_since: Date.UTC(2026, 8, 3) / 1000,
  transaction_age: 0.12,
  checks,
  slow_queries: { state: "none" },
});

const ids = found("ids_running_out", "soon", [
  item({
    name: "id",
    detail: { kind: "ids_running_out", type_name: "integer", used: 1_739_461_754, max: 2_147_483_647, days_left: 36 },
    fix: "ALTER TABLE public.orders ALTER COLUMN id TYPE bigint;",
  }),
]);
const unused = found("unused_indexes", "waste", [
  item({ name: "orders_status_idx", bytes: 2.6 * 1024 ** 3, fix: "DROP INDEX CONCURRENTLY public.orders_status_idx;" }),
  item({ table: "events", name: "events_kind_idx", bytes: 1.3 * 1024 ** 3, fix: "DROP INDEX CONCURRENTLY public.events_kind_idx;" }),
]);
const slot = found("replication_slots", "soon", [
  item({ schema: null, table: null, name: "old_replica", bytes: 3 * 1024 ** 3, detail: { kind: "replication_slot", slot_type: "physical", wal_bytes: 3 * 1024 ** 3 } }),
]);

describe("findings", () => {
  test("list Soon first, then by severity", () => {
    const r = report([unused, ids, { check: "dead_rows", severity: "upkeep", trust: "", state: "fine" }]);
    expect(foundChecks(r).map((c) => c.check)).toEqual(["ids_running_out", "unused_indexes"]);
  });

  test("an id says when it runs out", () => {
    const t = findingText(ids as HealthCheck & { state: "found" }, report([ids]));
    expect(t.title).toBe("orders.id runs out of numbers in about 5 weeks");
    expect(t.line).toBe("integer column · 81% of 2,147,483,647 used");
    expect(t.weight).toBe("1.7 billion");
  });

  test("without a pace an id says how much is used", () => {
    const noPace = found("ids_running_out", "soon", [
      item({ name: "id", detail: { kind: "ids_running_out", type_name: "integer", used: 1_600_000_000, max: 2_147_483_647, days_left: null } }),
    ]);
    expect(findingText(noPace as HealthCheck & { state: "found" }, report([noPace])).title).toBe(
      "orders.id has used 75% of its numbers",
    );
  });

  test("unused indexes count since the stats began", () => {
    const t = findingText(unused as HealthCheck & { state: "found" }, report([unused]));
    expect(t.title).toBe("2 indexes nobody has used since 3 Sep");
    expect(t.weight).toBe("3.9 GB");
    const noStats = { ...report([unused]), stats_since: null };
    expect(findingText(unused as HealthCheck & { state: "found" }, noStats).title).toBe(
      "2 indexes nobody has used since the statistics began",
    );
  });

  test("a foreign key names its columns and the parent", () => {
    const fk = found("foreign_keys_without_index", "slow", [
      item({
        table: "order_items",
        name: "order_items_order_id_fkey",
        detail: { kind: "foreign_key_without_index", constraint: "order_items_order_id_fkey", columns: ["order_id"], parent_schema: "public", parent_table: "orders", rows: 120_000_000 },
      }),
    ]);
    const t = findingText(fk as HealthCheck & { state: "found" }, report([fk]));
    expect(t.title).toBe("order_items.order_id has no index");
    expect(t.line).toBe("foreign key · each delete on orders reads 120M rows");
    expect(itemLabel(fk.state === "found" ? fk.items[0] : item({}))).toBe("order_items (order_id)");
  });

  test("other schemas are named, public isn't", () => {
    expect(itemLabel(item({ schema: "audit", table: "log", detail: { kind: "never_analyzed", rows: 20_000 } }))).toBe("audit.log");
    expect(itemValue(item({ detail: { kind: "dead_rows", dead: 41, live: 59, vacuumed_secs_ago: null } }))).toBe("41% dead");
  });

  test("a fix joins every item's SQL", () => {
    expect(fixSql(unused as HealthCheck & { state: "found" })).toBe(
      "DROP INDEX CONCURRENTLY public.orders_status_idx;\nDROP INDEX CONCURRENTLY public.events_kind_idx;",
    );
  });
});

describe("the once-a-day toast", () => {
  test("speaks only for Soon findings", () => {
    expect(soonToast(report([unused]))).toBeNull();
    expect(soonToast(report([ids]))).toBe("orders.id runs out of numbers in about 5 weeks");
    expect(soonToast(report([unused, slot, ids]))).toBe("orders.id runs out of numbers in about 5 weeks, and 1 more");
  });
});

describe("words", () => {
  test("fine lines", () => {
    expect(fineLabel("transaction_age", report([]))).toBe("Transaction age 12% of the limit");
    expect(fineLabel("long_transactions", report([]))).toBe("No idle transactions over 5 minutes");
  });

  test("percent and days", () => {
    expect(percent(0.812)).toBe("81%");
    expect(percent(0.004)).toBe("0.4%");
    expect(formatDays(0.2)).toBe("less than a day");
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(9)).toBe("9 days");
    expect(formatDays(36)).toBe("about 5 weeks");
    expect(formatDays(400)).toBe("about 13 months");
  });

  test("pg_stat_statements steps", () => {
    expect(pgssSteps(true)).toHaveLength(1);
    expect(pgssSteps(false)[1].how).toMatch(/shared_preload_libraries/);
  });
});
