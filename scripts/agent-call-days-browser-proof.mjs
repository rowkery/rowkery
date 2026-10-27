#!/usr/bin/env node
// Agents › Activity groups calls under a header per local day
// (rowkery/reports#20): "Today", "Yesterday", then "Mon 26 Oct"; rows keep
// just the time. The header sticks to the list's top while its calls scroll
// past. Screenshots in light and dark.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agent-call-days-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agent-call-days";
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
  // Calls over four days, so Activity shows a header per day: today's after
  // local midnight, yesterday's, one from three days back.
  const now = new Date();
  const dayAt = (daysBack, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, h, m).getTime();
  const todayAt = (minsAgo) => Math.max(dayAt(0, 0, 1), Date.now() - minsAgo * 60_000);
  const q = (ts, connection, sql, rows, ms) => ({
    session: 1,
    client: "claude-code",
    ts,
    tool: "query",
    connection,
    database: connection === "prd" ? "payments-prod" : "kioskuno-wallet",
    sql,
    rows,
    ms,
    verdict: "ok",
  });
  const log = [
    q(dayAt(3, 16, 2), "local", "select id, email from players order by id limit 50", 50, 3),
    q(dayAt(3, 16, 4), "local", "select count(*) from wallet_transactions", 1, 41),
    q(dayAt(1, 9, 12), "prd", "select status, count(*) from payouts group by status", 4, 61),
    { session: 1, client: "claude-code", ts: dayAt(1, 9, 13), tool: "describe_table", connection: "prd", database: "payments-prod", target: "public.payouts", ms: 2, verdict: "ok" },
    {
      session: 1,
      client: "claude-code",
      ts: dayAt(1, 11, 40),
      tool: "query",
      connection: "local",
      database: "kioskuno-wallet",
      sql: "select * from wallet_transactions where payload::text like '%failed%'",
      verdict: "Refused: the plan reads public.wallet_transactions (~412880 rows; indexed: (id)) end to end.",
    },
    q(dayAt(1, 17, 5), "local", "select migration, batch from migrations order by batch, id", 15, 4),
    q(dayAt(1, 17, 6), "local", "select * from failed_jobs order by failed_at desc limit 20", 20, 6),
    q(todayAt(95), "prd", "select id, amount from payouts where status = 'pending' limit 100", 37, 12),
    { session: 1, client: "claude-code", ts: todayAt(60), tool: "sessions", connection: "prd", database: "payments-prod", rows: 3, ms: 3, verdict: "ok" },
    q(todayAt(30), "local", "select player_id, sum(amount) from wallet_transactions group by 1 order by 2 desc limit 10", 10, 88),
    q(todayAt(2), "local", "select * from jobs where queue = 'default' limit 20", 20, 4),
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
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

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
const pageSel = '[data-testid="agents-page"]';

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]');
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector(pageSel);
await page.waitForTimeout(650);

const days = await page.$$eval(`${pageSel} [data-testid="ag-day"]`, (els) =>
  els.map((el) => ({ head: el.querySelector(".ag-day-head").textContent, n: el.querySelectorAll('[data-testid="ag-call"]').length })),
);
const back3 = new Date();
back3.setDate(back3.getDate() - 3);
const back3Label = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][back3.getDay()]} ${back3.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][back3.getMonth()]}`;
check(JSON.stringify(days) === JSON.stringify([{ head: "Today", n: 4 }, { head: "Yesterday", n: 5 }, { head: back3Label, n: 2 }]), `a header per day, newest first (${JSON.stringify(days)})`);
const times = await page.$$eval(`${pageSel} .ag-call-time`, (els) => els.map((el) => el.textContent));
check(times.every((t) => /^\d\d:\d\d$/.test(t)), "rows keep just the time");
await shot("1-days-light");

// Scrolled into yesterday (in a shorter window, so the list scrolls): its
// header sits at the list's top.
await page.setViewportSize({ width: 1280, height: 520 });
await page.$eval(`${pageSel} .ag-inbox-scroll`, (el) => {
  const day = el.querySelectorAll('[data-testid="ag-day"]')[1];
  el.scrollTop = day.offsetTop - el.offsetTop + 70;
});
await page.waitForTimeout(100);
const stuck = await page.$eval(`${pageSel} .ag-inbox-scroll`, (el) => {
  const top = el.getBoundingClientRect().top;
  const head = el.querySelectorAll(".ag-day-head")[1];
  return Math.round(head.getBoundingClientRect().top - top);
});
check(stuck === 0, `Yesterday sticks to the list's top while its calls scroll (${stuck} px)`);
await shot("2-scrolled-light");
await page.setViewportSize({ width: 1280, height: 800 });

await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.$eval(`${pageSel} .ag-inbox-scroll`, (el) => (el.scrollTop = 0));
await shot("3-days-dark");
await page.setViewportSize({ width: 1280, height: 520 });
await page.$eval(`${pageSel} .ag-inbox-scroll`, (el) => {
  const day = el.querySelectorAll('[data-testid="ag-day"]')[1];
  el.scrollTop = day.offsetTop - el.offsetTop + 70;
});
await shot("4-scrolled-dark");

await browser.close();
console.log(failed ? `${failed} failed` : "all ok");
process.exit(failed ? 1 : 0);
