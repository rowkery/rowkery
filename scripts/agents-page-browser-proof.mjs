#!/usr/bin/env node
// Agents page proof with a stubbed Tauri `invoke` (2026-10-17: the page is
// proposals and the log; sharing is Settings › Agents). The schema column's
// Agents button, ⌘⇧A and the shown pill's agent mark open the page in place
// of the schema column, editor and grid, with the title bar still there and
// holding still as the page rises in; the
// head's first control names the window it goes back to, the pill's mark
// reads as pressed, and each of them (and Esc) goes back. With nothing
// waiting it lands on the newest call: the log newest first, an env dot per
// row, ↓ moves, Refused narrows it, ↵ opens a query's SQL in the window.
// Its foot's Sharing opens Settings › Agents: the cards, What can the agent
// do (Esc closes it first), Connect an agent inline (Esc closes it first),
// Stop all sharing in one go; ⌘K Connect lands there too. Proposals are
// proved by proposals-browser-proof.mjs, the log's detail by
// mcp-activity-browser-proof.mjs, the switches by mcp-sharing-browser-proof.mjs.
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
// column, editor and grid are out of sight (2026-10-14). Nothing waits, so
// it lands on the newest call (2026-10-17: the page is proposals and the log).
// The title bar holds still while the page rises in (2026-10-17: focusing
// the page mid-rise used to scroll the frame and lift the bar by 8 px).
await page.evaluate(() => {
  window.__barTops = [];
  const t0 = performance.now();
  const tick = () => {
    window.__barTops.push(document.querySelector('[data-testid="titlebar"]').getBoundingClientRect().top);
    if (performance.now() - t0 < 600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector(pageSel);
await page.waitForTimeout(650);
const barTops = await page.evaluate(() => window.__barTops);
check(barTops.every((t) => t === 0), `the title bar doesn't move while the page opens (${[...new Set(barTops)].join(", ")})`);
check(await page.isVisible('[data-testid="titlebar"]'), "the title bar stays while the page is up");
check(!(await page.isVisible('[data-testid="workspace"]:not([hidden]) [data-testid="sidebar"] [data-testid="sb-head"]')), "the schema column is hidden while the page is up");
check((await page.$eval(pageSel, (el) => el.getBoundingClientRect().left)) === 0, "the page starts at the window's left edge");
check(!(await page.isVisible(`${ws} [data-testid="main"]`)), "the editor and grid are out of sight");
check((await page.getAttribute(pageSel, "data-call")) === "5", "with nothing waiting, the newest call shows");
check(!(await page.$('[data-testid="pp-list-count"]')), "no Waiting for you while nothing waits");
// Text on purpose: the way out names the window it returns to.
check((await page.textContent(`${pageSel} [data-testid="page-back"]`)).includes("kioskuno-wallet"), "the head's first control goes back to kioskuno-wallet");
check((await page.getAttribute('[data-testid="win-tab"][data-on] [data-testid="win-mcp"]', "aria-pressed")) === "true", "the shown pill's agent mark reads as pressed");
check(!(await page.$(`${pageSel} [data-mcp-allow]`)), "no sharing switches on the page: they are in Settings");
await shot("1-page");

// 2. Activity: every call newest first, one line of SQL each; with two
// connections in the log each row carries its environment dot.
const tools = await page.$$eval('[data-testid="ag-call"]', (els) => els.map((el) => el.getAttribute("data-tool")));
check(tools.join(",") === "query,sessions,query,query,describe_table,list_connections", `the log, newest first: ${tools.join(", ")}`);
const dots = await page.$$eval('[data-testid="ag-call"] .mcp-dot', (els) => els.map((el) => el.getAttribute("data-env"))); // Class on purpose: the env dot.
check(JSON.stringify(dots) === JSON.stringify(["local", "prd", "local", "prd", "prd"]), `each call carries its connection's environment: ${dots.join(", ")}`);
const sessionsRow = await page.textContent('[data-testid="ag-call"][data-tool="sessions"]');
check(/3 sessions/.test(sessionsRow ?? ""), `a sessions call says how many it showed: ${sessionsRow}`);
check((await page.textContent('[data-testid="ag-call-title"]')) === "query", "the picked call shows beside the list");
check(/select migration, batch/.test(await page.textContent('[data-testid="ag-call-sql"]')), "with its SQL");

// 3. ↓ moves through the log; Refused narrows it to the refused call and its reason.
await page.focus(pageSel);
await page.keyboard.press("ArrowDown");
await page.waitForSelector(`${pageSel}[data-call="4"]`);
check((await page.getAttribute('[data-testid="ag-call"][aria-current="true"]', "data-tool")) === "sessions", "↓ picks the next call");
await page.click('[data-mcp-filter="refused"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ag-call"]').length === 1);
check((await page.getAttribute('[data-testid="ag-call"]', "data-verdict")) === "refused", "Refused leaves the refused call");
check(/plan reads public\.wallet_transactions/.test(await page.textContent('[data-testid="ag-call-view"] [data-testid="mcp-reason"]')), "and shows why it was refused");
await shot("2-refused");
await page.click('[data-mcp-filter="all"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ag-call"]').length === 6);

// 4. ↵ on a query opens its SQL in a query tab; the page goes.
await page.click('[data-testid="ag-call"][data-mcp-entry="5"]');
await page.keyboard.press("Enter");
await page.waitForSelector(pageSel, { state: "detached" });
check(await page.isVisible(`${ws} [data-testid="main"]`), "↵ opens the call's SQL in the window");

// 5. ⌘⇧A, the pill's agent mark and the back button: in and out.
check((await page.getAttribute('[data-testid="sb-agents"]', "data-on")) === null, "the Agents button is dark in the window");
await page.keyboard.press("Control+Shift+A");
await page.waitForSelector(pageSel);
check(true, "⌘⇧A opens the page");
await page.keyboard.press("Control+Shift+A");
await page.waitForSelector(pageSel, { state: "detached" });
check(true, "and ⌘⇧A goes back");
await page.click('[data-testid="win-tab"][data-on] [data-testid="win-mcp"]');
await page.waitForSelector(pageSel);
check(true, "the pill's agent mark opens the page");
await page.click('[data-testid="win-tab"][data-on] [data-testid="win-mcp"]');
await page.waitForSelector(pageSel, { state: "detached" });
check(true, "pressed again, it goes back");
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector(pageSel);
await page.click(`${pageSel} [data-testid="page-back"]`);
await page.waitForSelector(pageSel, { state: "detached" });
check(true, "the back button goes back");

// 6. ⌘K works on the page; closing it keeps the page; Esc goes back.
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector(pageSel);
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

// 7. Sharing (the page's foot) is Settings › Agents: the connection cards,
// What can the agent do, Connect an agent, Stop all sharing.
await page.click("[data-ag-sharing]");
const settings = '[data-testid="settings-page"][data-section="agents"]';
await page.waitForSelector(`${settings} [data-testid="agents-sharing"]`);
await page.waitForSelector(pageSel, { state: "detached" });
check(true, "Sharing leaves the Agents page for Settings › Agents");
check((await page.$$("[data-mcp-conn]")).length === 3, "every connection is listed under Shared with agents");
check(await page.isChecked('[data-mcp-allow="prd"]'), "production shows as shared");
const prdStats = await page.textContent('[data-mcp-conn="prd"] [data-testid="mcp-cn-stats"]');
check(/3 calls today/.test(prdStats ?? ""), `a shared connection says what agents did on it today: ${prdStats}`);
await shot("3-settings-agents");
await page.click("[data-ag-can-do]");
await page.waitForSelector('[data-testid="ag-can-do"] [role="dialog"]');
check((await page.$$('[data-ag-panel] li')).length === 10, "What can the agent do lists five can and five can't");
check(/tick every table it reads/.test(await page.textContent("[data-ag-join-note]")), "it says a view or join needs every table it reads ticked");
const toolList = await page.$$eval(".ag-tools code", (els) => els.map((el) => el.textContent));
check(toolList.includes("sessions"), `Available tools lists sessions: ${toolList.join(", ")}`);
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ag-can-do"]', { state: "detached" });
check(!!(await page.$(settings)), "Esc closes the sheet and keeps Settings");
await page.click(`${settings} [data-mcp-connect]`);
await page.waitForSelector(`${settings} [data-testid="ag-connect"] [data-mc-sheet]`);
check(!(await page.$(".mcp-overlay")), "Connect an agent is inline, not a sheet over the page"); // Class on purpose: the sheet's scrim.
await page.waitForSelector('[data-mc-state="ready"]');
await page.keyboard.press("Escape");
await page.waitForSelector("[data-mc-sheet]", { state: "detached" });
check(!!(await page.$(settings)), "Esc closes Connect an agent and keeps Settings");
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
await page.focus('[data-testid="settings-page"]');
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="settings-page"]', { state: "detached" });
check(await page.isVisible(`${ws} [data-testid="main"]`), "Esc returns to the window");

// 8. ⌘K's access and connect commands land on Settings › Agents.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">connect claude code");
await page.waitForSelector('[data-item="cmd:mcp-connect"]');
await page.click('[data-item="cmd:mcp-connect"]');
await page.waitForSelector(`${settings} [data-testid="ag-connect"]`);
check(true, "⌘K Connect Claude Code opens Settings › Agents with Connect an agent");
await shot("4-connect");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
