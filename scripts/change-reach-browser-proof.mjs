#!/usr/bin/env node
// Everything a proposed change touches (2026-10-27), with a stubbed Tauri
// `invoke`. An agent proposes deleting one customer; the dry run comes back
// with what the foreign-key cascades and a trigger wrote in other tables.
// The statement's head says "1 row + 66 in other tables" (the main column
// doesn't grow); the inspector says "67 rows would change" and lists each
// table with its count, a table not shared with the agent marked "not
// shared" and named in a warning; the line beside Dry run says "67 rows in
// 5 tables · rolled back" and the card "67 rows · dry run". Commit sends
// every table's counts; a "moved" answer (one more payment) swaps in the
// fresh counts. A SQLite proposal reaching a WITHOUT ROWID table lists "N
// more rows in tables Rowkery can't name"; a long table name stays on one
// line beside its count. The counting and the commit's re-check are proved
// by `cargo test -p rowkery-mcp` (`--features postgres-integration`).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/change-reach-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/change-reach";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    {
      kind: "postgres",
      id: "api",
      name: "Platform API",
      host: "api-db.c9x.rds.amazonaws.com",
      port: 5432,
      database: "orders",
      username: "app",
      environment: "stg",
      allow_mcp: true,
      mcp_access: { orders: { mode: "picked", tables: ["public.customers", "public.orders", "public.order_items", "public.audit_log"] } },
    },
    { kind: "sqlite", id: "shop", name: "Shop", path: "~/shop.sqlite", allow_mcp: true },
  ];
  const catalog = {
    databases: [
      {
        name: "orders",
        schemas: [
          {
            name: "public",
            tables: ["customers", "orders"].map((name) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  };
  const now = Date.now();
  const P1 = {
    id: "p_000000000001",
    ts: now - 4 * 60_000,
    connection: "api",
    database: "orders",
    sql: "DELETE FROM customers WHERE id = 12",
    reason: "Ada Park asked to close her account (support ticket 4471). Removing her customer record.",
    expect_rows: 1,
    client: "claude-ai",
  };
  const P2 = {
    id: "p_000000000002",
    ts: now,
    connection: "shop",
    database: "main",
    sql: "DELETE FROM carts WHERE id = 7",
    reason: "Abandoned cart from last year.",
    client: "claude-code",
  };
  const t = (table, d, i = 0, u = 0) => ({ schema: "public", table, inserted: i, updated: u, deleted: d });
  const del = (payments) => ({
    proposal: P1,
    connection_name: "Platform API",
    statements: [
      {
        verb: "DELETE",
        target: "customers",
        sql: P1.sql,
        destructive: false,
        rows: 1,
        columns: ["id", "full_name", "plan", "seats", "country"],
        key: ["id"],
        changed: [],
        shown: [{ before: [12, "Ada Park", "pro", 10, "SG"], after: null }],
        triggers: [],
        reach: { tables: [t("audit_log", 0, 1), t("customers", 1), t("order_items", 37), t("orders", 14), t("payments", payments)], unnamed: 0 },
      },
    ],
    at_commit: null,
    unshared: [["public", "payments"]],
  });
  const long = "customer_loyalty_programme_membership_history_entries";
  const dry2 = {
    proposal: P2,
    connection_name: "Shop",
    statements: [
      {
        verb: "DELETE",
        target: "carts",
        sql: P2.sql,
        destructive: false,
        rows: 1,
        columns: ["id", "customer"],
        key: ["id"],
        changed: [],
        shown: [{ before: [7, 31], after: null }],
        triggers: [],
        reach: {
          tables: [
            { schema: "main", table: "carts", inserted: 0, updated: 0, deleted: 1 },
            { schema: "main", table: long, inserted: 0, updated: 2, deleted: 0 },
          ],
          unnamed: 4,
        },
      },
    ],
    at_commit: null,
    unshared: [],
  };
  const plans = {
    [P1.id]: { connection_name: "Platform API", statements: [{ verb: "DELETE", target: "customers", sql: P1.sql, destructive: false, triggers: [] }] },
    [P2.id]: { connection_name: "Shop", statements: [{ verb: "DELETE", target: "carts", sql: P2.sql, destructive: false, triggers: [] }] },
  };
  let queue = [P1, P2];
  let commits = 0;
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "mcp_activity":
          return { entries: [], offset: 0, reset: true };
        case "open_window":
          return { database: "orders", catalog, elapsed_ms: 40 };
        case "run_query":
          return { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
        case "proposals_waiting":
          return structuredClone(queue);
        case "proposal_plan":
          return structuredClone(plans[args.id]);
        case "proposal_dry_run":
          await new Promise((r) => setTimeout(r, 40));
          return structuredClone(args.id === P1.id ? del(14) : dry2);
        case "proposal_commit":
          // The first commit finds one more payment; the second goes through.
          if (commits++ === 0) return { outcome: "moved", dry_run: structuredClone(del(15)) };
          queue = queue.filter((p) => p.id !== args.id);
          return { outcome: "committed", rows: args.seen.rows };
        case "proposal_reject":
          queue = queue.filter((p) => p.id !== args.id);
          return null;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const dark = async (name) => {
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot(name);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
};
const calls = (cmd) => page.evaluate((c) => window.__ROWKERY_CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);
const text = (sel) => page.textContent(sel).then((t) => t?.replace(/\s+/g, " ").trim());

const ws = '[data-testid="workspace"]:not([hidden])';
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="api"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForSelector('[data-testid="sb-proposals"]');
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector('[data-proposal="p_000000000001"] [data-testid="pp-dry-run"]');

// 1. Before the dry run nothing claims other tables.
check(!(await page.$('[data-testid="pp-stmt-other"]')) && !(await page.$('[data-testid="pp-reach"]')), "no counts before the dry run");

// 2. Dry run: the head adds what other tables lose; the inspector lists them.
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
// Text on purpose: the counts' wording is what's under test.
check((await text('[data-testid="pp-stmt-head"] b')) === "1" && (await text('[data-testid="pp-stmt-other"]')) === "+ 66 in other tables", "the head: 1 row + 66 in other tables");
check((await page.$$('[data-testid="pp-preview"] tbody tr')).length === 1, "the main column still shows only the statement's own row");
check((await text('[data-testid="pp-count"]')).startsWith("67 rows would change"), "67 rows would change");
check(!(await page.$('[data-testid="pp-count"] [data-match]')), "the agent expected 1: no match");
const rows = await page.$$eval('[data-testid="pp-reach-table"]', (li) => li.map((x) => `${x.dataset.table}: ${x.textContent.replace(/\s+/g, " ").trim()}`));
check(
  rows.join(" | ") === "audit_log: audit_log1 added | customers: customers1 deleted | order_items: order_items37 deleted | orders: orders14 deleted | payments: payments14 deleted · not shared",
  `one line per table: ${rows.join(" | ")}`,
);
check((await page.$$('[data-testid="pp-reach-table"][data-unshared]')).length === 1, "only payments is marked not shared");
check((await text('[data-testid="pp-unshared"]')) === "Also changes tables not shared with the agent: payments.", "a warning names it");
check((await text('[data-testid="pp-dry-line"]')) === "67 rows in 5 tables · rolled back", "the line: 67 rows in 5 tables · rolled back");
check((await text('[data-proposal-id="p_000000000001"] [data-testid="pp-card-rows"]')) === "67 rows · dry run", "its card: 67 rows · dry run");
await shot("1-cascade");
await dark("2-cascade-dark");

// 3. Commit: every table's counts go with it; one more payment means nothing is saved.
await page.click('[data-testid="pp-commit"]');
await page.waitForFunction(() => document.querySelector('[data-table="payments"]')?.textContent.includes("15"));
const sent = (await calls("proposal_commit"))[0]?.seen;
check(JSON.stringify(sent?.rows) === "[1]" && sent?.reach[0]?.tables.find((t) => t.table === "payments")?.deleted === 14, "Commit sends the rows and each table's counts");
check((await text('[data-testid="pp-count"]')).startsWith("68 rows would change"), "the fresh dry run: 68 rows");
await shot("3-moved");
await page.click('[data-testid="pp-commit"]');
await page.waitForSelector('[data-proposal="p_000000000002"] [data-testid="pp-dry-run"]');
check((await calls("proposal_commit"))[1]?.seen.reach[0]?.tables.find((t) => t.table === "payments")?.deleted === 15, "the second commit sends the fresh counts");

// 4. SQLite: rows the update hook can't name, and a long table name.
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
check((await text('[data-testid="pp-reach-unnamed"]')) === "4 more rows in tables Rowkery can't name", "rows Rowkery can't name are counted");
check((await text('[data-testid="pp-stmt-other"]')) === "+ 6 in other tables", "+ 6 in other tables");
check(!(await page.$('[data-testid="pp-unshared"]')), "every table shared: no warning");
const fits = await page.$eval('[data-table^="customer_loyalty"]', (li) => {
  const code = li.querySelector("code");
  const count = li.querySelector(":scope > span");
  return li.getBoundingClientRect().height < 24 && code.getBoundingClientRect().right <= count.getBoundingClientRect().left;
});
check(fits, "a long table name shortens on one line beside its count");
await shot("4-sqlite-unnamed");
await dark("5-sqlite-unnamed-dark");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
