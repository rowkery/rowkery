#!/usr/bin/env node
// Connection windows proof without a Tauri webview or Postgres: serves the
// Vite frontend with a stubbed Tauri `invoke` and drives the window pills
// (`[data-testid="win-tab"][data-env]`), the database switcher (⇧⌘D, ⌘↵ for a new window),
// new window (⌘T, an empty window whose list connects it), switching (⌘1–9), closing (⇧⌘W, at once with an Undo
// toast), restore on relaunch (only the shown window connects) and the
// missing database chip on SQLite.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/windows-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connection-windows";
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
  // Named apart from their database: a connection named after it shows no database name in its chip.
    pg("prd", "wallet-api", "wallet-prd.db.internal", "prd"),
    pg("stg", "wallet-api", "wallet-stg.db.internal", "stg"),
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
          const w = windows[args.windowId];
          return {
            columns: [
              { name: "window", type_name: "text" },
              { name: "current_database", type_name: "text" },
            ],
            rows: [[{ Text: `${w.conn.name} (${w.conn.environment})` }, { Text: w.database }]],
            row_count: 1,
            elapsed_ms: 4,
            error: null,
            cancelled: false,
          };
        }
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
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

const shot = async (name, clip) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const text = (sel) => page.textContent(sel).then((t) => t?.trim());
const visible = '[data-testid="workspace"]:not([hidden])';
const runSql = async () => {
  await page.click(`${visible} [data-testid="run-btn"]`);
  await page.waitForSelector(`${visible} [data-col], ${visible} [role=gridcell]`);
  await page.waitForTimeout(150);
};
const top = { x: 0, y: 0, width: 1280, height: 380 };

// 1. Connect the first window to wallet (prd).
await page.keyboard.press("Control+Shift+O");
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
check((await text(`${visible} [data-testid="db-chip"] [data-testid="conn-chip-name"]`)) === "wallet", "window opens on the saved database");

// 2. ⇧⌘D lists databases with sizes; Enter switches this window.
await page.keyboard.press("Control+Shift+D");
await page.waitForSelector('[data-testid="db-option"]');
check((await page.locator('[data-testid="db-option"]').count()) === 5, "database list shows 5 databases");
await page.keyboard.type("ord");
await shot("1-database-switcher", top);
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
// The schema head's serif name is the database.
check((await text(`${visible} [data-testid="db-chip"] [data-testid="conn-chip-name"]`)) === "orders", "database chip now reads orders");
const sidebarText = await text(`${visible} [data-testid="sb-scroll"]`);
check(sidebarText.includes("refunds") && !sidebarText.includes("ledger_entries"), "sidebar shows the orders tables");
const opens = await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "open_window").map(([, a]) => a.database));
check(opens.at(-1) === "orders", "switch re-opened the window on orders");
await runSql();
await shot("2-prd-orders", top);

// 3. ⌘T opens a new empty window (Connect to start); its list connects it.
await page.keyboard.press("Control+t");
await page.waitForSelector(`${visible} [data-empty-window]`);
check((await page.locator('[data-testid="win-tab"]').count()) === 2 && (await page.$('[data-testid="win-tab"][data-on][data-empty]')) !== null, "⌘T opened an empty window and showed it");
await shot("3-new-window-empty", top);
await page.click(`${visible} [data-saved-conn="stg"]`);
await page.waitForTimeout(250);
check((await page.locator('[data-testid="win-tab"]').count()) === 2, "two window tiles");
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "stg", "new window is the stg connection");
await page.click(`${visible} [data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT 'stg only';");
await runSql();
const stgCell = await text(`${visible} [data-testid="results-grid-wrap"]`);
check(stgCell.includes("wallet-api (stg)") && stgCell.includes("wallet"), "stg window runs on its own session");

// 4. ⌘1 / ⌘2 switch windows; each keeps its editor and results.
await page.keyboard.press("Control+1");
await page.waitForTimeout(150);
check((await page.getAttribute('[data-testid="win-tab"][data-on]', "data-env")) === "prd", "⌘1 shows the prd window");
check((await text(`${visible} [data-testid="results-grid-wrap"]`)).includes("orders"), "prd window kept its orders result");
check(!(await page.inputValue(`${visible} [data-testid="sql-editor"]`)).includes("stg only"), "prd editor untouched");
await shot("4-two-windows", top);
await page.keyboard.press("Control+2");
await page.waitForTimeout(150);
check((await page.inputValue(`${visible} [data-testid="sql-editor"]`)).includes("stg only"), "⌘2 brings back the stg editor");

// 5. ⌘↵ in the database list opens it in a new window.
await page.keyboard.press("Control+Shift+D");
await page.waitForSelector('[data-testid="db-option"]');
await page.keyboard.type("pay");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(250);
check((await page.locator('[data-testid="win-tab"]').count()) === 3, "⌘↵ opened payments in a third window");
check((await text(`${visible} [data-testid="db-chip"] [data-testid="conn-chip-name"]`)) === "payments", "third window is on payments");
await shot("5-three-windows", top);

// 6. ⇧⌘W closes it.
await page.keyboard.press("Control+Shift+W");
// It closes at once with an Undo toast; the tile narrows away first (motion.tsx).
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2, null, { timeout: 1000 }).catch(() => {});
check((await page.locator('[data-testid="win-tab"]').count()) === 2, "⇧⌘W closed the window");
check((await page.$("[data-toast-undo]")) !== null, "closing offers Undo in a toast");
const closed = await page.evaluate(() => window.__ROWKERY_CALLS__.some(([c]) => c === "close_window"));
check(closed, "closing told the core to drop the window");

// 7. Relaunch restores both windows but only connects the one shown.
await page.reload();
await page.waitForSelector(`${visible} [data-testid="sb-scroll"]`);
await page.waitForTimeout(300);
check((await page.locator('[data-testid="win-tab"]').count()) === 2, "windows restored on relaunch");
const reopened = await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "open_window").length);
check(reopened === 1, `only the visible window connected on relaunch (${reopened})`);
await page.keyboard.press("Control+1");
await page.waitForTimeout(300);
check((await text(`${visible} [data-testid="db-chip"] [data-testid="conn-chip-name"]`)) === "orders", "prd window restored on orders");

// 8. SQLite windows hide the database chip.
await page.keyboard.press("Control+Shift+O");
await page.keyboard.type("analytics");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
check((await text(`${visible} [data-testid="conn-chip"] [data-testid="conn-chip-name"]`)) === "analytics-cache", "window switched to the SQLite connection");
check((await page.locator(`${visible} [data-testid="db-chip"]`).count()) === 0, "no database chip on SQLite");

await browser.close();
