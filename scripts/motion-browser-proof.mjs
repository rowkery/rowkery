#!/usr/bin/env node
// Motion proof without a Tauri webview or Postgres: serves the Vite frontend
// with a stubbed Tauri `invoke`, plays every animation 10× slower (CDP
// Animation.setPlaybackRate) and captures frames mid-exit: the connection and
// database pickers, ⌘K, the New Connection sheet and query tabs. Then checks
// Reduce Motion closes things at once. Window pills don't animate in or out.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/motion-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/motion";
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

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const shot = async (name, clip) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`${OUT}/${name}.png`);
};
const opacity = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Number(getComputedStyle(el).opacity) : null;
  }, sel);
const gone = (sel, ms = 4000) =>
  page.waitForSelector(sel, { state: "detached", timeout: ms }).then(
    () => true,
    () => false,
  );
const top = { x: 0, y: 0, width: 1280, height: 380 };
const visible = '[data-testid="workspace"]:not([hidden])';

// Connect at full speed, then slow every animation down 10×.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Animation.enable");
await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
const SLOW = 10;

// 1. Connection picker: Esc plays the exit instead of vanishing.
await page.keyboard.press("Control+Shift+O");
await page.waitForTimeout(140 * SLOW + 200);
await shot("1a-picker-open", top);
await page.keyboard.press("Escape");
await page.waitForTimeout(45 * SLOW);
const pickerMid = await opacity('[data-closing] [data-testid="conn-popover"]');
check(pickerMid !== null && pickerMid > 0 && pickerMid < 1, `picker is mid-exit after Esc (opacity ${pickerMid?.toFixed(2)})`);
await shot("1b-picker-closing", top);
check(await gone('[data-testid="conn-popover"]'), "picker unmounts once its exit ends");
await page.keyboard.press("Control+Shift+O");
await page.waitForTimeout(140 * SLOW);
await page.keyboard.type("stg");
await page.keyboard.press("Escape");
await page.waitForTimeout(30 * SLOW);
await page.keyboard.press("Control+Shift+O");
await page.waitForTimeout(100);
const reopened = await page.evaluate(() => ({
  count: document.querySelectorAll('[data-testid="conn-popover"]').length,
  focused: document.activeElement?.matches('[data-testid="conn-popover"] input') ?? false,
  query: document.querySelector('[data-testid="conn-popover"] input')?.value,
}));
check(reopened.count === 1 && reopened.focused && reopened.query === "", "reopening mid-exit gives a fresh, focused picker");
await page.keyboard.press("Escape");
await gone('[data-testid="conn-popover"]');

// 2. Database change: the picker exits and the name rolls to the new one.
await page.keyboard.press("Control+Shift+D");
await page.waitForSelector('[data-testid="db-option"]');
await page.waitForTimeout(140 * SLOW);
await page.keyboard.type("ord");
await page.keyboard.press("Enter");
await page.waitForTimeout(60 * SLOW);
// The schema head names the database, so its chip rolls.
// Class on purpose: .roll-out is the roll animation under test.
check((await page.locator('[data-testid="db-chip"] .roll-out').count()) === 1, "old database name is rolling out");
check((await page.locator('[data-closing] [data-testid="db-popover"]').count()) === 1, "database picker is playing its exit");
await shot("2-database-rolling", top);
check(await gone('[data-testid="db-chip"] .roll-out'), "roll finishes");
check((await page.textContent('[data-testid="db-chip"] [data-testid="conn-chip-name"]'))?.trim() === "orders", "chip reads orders after the roll");

// 3. ⌘K palette.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.waitForTimeout(150 * SLOW);
await page.keyboard.press("Escape");
await page.waitForTimeout(50 * SLOW);
const palMid = await opacity('[data-closing] [data-testid="cp-panel"]');
check(palMid !== null && palMid > 0 && palMid < 1, `palette is mid-exit (opacity ${palMid?.toFixed(2)})`);
await shot("3-palette-closing");
check(await gone('[data-testid="cp-scrim"]'), "palette unmounts after its exit");
await page.keyboard.press("Control+k");
check((await page.inputValue('[data-testid="cp-search"] input')) === "", "palette reopens empty");
await page.keyboard.press("Escape");
await gone('[data-testid="cp-scrim"]');

// 4. New Connection sheet lifts away.
await page.keyboard.press("Control+n");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.waitForTimeout(200 * SLOW);
await page.keyboard.press("Escape");
await page.waitForTimeout(60 * SLOW);
const sheetMid = await opacity('[data-closing] [data-testid="nc-sheet"]');
check(sheetMid !== null && sheetMid > 0 && sheetMid < 1, `sheet is mid-exit (opacity ${sheetMid?.toFixed(2)})`);
await shot("4-sheet-closing");
check(await gone('[data-testid="nc-overlay"]'), "sheet unmounts after its exit");

// 5. A closed query tab narrows away.
await page.click(`${visible} [data-testid="query-tab-add"]`);
await page.waitForTimeout(200 * SLOW);
await page.click(`${visible} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-close"]`);
await page.waitForTimeout(70 * SLOW);
check((await page.locator(`${visible} [data-testid="query-tab"][aria-hidden]`).count()) === 1, "closed query tab narrows away");
const strip = await page.locator(`${visible} [data-testid="query-tab"]`).first().boundingBox();
await shot("5-query-tab-closing", { x: Math.max(0, strip.x - 40), y: Math.max(0, strip.y - 12), width: 700, height: strip.height + 24 });
check(await gone(`${visible} [data-testid="query-tab"][aria-hidden]`), "closed query tab leaves");

// 6. Reduce Motion: closing is immediate. Esc and the click are sent inside
// the page and checked in the same task, before any frame, so there's no exit
// to wait for (a 100 ms poll from here flaked under load).
await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
await page.emulateMedia({ reducedMotion: "reduce" });
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
const closedAtOnce = await page.evaluate(async () => {
  const init = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return document.querySelector('[data-testid="conn-popover"]') === null;
});
check(closedAtOnce, "Reduce Motion: picker closes at once");
await page.click(`${visible} [data-testid="query-tab-add"]`);
await page.waitForTimeout(100);
const tabClosedAtOnce = await page.evaluate(async (ws) => {
  const before = document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length;
  document.querySelector(`${ws} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-close"]`).click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return document.querySelectorAll(`${ws} [data-testid="query-tab"]`).length === before - 1;
}, visible);
check(tabClosedAtOnce, "Reduce Motion: query tab closes at once");

await browser.close();
