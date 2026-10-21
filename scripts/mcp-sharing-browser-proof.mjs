#!/usr/bin/env node
// MCP sharing controls proof with a stubbed Tauri `invoke`: in ⌘K MCP
// access a shared connection can be shared for an hour or for today (saves
// mcp_until); a share whose time runs out stops on its own
// (toast, the row reads "Sharing ended", the sheet's switch reads off).
// The server's side (hidden tables refused through joins, views and CTEs,
// expired shares unlisted) is proved by `cargo test -p rowkery-mcp`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mcp-sharing-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp-sharing";
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
    pg("prd", "payments-prod", "payments.db.internal", "prd", false),
    { ...pg("stg", "analytics-stg", "10.0.12.7", "stg", true), mcp_until: Date.now() + 4000 },
  ];
  const t0 = Date.now();
  const session = t0 - 150_000;
  const at = (s) => t0 - s * 1000;
  const base = { session, client: "claude-code" };
  const log = [
    { ...base, ts: at(140), tool: "list_connections", rows: 1, ms: 1, verdict: "ok" },
    { ...base, ts: at(130), tool: "describe_table", connection: "local", database: "kioskuno-wallet", target: "public.failed_jobs", ms: 2, verdict: "ok" },
    {
      ...base,
      ts: at(110),
      tool: "query",
      connection: "local",
      database: "kioskuno-wallet",
      sql: "select * from wallet_transactions where payload::text like '%failed%'",
      verdict:
        "Refused: the plan reads public.wallet_transactions (~412880 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
    },
    {
      ...base,
      ts: at(80),
      tool: "query",
      connection: "local",
      database: "kioskuno-wallet",
      sql: "select queue, count(*) failed, min(failed_at)::date first_failure, max(failed_at)::date last_failure\nfrom failed_jobs group by queue order by failed desc",
      rows: 6,
      ms: 38,
      verdict: "ok",
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
  window.__MCP_NEXT__ = [];
  let offset = 0;
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
          const database = args.database ?? c.database;
          windows[args.windowId] = { conn: c, database };
          await new Promise((r) => setTimeout(r, 40));
          return { database, catalog: catalogFor(database), elapsed_ms: 40 };
        }
        case "close_window":
          delete windows[args.windowId];
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
          const next = window.__MCP_NEXT__.splice(0);
          log.push(...next);
          offset = log.length;
          return { entries: next, offset, reset: false };
        }
        case "mcp_clear_activity":
          log.length = 0;
          offset = 0;
          return null;
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
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
const palette = async (text) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
};
const calls = (name) => page.evaluate((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === n), name);

// Connect to the shared local database (its schema feeds the hide picker).
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const lastSave = async () => (await calls("save_connection")).at(-1)?.[1]?.connection;

await palette("MCP access");
await page.waitForSelector('[data-testid="agents-sharing"]');
check(await page.isChecked('[data-mcp-allow="stg"]'), "a share with time left reads on");
check(
  /until \d|until midnight/.test((await page.textContent('[data-mcp-conn="stg"] [data-testid="mcp-cn-sub"]')) ?? ""),
  "and says until when",
);

// 1. Share for an hour.
const before = Date.now();
await page.click('[data-mcp-conn="local"] [data-mcp-duration="hour"]');
await page.waitForTimeout(300);
let saved = await lastSave();
const left = (saved?.mcp_until ?? 0) - before;
check(saved?.id === "local" && left > 3_590_000 && left < 3_610_000, `1 hour saves mcp_until ${left} ms ahead`);
// A first share opens Edit access in place of the cards; Esc returns to them.
if (await page.$("[data-mcp-editor]")) {
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-mcp-editor]", { state: "detached" });
}
await page.waitForSelector('[data-mcp-conn="local"] [data-mcp-duration="hour"]');
check(
  /until \d|until midnight/.test((await page.textContent('[data-mcp-conn="local"] [data-testid="mcp-cn-sub"]')) ?? ""),
  "the row says until when",
);
const picked = () => page.$$eval('[data-mcp-conn="local"] [data-mcp-duration][aria-checked="true"]', (els) => els.map((e) => e.dataset.mcpDuration).join());
check((await picked()) === "hour", `1 hour shows as picked (${await picked()})`);
await page.click('[data-mcp-conn="local"] [data-mcp-duration="today"]');
await page.waitForFunction(() => document.querySelector('[data-mcp-conn="local"] [data-mcp-duration="today"]')?.getAttribute("aria-checked") === "true", null, { timeout: 2000 }).catch(() => {});
check((await picked()) === "today", `Today shows as picked (${await picked()})`);
await page.click('[data-mcp-conn="local"] [data-mcp-duration="off"]');
await page.waitForTimeout(300);
saved = await lastSave();
check(saved?.mcp_until == null && saved?.allow_mcp === true, "Until turned off clears the limit");
check((await picked()) === "off", `Until turned off shows as picked (${await picked()})`);

// 2. Which tables are shared is picked in Edit access (agents-access-browser-proof.mjs).
await shot("1-access-controls");

// 3. The staging share runs out on its own.
await page.waitForFunction(
  () => /Stopped sharing with agents/.test(document.querySelector("[data-toast]")?.textContent ?? ""),
  null,
  { timeout: 8000 },
);
check(true, "a toast says the share stopped");
await page.waitForSelector('[data-mcp-conn="stg"]:not([data-shared])');
check(
  /Sharing ended/.test((await page.textContent('[data-mcp-conn="stg"] [data-testid="mcp-cn-sub"]')) ?? ""),
  "the row says sharing ended",
);
check(!(await page.isChecked('[data-mcp-allow="stg"]')), "its switch reads off");
await shot("2-share-ended");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
