#!/usr/bin/env node
// Schema refresh proof without a Tauri webview (stubbed `invoke`): a table
// created outside the app (a migration) shows up after the refresh button in
// the schema panel's head, ⌘R / Ctrl+R, or ⌘K "Refresh schema"; on a query
// tab ⌘R also runs its last statement again when it only reads, never one that writes.
// The button spins while the reload runs, the list keeps showing meanwhile,
// and a toast says it is done (or why it failed).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/schema-refresh-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/schema-refresh";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = {
    wallet: ["api_keys", "ledger_entries", "wallets"],
    orders: ["order_items", "orders", "refunds", "shipments"],
    payments: ["charges", "payouts"],
    analytics: ["daily_active", "events"],
  };
  // Each reload finds one more table, as if a migration ran meanwhile.
  let migrations = 0;
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: [
              ...(TABLES[db] ?? ["t"]),
              ...Array.from({ length: migrations }, (_, i) => `added_by_migration_${i + 1}`),
            ].map((name, i) => ({
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
        case "reload_window_schema": {
          const w = windows[args.windowId];
          await new Promise((r) => setTimeout(r, window.__ROWKERY_RELOAD_MS__ ?? 600));
          if (window.__ROWKERY_RELOAD_FAIL__) throw "connection reset by peer";
          migrations += 1;
          return catalogFor(w.database);
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
        case "reads_only":
          // Core's `plain_read` decides in the app; here a SELECT reads and anything else writes.
          return /^\s*select\b/i.test(args.sql);
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
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "local", database: "wallet" }], active: 0 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
const sidebar = await page.locator(visible + ' [data-testid="sidebar"]').boundingBox();
const clip = { x: 0, y: 0, width: sidebar.x + sidebar.width + 320, height: 420 };
const names = () => page.locator(visible + ' [data-testid="sidebar"]').innerText();
const toastText = () =>
  page.$$eval("[data-toast] > span", (els) => (els.length ? els.map((e) => e.textContent.trim()).join(" · ") : null));
const reloads = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "reload_window_schema").length);

// 1. The button, and the list before any migration.
check(!(await names()).includes("added_by_migration_1"), "no migrated table yet");
await page.hover(visible + ' [data-testid="sb-refresh"]');
await page.screenshot({ path: `${OUT}/1-button.png`, clip });

// 2. Click: spins while the reload runs, the old list stays.
await page.click(visible + ' [data-testid="sb-refresh"]');
await page.waitForTimeout(150);
check((await page.locator(visible + ' [data-testid="sb-refresh"][data-spinning]').count()) === 1, "button spins while reloading");
check((await names()).includes("wallets"), "old list stays while reloading");
await page.screenshot({ path: `${OUT}/2-spinning.png`, clip });
await page.waitForTimeout(700);
check((await names()).includes("added_by_migration_1"), "new table shows after the refresh");
check((await page.locator(visible + ' [data-testid="sb-refresh"][data-spinning]').count()) === 0, "spinner stops");
check((await toastText()) === "Schema refreshed", "toast: Schema refreshed");
await page.screenshot({ path: `${OUT}/3-refreshed.png`, clip });

// 3. Ctrl+R (⌘R on macOS), even with the editor focused.
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.press("Control+r");
await page.waitForTimeout(900);
check((await names()).includes("added_by_migration_2"), "Ctrl+R refreshes");
check(page.url() === URL, "Ctrl+R does not reload the page");

// 4. ⌘K "Refresh schema".
await page.keyboard.press("Control+k");
await page.keyboard.type(">refresh schema");
await page.waitForTimeout(100);
check((await page.locator('[data-testid="cp-row"][data-item="cmd:refresh-schema"]').count()) === 1, "⌘K lists Refresh schema");
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
check((await names()).includes("added_by_migration_3"), "⌘K refreshes");

// 5. A second press while one runs doesn't start another reload (the button
// is disabled while it spins).
const before = await reloads();
await page.click(visible + ' [data-testid="sb-refresh"]');
check(await page.locator(visible + ' [data-testid="sb-refresh"]').isDisabled(), "button is disabled while reloading");
await page.click(visible + ' [data-testid="sb-refresh"]', { force: true });
await page.waitForTimeout(900);
check((await reloads()) === before + 1, "one reload per press while running");

// 6. A failed reload keeps the schema and says why.
await page.waitForTimeout(1800);
await page.evaluate(() => (window.__ROWKERY_RELOAD_FAIL__ = true));
await page.click(visible + ' [data-testid="sb-refresh"]');
await page.waitForTimeout(800);
check((await toastText())?.startsWith("Couldn't refresh schema"), "toast: Couldn't refresh schema");
check((await names()).includes("added_by_migration_4"), "failed reload keeps the list");
await page.screenshot({ path: `${OUT}/4-failed.png`, clip });

// 7. On a query tab ⌘R runs its last statement again when it only reads; one that writes never.
await page.evaluate(() => (window.__ROWKERY_RELOAD_FAIL__ = false));
await page.waitForTimeout(2600);
const queryRuns = () => page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").map(([, a]) => a.sql));
const runInEditor = async (sql) => {
  await page.click(visible + ' [data-testid="sql-editor"]');
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
  const n = (await queryRuns()).length;
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").length > n, n);
  await page.waitForTimeout(300);
};
await runInEditor("SELECT 42");
let ran = (await queryRuns()).length;
await page.keyboard.press("Control+r");
await page.waitForTimeout(900);
const after = await queryRuns();
check(after.length === ran + 1 && after[after.length - 1] === "SELECT 42", "Ctrl+R runs a reading query again");
check((await names()).includes("added_by_migration_5"), "…and refreshes the schema");
await runInEditor("INSERT INTO wallets (id) VALUES (7)");
ran = (await queryRuns()).length;
await page.keyboard.press("Control+r");
await page.waitForTimeout(900);
check((await queryRuns()).length === ran, "Ctrl+R never runs a writing query again");
check((await toastText())?.startsWith("Schema refreshed · this query changes data"), `toast: ${await toastText()}`);
await page.screenshot({ path: `${OUT}/5-write-not-rerun.png` });

await browser.close();
