#!/usr/bin/env node
// MCP switch proof with a stubbed Tauri `invoke`: the New Connection sheet
// has an "Allow MCP" switch that starts off, saving sends `allow_mcp` and
// opens Edit access (nothing is ticked yet), ⌘K
// toggles it for the active connection and opens Connect an agent.
// The server itself is proved against Postgres and SQLite by the
// rowkery-mcp crate (`cargo run -p rowkery-mcp --example stdio`).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mcp-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp";
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
          return Array.from({ length: 30 }, (_, i) => ({
            name: `tenant_${String(i + 1).padStart(2, "0")}`,
            size_bytes: 1_000_000 * (i + 1),
          }));
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 12 };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "delete_connection": {
          const i = connections.findIndex((c) => c.id === args.id);
          if (i >= 0) connections.splice(i, 1);
          return null;
        }
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const sheet = '[data-testid="nc-sheet"]';
const mcpSwitch = "[data-mcp-switch]";
const lastSave = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([cmd]) => cmd === "save_connection").at(-1)?.[1]?.connection);

await page.keyboard.press("Control+n");
await page.waitForSelector(sheet);
check(!(await page.isChecked(mcpSwitch)), "Allow MCP starts off");
await page.fill('[data-testid="nc-input"] >> nth=0', "postgres://app@db.internal:5432/shop");
await page.locator(mcpSwitch).scrollIntoViewIfNeeded();
await page.locator(mcpSwitch).check();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/1-sheet-switch-on.png`, clip: await page.locator(sheet).boundingBox() });
await page.keyboard.press("Control+Enter");
await page.waitForSelector(sheet, { state: "detached" });
const saved = await lastSave();
check(saved?.allow_mcp === true, `saved allow_mcp ${saved?.allow_mcp}`);
// Shared here with no tables yet: Edit access opens to pick them.
await page.waitForSelector(`[data-mcp-editor="${saved?.id}"]`);
check(true, "first share from the sheet opens Edit access on that connection");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-mcp-editor]", { state: "detached" });
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="agents-page"]', { state: "detached" });

const palette = async (text) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
};
// The new connection is active and already shared, so ⌘K offers to stop.
await palette("Stop sharing");
await page.screenshot({ path: `${OUT}/2-palette.png` });
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const toggled = await lastSave();
check(toggled?.allow_mcp === false, `⌘K stop sharing saves ${toggled?.name} with allow_mcp ${toggled?.allow_mcp}`);

// ⌘K offers Connect an agent (its flows: mcp-connect-browser-proof.mjs).
await palette("Connect Claude");
await page.keyboard.press("Enter");
await page.waitForSelector("[data-mc-sheet]");
check(true, "⌘K Connect Claude opens the Connect an agent sheet");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-mc-sheet]", { state: "detached" });

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
