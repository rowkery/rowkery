#!/usr/bin/env node
// Toast proof without a Tauri webview (stubbed `invoke`): ⌘C on a result
// cell, ⌘K "Copy results as CSV" and "Set environment" each show the capsule
// at the foot of the window with what happened; it fades on its own, a new
// one replaces the old, and Reduce Motion drops its animation.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/toast-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/toast";
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
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const names = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov", "Ken Thompson", "Margaret Hamilton", "Donald Knuth", "Frances Allen", "John McCarthy", "Radia Perlman", "Leslie Lamport", "Tony Hoare", "Niklaus Wirth"];
  // A fresh object so the frames shim wraps this invoke too.
  window.__TAURI_INTERNALS__ = { ...window.__TAURI_INTERNALS__, __framesShim: false, invoke: async (cmd, args) => {
    if (cmd === "save_connection" || cmd === "delete_connection") return null;
    if (cmd !== "run_query") return inv(cmd, args);
    return {
      columns: [
        { name: "id", type_name: "int8" },
        { name: "owner", type_name: "text" },
        { name: "email", type_name: "text" },
        { name: "balance", type_name: "numeric" },
        { name: "active", type_name: "bool" },
      ],
      rows: names.map((n, i) => [
        { Int: 1001 + i },
        { Text: n },
        { Text: n.split(" ")[0].toLowerCase() + "@kioskuno.com" },
        { Text: (i * 173.25 + 12.5).toFixed(2) },
        { Bool: i % 4 !== 2 },
      ]),
      row_count: names.length,
      elapsed_ms: 12,
      error: null,
      cancelled: false,
    };
  } };
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "prd", database: "wallet" }, { connectionId: "local", database: "rowkery" }], active: 1 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(visible + '[data-conn-state="connected"]');
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.type("SELECT id, owner, email, balance, active FROM wallets;");
await page.click(visible + ' [data-testid="run-btn"]');
await page.waitForSelector(visible + " [data-row]");
const card = await page.locator(visible + ' [data-testid="results-card"]').boundingBox();
const clip = { x: card.x - 8, y: card.y - 8, width: card.width + 16, height: card.height + 16 };
const toastText = () => page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent).join("")).catch(() => null);

// 1. ⌘C / Ctrl+C on a cell.
await page.locator(visible + " [data-row]").nth(1).locator("[data-col]").nth(2).click();
await page.keyboard.press("Control+c");
await page.waitForTimeout(200);
check((await page.evaluate(() => navigator.clipboard.readText())) === "grace@kioskuno.com", "the cell is on the clipboard");
check((await toastText()) === "Copiedgrace@kioskuno.com", "toast: Copied grace@kioskuno.com");
await page.screenshot({ path: `${OUT}/1-copied-cell.png`, clip });
console.log(`${OUT}/1-copied-cell.png`);

// 2. It fades on its own.
await page.waitForTimeout(2900);
check((await page.locator("[data-toast]").count()) === 0, "the toast is gone after about 2.6s");

// 3. Copy results as CSV from ⌘K.
await page.keyboard.press("Control+k");
await page.keyboard.type(">copy results as csv");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check((await toastText()) === "Copied 14 rowsCSV", "toast: Copied 14 rows · CSV");
check((await page.evaluate(() => navigator.clipboard.readText())).startsWith("id,owner,email"), "CSV is on the clipboard");
await page.screenshot({ path: `${OUT}/2-copied-rows.png`, clip });
console.log(`${OUT}/2-copied-rows.png`);

// 4. A second copy replaces the first instead of stacking.
await page.locator(visible + " [data-row]").nth(3).locator("[data-col]").nth(1).click();
await page.keyboard.press("Control+c");
await page.waitForTimeout(200);
check((await page.locator("[data-toast]:not([data-closing] *)").count()) === 1, "one toast at a time");
check((await toastText()) === "CopiedEdsger Dijkstra", "toast shows the newest copy");

// 5. Setting an environment from ⌘K.
await page.waitForTimeout(2900);
await page.keyboard.press("Control+k");
await page.keyboard.type(">set environment staging");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check((await toastText()) === "Marked StagingDocker Postgres", "toast: Marked Staging · Docker Postgres");
await page.screenshot({ path: `${OUT}/3-environment.png`, clip });
console.log(`${OUT}/3-environment.png`);

// 6. Reduce Motion: no entry animation.
await page.emulateMedia({ reducedMotion: "reduce" });
await page.waitForTimeout(2900);
await page.locator(visible + " [data-row]").nth(0).locator("[data-col]").nth(0).click();
await page.keyboard.press("Control+c");
await page.waitForTimeout(50);
const anim = await page.locator("[data-toast]").evaluate((e) => getComputedStyle(e).animationName);
check(anim === "none", `Reduce Motion: no toast animation (${anim})`);

await browser.close();
