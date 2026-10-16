#!/usr/bin/env node
// Query tab status proof without a Tauri webview or Postgres: stubbed `invoke`
// where "pg_sleep(n)" waits n seconds and "boom" fails. Runs queries in three
// tabs at once, checks each tab's spinner and ticking time, the green / red
// dot on tabs that finished out of sight (cleared on opening), per-tab results,
// Esc cancelling only the shown tab, closing a running tab cancelling its
// query, ⌘↵ running again straight after a ⌘↵ run, a ⌘K table browse running
// in the tab it opens, and that no timer ticks once everything is idle.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/query-tab-status-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// run_query answers stream as frames (src-tauri `Frame`); the stub keeps returning results.
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/query-tab-status";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = {
    wallet: ["api_keys", "ledger_entries", "wallets"],
    orders: ["order_items", "orders", "refunds", "shipments"],
    payments: ["charges", "payouts"],
    analytics: ["daily_active", "events"],
  };
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: (TABLES[db] ?? ["t"]).map((name, i) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 * (i + 1) },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  });
  const pg = (id, name, host, environment) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: "wallet",
    username: "app",
    environment,
  });
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd"),
    pg("stg", "wallet", "wallet-stg.db.internal", "stg"),
    { ...pg("local", "Docker Postgres", "127.0.0.1", "local"), port: 54329, database: "rowkery" },
    { kind: "sqlite", id: "cache", name: "analytics-cache", path: "~/cache.db" },
  ];
  const windows = {};
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          const c = connections.find((x) => x.id === args.connectionId);
          const database = c.kind === "sqlite" ? "main" : (args.database ?? c.database);
          windows[args.windowId] = { conn: c, database };
          await new Promise((r) => setTimeout(r, 60));
          return { database, catalog: catalogFor(database), elapsed_ms: 60 };
        }
        case "close_window":
          delete windows[args.windowId];
          return null;
        case "list_databases":
          return [
            { name: "analytics", size_bytes: 12_884_901_888 },
            { name: "orders", size_bytes: 4_509_715_660 },
            { name: "payments", size_bytes: 1_181_116_006 },
            { name: "postgres", size_bytes: 8_388_608 },
            { name: "wallet", size_bytes: 901_775_360 },
          ];
        case "run_query": {
          // "pg_sleep(n)" waits n seconds (cancellable), "boom" fails.
          const secs = Number(/pg_sleep\((\d+(?:\.\d+)?)\)/.exec(args.sql)?.[1] ?? 0);
          const started = performance.now();
          const cancelled = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), secs * 1000);
            (window.__ROWKERY_PENDING__ ??= {})[`${args.windowId}:${args.tabId}`] = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          const elapsed_ms = Math.round(performance.now() - started);
          if (cancelled) return { columns: [], rows: [], row_count: 0, elapsed_ms, error: null, cancelled: true };
          if (args.sql.includes("boom"))
            return { columns: [], rows: [], row_count: 0, elapsed_ms, error: 'relation "boom" does not exist', cancelled: false };
          return {
            columns: [{ name: "tab", type_name: "int8" }, { name: "sql", type_name: "text" }],
            rows: [[{ Int: args.tabId }, { Text: args.sql }]],
            row_count: 1,
            elapsed_ms,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
        case "close_query_tab":
          window.__ROWKERY_PENDING__?.[`${args.windowId}:${args.tabId}`]?.();
          return null;
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
// Count live intervals, to show nothing ticks while every tab is idle.
await page.addInitScript(() => {
  const live = new Set();
  const set = window.setInterval.bind(window);
  const clear = window.clearInterval.bind(window);
  window.setInterval = (...a) => {
    const id = set(...a);
    live.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    live.delete(id);
    clear(id);
  };
  window.__liveIntervals = () => live.size;
});
await page.addInitScript(() => {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "prd", database: "wallet" }], active: 0 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const tab = (title) => page.locator(`${visible} [data-testid="query-tab"][data-reorder-key][data-title="${title}"]`);
const editorClip = async () => {
  const b = await page.locator(`${visible} [data-testid="editor-header"]`).boundingBox();
  return { x: b.x - 8, y: b.y - 8, width: 760, height: b.height + 16 };
};
const shot = async (name, clip) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: clip ?? (await editorClip()) });
  console.log(`${OUT}/${name}.png`);
};
const typeAndRun = async (sql) => {
  await page.click(`${visible} [data-testid="sql-editor"]`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
  await page.click(`${visible} [data-testid="run-btn"]`);
};
const idleIntervals = await page.evaluate(() => window.__liveIntervals());

// 1. Three tabs, two long queries and one that fails, all at once.
await typeAndRun("SELECT pg_sleep(3.2);");
await page.click(`${visible} [data-testid="query-tab-add"]`);
await typeAndRun("SELECT pg_sleep(1.4);");
await page.click(`${visible} [data-testid="query-tab-add"]`);
await page.waitForTimeout(100);
check(!(await page.isDisabled(`${visible} [data-testid="run-btn"]`)), "Run stays enabled on an idle tab while others run");
check((await page.locator(`${visible} [data-testid="query-tab-spin"]`).count()) === 2, "two tabs show a spinner");
await page.waitForTimeout(700);
const t1 = await tab("Query 1").locator('[data-testid="query-tab-time"]').textContent();
check(/^\d+\.\ds$/.test(t1) && parseFloat(t1) >= 0.7, `running tab shows its elapsed time (${t1})`);
await shot("1-two-running");

// 2. Query 3 fails while on screen; Query 2 finishes out of sight.
await typeAndRun("SELECT * FROM boom;");
await page.waitForTimeout(1200);
check((await tab("Query 2").locator('[data-testid="query-tab-dot"]:not([data-outcome="error"])').count()) === 1, "Query 2 finished out of sight: green dot");
check(/s$/.test(await tab("Query 2").locator('[data-testid="query-tab-time"]').textContent()), "and keeps its time");
check((await tab("Query 3").locator('[data-testid="query-tab-dot"][data-outcome="error"]').count()) === 1, "the failed tab on screen gets a red dot");
check(/^\d+ms$/.test(await tab("Query 3").locator('[data-testid="query-tab-time"]').textContent()), "and its run time in ms");
check((await page.locator(`${visible} [data-testid="card-meta"][data-state="error"]`).count()) === 1, "results show Query 3's error");
await shot("2-one-done-one-running");

// 3. Query 1 is still running; a failing run in the background gets a red dot.
await page.click(`${visible} [data-testid="query-tab-add"]`);
await typeAndRun("SELECT pg_sleep(0.3), boom;");
await tab("Query 2").click();
await page.waitForTimeout(600);
check((await tab("Query 4").locator('[data-testid="query-tab-dot"][data-outcome="error"]').count()) === 1, "background failure: red dot");
check((await tab("Query 2").locator('[data-testid="query-tab-dot"]:not([data-outcome="error"])').count()) === 1, "Query 2 keeps its green dot once opened");
check(/^1\.\ds$/.test(await tab("Query 2").locator('[data-testid="query-tab-time"]').textContent()), "and its run time (about 1.4s)");
check((await page.textContent(`${visible} [data-testid="results-card"]`)).includes("pg_sleep(1.4)"), "Query 2 shows its own result");
await page.waitForTimeout(1300);
check((await tab("Query 1").locator('[data-testid="query-tab-dot"]:not([data-outcome="error"])').count()) === 1, "Query 1 finished: green dot");
await shot("3-dots");

// 4. Esc cancels only the tab on screen.
await tab("Query 1").click();
await typeAndRun("SELECT pg_sleep(30);");
await tab("Query 2").click();
await typeAndRun("SELECT pg_sleep(30);");
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check((await page.locator(`${visible} [data-testid="card-meta"][data-state="cancelled"]`).count()) === 1, "Esc cancelled Query 2");
check((await tab("Query 1").locator('[data-testid="query-tab-spin"]').count()) === 1, "Query 1 keeps running");
check((await tab("Query 2").locator('[data-testid="query-tab-dot"]').count()) === 0, "a cancel leaves no dot");

// 5. Closing a running tab cancels its query (and closes its connection).
await tab("Query 1").hover();
await tab("Query 1").locator('[data-testid="query-tab-close"]').click();
await page.waitForTimeout(300);
const cancels = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.filter(([c]) => c === "close_query_tab").map(([, a]) => a.tabId),
);
check(cancels.includes(1), "closing Query 1 cancelled its query");

// 6. ⌘↵ twice in a row: the editor keeps focus through the run and runs again.
const runCount = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").length);
await page.click(`${visible} [data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT pg_sleep(0.2);");
const before = await runCount();
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(80);
await page.keyboard.type("x");
check(
  (await page.inputValue(`${visible} [data-testid="sql-editor"]`)) === "SELECT pg_sleep(0.2);",
  "the editor is read-only while its query runs",
);
await page.waitForTimeout(400);
check(
  await page.evaluate(() => document.activeElement?.matches('[data-testid="sql-editor"]')),
  "the editor keeps focus after a ⌘↵ run",
);
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(400);
check((await runCount()) === before + 2, "a second ⌘↵ runs again without clicking or Enter");

// 7. ⌘K → table → ↵ from a tab with SQL in it: the browse runs in the new tab.
await page.waitForTimeout(300);
const shownTab = await page.getAttribute(`${visible} [data-testid="query-tab"][aria-selected="true"]`, "data-title");
const shownResult = await page.textContent(`${visible} [data-testid="results-card"]`);
await page.keyboard.press("Control+k");
await page.keyboard.type("ledger");
await page.waitForTimeout(100);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const browse = await page.evaluate(() =>
  window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").at(-1)[1],
);
const newTab = page.locator(`${visible} [data-testid="query-tab"][aria-selected="true"]`);
check((await newTab.textContent()).includes("ledger_entries"), "⌘K opened ledger_entries in a new tab");
check(
  browse.sql.includes("ledger_entries") &&
    String(browse.tabId) === (await newTab.getAttribute("data-reorder-key")),
  `the browse ran in the new tab (slot ${browse.tabId})`,
);
check(
  (await page.textContent(`${visible} [data-testid="results-card"]`)).includes("ledger_entries"),
  "the new tab shows the browse result",
);
await page.locator(`${visible} [data-testid="query-tab"][data-title="${shownTab}"]`).first().click();
check(
  (await page.textContent(`${visible} [data-testid="results-card"]`)) === shownResult,
  "the old tab keeps its own result",
);
await shot("4-palette-new-tab");

// 8. Nothing ticks once every tab is idle.
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__liveIntervals())) === idleIntervals, "no timers left when idle");

await browser.close();
