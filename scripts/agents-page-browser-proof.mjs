#!/usr/bin/env node
// Agents page proof with a stubbed Tauri `invoke`: the schema column's Agents
// button (and ⌘⇧A, and ⌘K Agents) opens the page in place of the schema column,
// editor and grid, with the title bar still there (no Click a table hint
// under the tables); the page shows what agents
// can reach and the log at once, each activity row carrying its
// connection's environment tag; Stop all sharing turns every shared
// connection off in one go; What can the agent do opens a sheet over the
// page (Esc closes it first); Connect an agent opens inline under the head
// and Esc closes it first, then the page; ⌘K still works on the page; a
// narrow window stacks the two columns. The log, switches and samples
// themselves are proved by mcp-activity-browser-proof.mjs and
// mcp-sharing-browser-proof.mjs on this same page. 2026-10-15: the agents'
// sessions tool is in Available tools and its log row counts sessions.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agents-page-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agents-page";
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
    { ...base, ts: at(50), tool: "sessions", connection: "prd", database: "payments-prod", rows: 3, ms: 3, verdict: "ok" },
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

// The schema column has no hint under its tables (2026-10-14).
check(!(await page.$('[data-testid="sb-foot"]')), "no Click a table hint under the tables");

// 1. The foot's Agents row opens the page; the title bar stays; the schema
// column, editor and grid are out of sight (2026-10-14).
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector(pageSel);
check(await page.isVisible('[data-testid="titlebar"]'), "the title bar stays while the page is up");
check(!(await page.isVisible('[data-testid="workspace"]:not([hidden]) [data-testid="sidebar"] [data-testid="sb-head"]')), "the schema column is hidden while the page is up");
check((await page.$eval(pageSel, (el) => el.getBoundingClientRect().left)) === 0, "the page starts at the window's left edge");
check(!(await page.isVisible(`${ws} [data-testid="main"]`)), "the editor and grid are out of sight");
check(
  (await page.getAttribute(pageSel, "data-mcp-sheet")) === "activity",
  "with a log, the page lands on the activity half",
);
await shot("1-page");

// 2. Both halves are on screen at once: access rows and the log; each row says its environment.
check((await page.$$("[data-mcp-conn]")).length === 3, "every connection is listed under Shared with agents");
check(await page.isChecked('[data-mcp-allow="prd"]'), "production shows as shared");
const envTags = await page.$$eval("[data-mcp-entry] .mcp-tag", (els) => els.map((el) => el.getAttribute("data-env")));
check(
  JSON.stringify(envTags) === JSON.stringify(["local", "prd", "local", "prd", "prd"]),
  `each activity row carries its connection's environment: ${envTags.join(", ")}`,
);
const prdStats = await page.textContent('[data-mcp-conn="prd"] [data-testid="mcp-cn-stats"]');
check(/3 calls today/.test(prdStats ?? ""), `a shared connection says what agents did on it today: ${prdStats}`);
const sessionsRow = await page.textContent('[data-tool="sessions"]');
check(/3 sessions/.test(sessionsRow ?? ""), `a sessions call says how many it showed: ${sessionsRow}`);
// What the agent can and can't do sits behind one button: a sheet over the
// page; Esc closes the sheet first and keeps the page.
check(!(await page.$('[data-testid="ag-can-do"]')), "the left column has no explainer text, only cards");
await page.click("[data-ag-can-do]");
await page.waitForSelector('[data-testid="ag-can-do"] [role="dialog"]');
check((await page.$$('[data-ag-panel] li')).length === 10, "What can the agent do lists five can and five can't");
check((await page.$$('[data-ag-panel] li svg')).length === 10, "each line carries an icon");
check(/tick every table it reads/.test(await page.textContent("[data-ag-join-note]")), "it says a view or join needs every table it reads ticked");
const tools = await page.$$eval(".ag-tools code", (els) => els.map((el) => el.textContent));
check(tools.includes("sessions"), `Available tools lists sessions: ${tools.join(", ")}`);
await shot("1b-can-do");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ag-can-do"]', { state: "detached" });
check(!!(await page.$(pageSel)), "Esc closes the sheet and keeps the page");

// 3. Access / Activity move the focus, not the page.
// Paper (2026-10-10): the segment shows only when the columns stack (it
// jumps between them), so this step runs in a narrower window.
check((await page.$('[data-mcp-tab]')) === null, "side by side: no Access | Activity segment");
await page.setViewportSize({ width: 860, height: 800 });
await page.waitForSelector(`${pageSel}[data-stacked] [data-mcp-tab="access"]`);
check(true, "stacked: the segment appears");
await page.click('[data-mcp-tab="access"]');
check((await page.getAttribute(pageSel, "data-mcp-sheet")) === "access", "Access marks the page's section");
check(
  await page.evaluate(() => document.activeElement?.getAttribute("data-mcp-allow") === "local"),
  "Access puts the keyboard on the first switch",
);
await page.click('[data-mcp-tab="activity"]');
check(
  await page.evaluate(() => document.activeElement?.classList.contains("mcp-list")), // Class on purpose: the list owns ↑↓ ↵.
  "Activity puts the keyboard on the log",
);
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForSelector('[data-testid="agents-page"]:not([data-stacked])');

// 4. Stop all sharing turns every shared connection off in one go.
await page.click("[data-ag-stop-all]");
await page.waitForFunction(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").length >= 2, null, { timeout: 4000 });
const saves = (await calls("save_connection")).map(([, a]) => [a.connection.id, a.connection.allow_mcp]);
check(
  saves.some(([id, on]) => id === "local" && on === false) && saves.some(([id, on]) => id === "prd" && on === false),
  `Stop all sharing saved allow_mcp false for local and prd: ${JSON.stringify(saves)}`,
);
await page.waitForSelector('[data-mcp-conn="prd"]:not([data-shared])');
check(!(await page.$("[data-ag-stop-all]")), "with nothing shared the button goes away");
const toast = await page.textContent("[data-toast]");
check(/Stopped sharing with MCP/.test(toast ?? "") && /2 connections/.test(toast ?? ""), `one toast: ${toast?.trim()}`);
await shot("2-stopped");

// 5. Connect an agent opens inline under the head; Esc closes it first, then the page.
await page.click("[data-mcp-connect]");
await page.waitForSelector(`${pageSel} [data-testid="ag-connect"] [data-mc-sheet]`);
check(!(await page.$(".mcp-overlay")), "Connect an agent is inline, not a sheet over the page"); // Class on purpose: the sheet's scrim.
await page.waitForSelector('[data-mc-state="ready"]');
await shot("3-connect-inline");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-mc-sheet]", { state: "detached" });
check(!!(await page.$(pageSel)), "Esc closes Connect an agent and keeps the page");

// 6. ⌘K works on the page; its Agents command is where it lands too.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">agents");
await page.waitForTimeout(200);
check(!!(await page.$('[data-item="cmd:agents"]')), "⌘K lists Agents");
// The palette's first Esc clears the typed text; the second closes it.
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="cp-panel"]', { state: "detached" });
check(!!(await page.$(pageSel)), "closing ⌘K keeps the page");

// 7. Esc returns to the window; the Agents button goes dark; the chord brings the page back.
await page.focus(pageSel);
await page.keyboard.press("Escape");
await page.waitForSelector(pageSel, { state: "detached" });
check(await page.isVisible(`${ws} [data-testid="main"]`), "Esc returns to the editor and grid");
check((await page.getAttribute('[data-testid="sb-agents"]', "data-on")) === null, "the Agents row goes dark");
await page.keyboard.press("Control+Shift+A");
await page.waitForSelector(pageSel);
check(true, "⌘⇧A opens the page");
await page.keyboard.press("Escape");
await page.waitForSelector(pageSel, { state: "detached" });

// 8. A tile's MCP tag opens the page too.
await page.click('[data-testid="win-tab"][data-on] [data-testid="win-mcp"]');
await page.waitForSelector(pageSel);
check(true, "the tile's MCP tag opens the page");

// 9. Narrow: one column, the page scrolls as a whole.
// The page spans the window now (no schema column beside it), so it stacks under 900 px.
await page.setViewportSize({ width: 860, height: 760 });
await page.waitForTimeout(300);
const stacked = await page.evaluate(() => {
  const access = document.querySelector('[data-testid="mcp-map"]')?.getBoundingClientRect();
  const log = document.querySelector('[data-testid="agents-page"] .mcp-list')?.getBoundingClientRect(); // Class on purpose: the list's box.
  return !!access && !!log && log.top >= access.bottom && Math.abs(log.left - access.left) < 2;
});
check(stacked, "narrow window stacks the halves: the log sits under the switches, at the same left edge");
await shot("4-narrow");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
