#!/usr/bin/env node
// MCP activity / access proof with a stubbed Tauri `invoke`: ⌘K MCP activity
// lists what the MCP server logged (mcp_activity), grouped by agent session,
// with a refusal's reason; ↵ opens a call's SQL in a new query tab; a new
// refusal while you work shows a toast whose View opens the log; the window
// pill of a connection read in the last minute carries an MCP tag; the
// Access tab maps what an agent can reach and its switches save allow_mcp;
// the connection sheet shows today's counts; Clear log empties it.
// A picked call shows the start of its response, kept 24 h (mcp_sample);
// the connection sheet's Keep result samples switch saves mcp_samples_off.
// The log itself (mcp-log.jsonl, read by offset) is proved by
// `cargo test -p rowkery-mcp audit`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mcp-activity-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp-activity";
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
    pg("stg", "analytics-stg", "10.0.12.7", "stg", false),
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
        case "probe_connection":
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "mcp_sample": {
          const e = log.find((x) => x.session === args.session && x.ts === args.ts);
          if (!e?.sql?.includes("from failed_jobs group by queue")) return null;
          return {
            session: e.session,
            ts: e.ts,
            text: '{"columns":["queue","failed","first_failure","last_failure"],"rows":[["payouts",41,"2026-09-12","2026-10-08"],["webhooks",17,"2026-09-30","2026-10-08"]',
            bytes: 900,
          };
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

// Connect to the shared local database.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. The log was read on launch (a connection is shared); the tile carries the MCP tag.
await page.waitForSelector('[data-testid="win-tab"][data-on] [data-testid="win-mcp"]');
check(true, "rail tile of a connection read in the last minute shows the MCP tag");

// 2. ⌘K MCP activity: newest first, one session, the refusal with its reason.
await palette("MCP activity");
await page.waitForSelector('[data-mcp-sheet="activity"]');
const tools = await page.$$eval("[data-mcp-entry]", (els) => els.map((el) => el.getAttribute("data-tool")));
check(
  JSON.stringify(tools) === JSON.stringify(["query", "query", "query", "describe_table", "list_connections"]),
  `entries newest first: ${tools.join(", ")}`,
);
check((await page.$$('[data-testid="mcp-session"]')).length === 1, "one agent session header");
const reason = await page.textContent('[data-verdict="refused"] [data-testid="mcp-reason"]');
check(/wallet_transactions/.test(reason ?? ""), `refusal reason shown: ${reason}`);
await shot("1-activity");

// A picked query shows what came back; a refusal has nothing to show.
await page.click('[data-mcp-entry="1"]');
await page.waitForSelector('[data-mcp-entry="1"] [data-mcp-box="response"] .mcp-json');
const sampleText = await page.textContent('[data-mcp-box="response"]');
check(
  /queue/.test(sampleText ?? "") && /payouts/.test(sampleText ?? "") && /of 900 B/.test(sampleText ?? ""),
  `the start of the response of the picked query: ${sampleText?.slice(0, 80)}`,
);
await shot("1b-sample");
await page.click('[data-mcp-entry="2"]');
await page.waitForTimeout(150);
check(!(await page.$('[data-mcp-box="response"]')), "a refused call shows no response");
await page.click('[data-mcp-entry="0"]');
await page.waitForTimeout(150);
check(/Not kept/.test((await page.textContent('[data-mcp-box="response"]')) ?? ""), "a call with no kept response says so");

await page.click('[data-mcp-filter="refused"]');
check((await page.$$("[data-mcp-entry]")).length === 1, "Refused filter keeps the one refusal");
await page.click('[data-mcp-filter="all"]');

// 3. ↵ opens the newest call's SQL in a new query tab, not run.
const runsBefore = (await calls("run_query")).length;
await page.focus(".mcp-list"); // Class on purpose: the list owns ↑↓ ↵.
await page.keyboard.press("Enter");
await page.waitForSelector("[data-mcp-sheet]", { state: "detached" });
await page.waitForSelector(`${ws} [data-title="Agent query"]`);
const editorText = await page.textContent(`${ws} [data-testid="sql-editor"]`);
check(/from migrations order by batch/.test(editorText ?? ""), "the agent's SQL is in the new tab");
check((await calls("run_query")).length === runsBefore, "opening it ran nothing");

// 4. A refusal while you work: a toast whose View opens the log.
await page.evaluate(() => {
  window.__MCP_NEXT__.push({
    ts: Date.now(),
    session: Date.now() - 150_000,
    client: "claude-code",
    tool: "query",
    connection: "local",
    database: "kioskuno-wallet",
    sql: "select * from players where lower(email) like '%@test%'",
    verdict: "Refused: the plan reads public.players (~210000 rows; indexed: (id), (email)) end to end. Filter on an indexed column, or aggregate a narrower range.",
  });
});
await page.waitForSelector("[data-toast-offer]", { timeout: 6000 });
const toast = await page.textContent("[data-toast]");
check(/MCP refused a full read of players/.test(toast ?? ""), `toast: ${toast?.trim()}`);
await shot("2-refusal-toast");
// It arrived unasked, so ↵ in the editor stays a newline.
await page.focus(`${ws} [data-testid="sql-editor"] textarea, ${ws} [data-testid="sql-editor"] [contenteditable]`).catch(() => {});
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check(!(await page.$("[data-mcp-sheet]")), "↵ doesn't take an unasked toast");
// A second refusal; its View opens the log.
await page.evaluate(() => {
  window.__MCP_NEXT__.push({
    ts: Date.now(),
    session: Date.now() - 150_000,
    client: "claude-code",
    tool: "query",
    connection: "local",
    database: "kioskuno-wallet",
    sql: "select * from jobs where payload like '%x%'",
    verdict: "Refused: the plan reads public.jobs (~150000 rows; indexed: (id)) end to end. Filter on an indexed column, or aggregate a narrower range.",
  });
});
await page.waitForSelector("[data-toast-offer]", { timeout: 6000 });
await page.click("[data-toast-offer]");
await page.waitForSelector('[data-mcp-sheet="activity"]');
check((await page.$$('[data-verdict="refused"][data-mcp-entry]')).length === 3, "View opened the log with the new refusal");

// 5. Access: the map, and its switches save allow_mcp.
// Paper (2026-10-10): side by side there is no Access | Activity segment;
// ⌘K's "MCP access" lands on the same half.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type(">mcp access");
await page.waitForSelector('[data-item="cmd:mcp-access"]');
await page.click('[data-item="cmd:mcp-access"]');
await page.waitForSelector('[data-mcp-sheet="access"] [data-testid="mcp-map"]');
check(await page.isChecked('[data-mcp-allow="local"]'), "local is shared");
check(!(await page.isChecked('[data-mcp-allow="prd"]')), "production is hidden");
const reach = await page.textContent('[data-mcp-conn="local"] [data-testid="mcp-cn-sub"]');
check(/Every database/.test(reach ?? ""), `a shared connection says what it shares: ${reach}`);
await shot("3-access");
await page.click('[data-mcp-allow="stg"]');
await page.waitForTimeout(300);
const saved = (await calls("save_connection")).at(-1)?.[1]?.connection;
check(saved?.id === "stg" && saved.allow_mcp === true, `switch saved ${saved?.id} allow_mcp ${saved?.allow_mcp}`);
await page.waitForSelector('[data-mcp-conn="stg"][data-shared]');
await page.waitForSelector('[data-mcp-editor="stg"]');
check(true, "a first share opens Edit access");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-mcp-editor]', { state: "detached" });
await page.keyboard.press("Escape");
await page.waitForSelector("[data-mcp-sheet]", { state: "detached" });

// 6. The connection sheet: today's counts, and a way into the log.
await palette("Edit connection");
await page.waitForSelector('[data-testid="nc-mcp-stats"]');
const stats = await page.textContent('[data-testid="nc-mcp-stats"]');
check(/6 calls today/.test(stats ?? "") && /3 refused/.test(stats ?? ""), `sheet stats: ${stats}`);
await page.locator('[data-testid="nc-mcp-stats"]').scrollIntoViewIfNeeded();
await shot("4-sheet-stats");
check(await page.isChecked("[data-mcp-samples-switch]"), "Keep result samples is on by default");
await page.click("[data-mcp-samples-switch]");
await page.focus('[data-field="name"] input');
const savesBefore = (await calls("save_connection")).length;
await page.keyboard.press("Enter");
await page.waitForFunction((n) => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").length > n, savesBefore, { timeout: 4000 }).catch(() => {});
const savedOff = (await calls("save_connection")).at(-1)?.[1]?.connection;
check(savedOff?.id === "local" && savedOff.mcp_samples_off === true, `samples switch saved mcp_samples_off ${savedOff?.mcp_samples_off}`);
await palette("MCP activity");
await page.waitForSelector('[data-mcp-sheet="activity"]');

// 7. Clear log asks once inline, then empties it.
await page.click("[data-mcp-clear]");
await page.click("[data-mcp-clear-confirm]");
await page.waitForSelector('[data-testid="mcp-empty"]');
check((await calls("mcp_clear_activity")).length === 1, "Clear log cleared the file");
await shot("5-cleared");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
