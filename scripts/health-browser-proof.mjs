#!/usr/bin/env node
// Health tab (2026-10-26) proof with a stubbed Tauri `invoke`. A few seconds
// after a Postgres window connects, Health looks once for "Soon" findings and
// says so in a toast whose button opens the tab; it doesn't look again that
// day. ⌘K Show health (also found by "vacuum") opens one Health tab: tiles,
// findings worst first, the slowest queries, what's fine and what the login
// couldn't check. It reads when it first shows and on Refresh, never on a
// timer or on coming back to the tab. A finding opens in the inspector with
// why it matters, its items, how far to trust it and the fix, which only
// ever opens in a query tab. With pg_stat_statements off, one line leads to
// the steps. Light and dark. What the checks find, and that every fix clears
// its finding, is proved by `cargo test -p rowkery-core health` (and the
// Postgres integration test `postgres_health_finds_each_problem…`).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/health-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/health";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  window.__PGSS__ = "ranked";
  const connections = [
    {
      kind: "postgres",
      id: "pg",
      name: "shop-prd",
      host: "db.prd.internal",
      port: 5432,
      database: "shop",
      username: "alice",
      environment: "prd",
    },
  ];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = ["orders", "order_items", "events"].map((name) => ({
    name,
    kind: "table",
    columns: [col("id", "int4")],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: 12 },
    partition_of: null,
  }));
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const item = (over) => ({ schema: "public", table: "orders", name: null, bytes: null, fix: null, ...over });
  const found = (check, severity, trust, items) => ({ check, severity, trust, state: "found", items });
  const fine = (check, severity) => ({ check, severity, trust: "", state: "fine" });
  const slow = () =>
    window.__PGSS__ === "ranked"
      ? {
          state: "ranked",
          partial: false,
          queries: [
            { query: "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC", user: "api", calls: 84_000, total_ms: 17_808_000, mean_ms: 212, rows: 840_000, share: 0.62 },
            { query: "UPDATE events SET seen = true WHERE user_id = $1 AND seen = false", user: "api", calls: 310_000, total_ms: 14_880_000, mean_ms: 48, rows: 310_000, share: 0.21 },
            { query: "SELECT count(*) FROM order_items WHERE order_id = $1", user: "api", calls: 96_000, total_ms: 2_976_000, mean_ms: 31, rows: 96_000, share: 0.04 },
          ],
        }
      : { state: "off", loaded: false };
  const report = () => ({
    database: "shop",
    server: "Postgres 16.4",
    size: { total_bytes: 48.2 * GB, table_bytes: 31 * GB, index_bytes: 17 * GB },
    cache_hit: 0.994,
    connections: { used: 42, max: 100, active: 6 },
    stats_since: Math.floor(Date.now() / 1000) - 49 * 86_400,
    transaction_age: 0.12,
    checks: [
      found("unused_indexes", "waste", "Usage counts come from this server only.", [
        item({ name: "orders_status_idx", bytes: 2.6 * GB, detail: { kind: "unused_index" }, fix: "DROP INDEX CONCURRENTLY public.orders_status_idx;" }),
        item({ table: "events", name: "events_kind_created_idx", bytes: 1.3 * GB, detail: { kind: "unused_index" }, fix: "DROP INDEX CONCURRENTLY public.events_kind_created_idx;" }),
        item({ table: "customers", name: "customers_ref_code_idx", bytes: 180 * MB, detail: { kind: "unused_index" }, fix: "DROP INDEX CONCURRENTLY public.customers_ref_code_idx;" }),
      ]),
      found("ids_running_out", "soon", "The date assumes inserts keep the pace seen since the statistics were last reset.", [
        item({ name: "id", detail: { kind: "ids_running_out", type_name: "integer", used: 1_739_461_754, max: 2_147_483_647, days_left: 36 }, fix: "ALTER TABLE public.orders ALTER COLUMN id TYPE bigint;\nALTER SEQUENCE public.orders_id_seq AS bigint;" }),
      ]),
      fine("transaction_age", "soon"),
      fine("replication_slots", "soon"),
      found("foreign_keys_without_index", "slow", "The row count is the planner's estimate.", [
        item({ table: "order_items", name: "order_items_order_id_fkey", detail: { kind: "foreign_key_without_index", constraint: "order_items_order_id_fkey", columns: ["order_id"], references: "public.orders", rows: 120_000_000 }, fix: "CREATE INDEX CONCURRENTLY ON public.order_items (order_id);" }),
      ]),
      found("dead_rows", "upkeep", "Row counts are estimates kept by the statistics collector.", [
        item({ table: "events", bytes: 12.6 * GB, detail: { kind: "dead_rows", dead: 41_000_000, live: 59_000_000, vacuumed_secs_ago: 9 * 86_400 }, fix: "VACUUM (ANALYZE) public.events;" }),
      ]),
      found("duplicate_indexes", "tidy", "Compares key columns.", [
        item({ name: "orders_customer_idx", bytes: 200 * MB, detail: { kind: "duplicate_index", covered_by: "orders_customer_created_idx" }, fix: "DROP INDEX CONCURRENTLY public.orders_customer_idx;" }),
        item({ table: "events", name: "events_user_idx", bytes: 110 * MB, detail: { kind: "duplicate_index", covered_by: "events_user_seen_idx" }, fix: "DROP INDEX CONCURRENTLY public.events_user_idx;" }),
      ]),
      fine("never_analyzed", "upkeep"),
      { check: "long_transactions", severity: "upkeep", trust: "", state: "needs_role", role: "pg_monitor" },
    ],
    slow_queries: slow(),
  });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "database_health":
          return report();
        default:
          return null;
      }
    },
  };
}

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const reads = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "database_health").length);
const away = () => page.mouse.move(700, 30);

await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. The once-a-day look: a toast for the Soon finding, its button opens the tab.
check((await reads()) === 0, "nothing is read on connect itself");
await page.waitForSelector("[data-toast]", { timeout: 8000 });
const toast = await page.textContent("[data-toast]");
check(/orders\.id runs out of numbers in about 5 weeks/.test(toast), `the toast names the Soon finding (${toast.trim()})`);
check((await reads()) === 1, "one read for it");
await page.screenshot({ path: `${OUT}/1-soon-toast.png` });
await page.click("[data-toast] button");
await page.waitForSelector(`${ws} [data-health-check]`);
check(!!(await page.$(`${ws} [data-testid="query-tab"][data-title="Health"][data-on]`)), "the toast's button opens the Health tab");
await page.waitForTimeout(1500);
const day = await page.evaluate(() => window.__CALLS__.some(([, a]) => JSON.stringify(a ?? {}).includes("rowkery.healthSoonDay")));
check(day, "the day it looked is saved");

// 2. The tab: tiles, findings worst first, slow queries, fine and not checked.
const tiles = await page.$$eval(`${ws} [data-health-tile]`, (els) => els.map((e) => e.getAttribute("data-health-tile")));
check(JSON.stringify(tiles) === JSON.stringify(["size", "cache", "connections", "stats"]), `four tiles (${tiles})`);
const cards = await page.$$eval(`${ws} [data-health-check]`, (els) => els.map((e) => e.getAttribute("data-health-check")));
check(
  JSON.stringify(cards) === JSON.stringify(["ids_running_out", "unused_indexes", "foreign_keys_without_index", "dead_rows", "duplicate_indexes"]),
  `Soon first, then Waste, Slow, Upkeep, Tidy (${cards})`,
);
const unusedText = await page.textContent(`${ws} [data-health-check="unused_indexes"]`);
check(/3 indexes nobody has used since/.test(unusedText) && /4\.1 GB/.test(unusedText), "the unused card counts them and weighs them");
check((await page.$$(`${ws} [data-health-query]`)).length === 3, "three slow queries");
check(/Transaction age 12% of the limit/.test(await page.textContent(`${ws} [data-health-fine]`)), "Fine lists transaction age");
check(/Idle transactions: needs pg_monitor/.test(await page.textContent(`${ws} [data-health-unchecked]`)), "a check the login can't see says needs pg_monitor");
check(!(await page.$(`${ws} [data-testid="run-btn"]`)), "no Run on the Health tab");
await away();
await page.screenshot({ path: `${OUT}/2-health-light.png` });

// 3. A finding in the inspector, and its fix opens in a query tab.
await page.click(`${ws} [data-health-check="unused_indexes"]`);
await page.waitForSelector(`${ws} [data-health-detail="unused_indexes"]`);
const detail = await page.textContent(`${ws} [data-health-detail="unused_indexes"]`);
check(/orders_status_idx/.test(detail) && /2\.6 GB/.test(detail), "the inspector lists each index with its size");
check(/Usage counts come from this server only/.test(await page.textContent(`${ws} [data-health-trust]`)), "it says how far to trust it");
check((await page.$$eval(`${ws} [data-health-sql]`, (els) => els[0].textContent)).split("\n").length === 3, "the fix has one line per index");
await page.screenshot({ path: `${OUT}/3-finding.png` });
await page.click(`${ws} [data-health-open]`);
await page.waitForSelector(`${ws} [data-testid="query-tab"][data-title="Fix unused indexes"][data-on]`);
const sql = await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`).catch(() => page.textContent(`${ws} [data-testid="sql-editor"]`));
check(/DROP INDEX CONCURRENTLY public\.orders_status_idx;/.test(sql), "Open in query tab puts the fix in a new query tab");
const ran = await page.evaluate(() => window.__CALLS__.some(([c]) => /run|query/.test(c) && c !== "database_health"));
check(!ran, "nothing ran");

// 4. Back to the tab: no new read. Refresh reads again.
let before = await reads();
await page.click(`${ws} [data-testid="query-tab"][data-title="Health"]`);
await page.waitForSelector(`${ws} [data-health-check]`);
await page.waitForTimeout(1500);
check((await reads()) === before, "coming back to the tab doesn't read again");
await page.click(`${ws} [data-health-refresh]`);
await page.waitForFunction((n) => window.__CALLS__.filter(([c]) => c === "database_health").length === n + 1, before);
check(true, "Refresh reads once more");

// 5. A slow query, then pg_stat_statements off.
await page.click(`${ws} [data-health-query="0"]`);
await page.waitForSelector(`${ws} [data-health-detail="query"]`);
check(/62% of query time/.test(await page.textContent(`${ws} [data-inspector="health"]`)), "a slow query shows its share");
await page.evaluate(() => (window.__PGSS__ = "off"));
await page.click(`${ws} [data-health-refresh]`);
await page.waitForSelector(`${ws} [data-health-pgss-off]`);
await page.click(`${ws} [data-health-pgss-how]`);
await page.waitForSelector(`${ws} [data-health-detail="pgss"]`);
const steps = await page.textContent(`${ws} [data-health-detail="pgss"]`);
check(/CREATE EXTENSION pg_stat_statements/.test(steps) && /shared_preload_libraries/.test(steps), "the steps say how to turn it on");
await page.screenshot({ path: `${OUT}/4-pgss-off.png` });

// 6. ⌘K finds it by "vacuum" and goes to the open tab.
await page.click(`${ws} [data-testid="query-tab"][data-title="Query 1"]`);
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("vacuum");
await page.waitForSelector('[data-item="cmd:show-health"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-testid="query-tab"][data-title="Health"][data-on]`);
check((await page.$$(`${ws} [data-testid="query-tab"][data-title="Health"]`)).length === 1, "⌘K Show health goes to the one Health tab");

// 7. Dark.
await page.evaluate(() => (window.__PGSS__ = "ranked"));
await page.click(`${ws} [data-health-refresh]`);
await page.waitForSelector(`${ws} [data-health-queries]`);
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.click(`${ws} [data-health-check="ids_running_out"]`);
await page.waitForSelector(`${ws} [data-health-detail="ids_running_out"]`);
await away();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/5-health-dark.png` });

await browser.close();
