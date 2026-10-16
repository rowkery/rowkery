#!/usr/bin/env node
// Issue #208: on the Agents page, macOS menu bar picks did nothing (the shown
// window took no commands while the page was up), so Help > Report an Issue…,
// File > New Connection… and the rest never opened. Proof with a stubbed
// Tauri `invoke`, sending `rowkery:command` as main.tsx does for a menu pick:
// a pick that opens a sheet opens it over the page and keeps the page;
// a pick that works on the window (New Query Tab) leaves the page first;
// Run never starts a query from the page; File > Close Tab closes the page,
// not a query tab.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agents-menu-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agents-menu";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const TABLES = ["failed_jobs", "jobs", "migrations", "players", "wallet_transactions"];
  const catalogFor = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: TABLES.map((name, i) => ({
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
  const pg = (id, name, host, environment, allow) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: name,
    username: "app",
    environment,
    allow_mcp: allow,
  });
  const connections = [
    pg("local", "kioskuno-wallet", "localhost", "local", true),
    pg("prd", "payments-prod", "payments.db.internal", "prd", true),
    pg("stg", "analytics-stg", "10.0.12.7", "stg", false),
  ];
  const t0 = Date.now();
  const session = t0 - 150_000;
  const at = (s) => t0 - s * 1000;
  const base = { session, client: "claude-code" };
  const log = [
    { ...base, ts: at(140), tool: "list_connections", rows: 2, ms: 1, verdict: "ok" },
    { ...base, ts: at(130), tool: "describe_table", connection: "prd", database: "payments-prod", target: "public.payouts", ms: 2, verdict: "ok" },
    {
      ...base,
      ts: at(110),
      tool: "query",
      connection: "prd",
      database: "payments-prod",
      sql: "select status, count(*) from payouts where created_at > now() - interval '1 day' group by status",
      rows: 4,
      ms: 61,
      verdict: "ok",
    },
    {
      ...base,
      ts: at(80),
      tool: "query",
      connection: "local",
      database: "kioskuno-wallet",
      sql: "select * from wallet_transactions where payload::text like '%failed%'",
      verdict:
        "Refused: the plan reads public.wallet_transactions (~412880 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
    },
    {
      ...base,
      ts: at(20),
      tool: "query",
      connection: "local",
      database: "kioskuno-wallet",
      sql: "select migration, batch from migrations order by batch, id",
      rows: 15,
      ms: 4,
      verdict: "ok",
    },
  ];
  let offset = 0;
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
          const database = args.database ?? c.database;
          await new Promise((r) => setTimeout(r, 40));
          return { database, catalog: catalogFor(database), elapsed_ms: 40 };
        }
        case "close_window":
          return null;
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          else connections.push(args.connection);
          return null;
        }
        case "mcp_activity": {
          if (args.since == null || args.since > offset) {
            offset = log.length;
            return { entries: structuredClone(log), offset, reset: true };
          }
          return { entries: [], offset, reset: false };
        }
        case "mcp_sample":
          return null;
        case "mcp_connect_check":
          return {
            client: args.client,
            state: "ready",
            preview:
              args.client === "claude-code"
                ? "claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp"
                : '"rowkery": { "command": "/Applications/Rowkery.app/Contents/MacOS/Rowkery", "args": ["--mcp"] }',
            copy: "claude mcp add --scope user rowkery -- /Applications/Rowkery.app/Contents/MacOS/Rowkery --mcp",
            existing: null,
            config_file: null,
            problem: null,
          };
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "run_query":
          return { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
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
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const ws = '[data-testid="workspace"]:not([hidden])';
const pageSel = '[data-testid="agents-page"]';
const calls = (name) => page.evaluate((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === n), name);

// Connect to the shared local database, so the page sits over a real window.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// Connect to the shared local database, so the page sits over a real window.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const menu = (id) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: d })), id);
const openPage = async () => {
  await page.click('[data-testid="sb-agents"]');
  await page.waitForSelector(pageSel);
};
const tabCount = () => page.$$eval(`${ws} [data-testid="query-tab"]`, (els) => els.length);
await openPage();

// 1. Help > Report an Issue… opens over the page; Esc closes it and keeps the page.
await menu("report-issue");
check(!!(await page.waitForSelector('[data-testid="rp-sheet"]', { timeout: 2000 }).catch(() => null)), "Report an Issue… opens on the Agents page");
check(!!(await page.$(pageSel)), "the page stays under it");
await shot("1-report-over-page");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="rp-sheet"]', { state: "detached" });
check(!!(await page.$(pageSel)), "Esc closes the report and keeps the page");

// 2. Keyboard Shortcuts and New Connection… open there too.
await menu("keyboard-shortcuts");
check(!!(await page.waitForSelector('[data-testid="ks-list"]', { state: "attached", timeout: 2000 }).catch(() => null)), "Keyboard Shortcuts opens on the Agents page");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ks-list"]', { state: "detached" });
await menu("new-connection");
check(!!(await page.waitForSelector('[data-testid="nc-sheet"]', { timeout: 2000 }).catch(() => null)), "New Connection… opens on the Agents page");
check(!!(await page.$(pageSel)), "the page stays beside New connection");
await shot("2-new-connection-beside-page");
await page.click('[data-testid="nc-sheet"] [aria-label="Close"]').catch(() => page.keyboard.press("Escape"));
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });
if (!(await page.$(pageSel))) await openPage();

// 3. Run never starts a query from the page.
const runsBefore = (await calls("run_query")).length + (await calls("run_window_query")).length;
await menu("run");
await page.waitForTimeout(300);
const runsAfter = (await calls("run_query")).length + (await calls("run_window_query")).length;
check(runsAfter === runsBefore && !!(await page.$(pageSel)), "Run does nothing on the page");

// 4. File > Close Tab closes the page, not a query tab.
const tabs = await tabCount();
await page.focus(pageSel);
await menu("close-tab");
await page.waitForSelector(pageSel, { state: "detached" });
check((await tabCount()) === tabs, `Close Tab closes the page and keeps the ${tabs} query tab(s)`);

// 5. A window command (New Query Tab) leaves the page, then runs.
await openPage();
await menu("new-tab");
await page.waitForSelector(pageSel, { state: "detached" });
await page.waitForTimeout(200);
check((await tabCount()) === tabs + 1, "New Query Tab leaves the page and opens a tab");
check(await page.isVisible(`${ws} [data-testid="main"]`), "the editor and grid are back");
await shot("3-new-tab-left-page");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
