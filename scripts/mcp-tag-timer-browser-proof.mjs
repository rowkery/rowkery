#!/usr/bin/env node
// The title bar's MCP tag timer (stubbed Tauri `invoke`, the page's clock
// fast-forwarded): the tag on a window whose connection an agent read in the
// last minute clears a minute after the newest log entry, as before; the 5 s
// timer that recomputes it stops on that same tick instead of running for
// ever, stays stopped while the log is quiet, and starts again (with the tag)
// when a new entry arrives. The MCP log poll (3 s) is a separate timer and
// isn't counted.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/mcp-tag-timer-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp-tag-timer";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

// Counts the app's 5 s intervals (the tag's timer) that are still running.
function countIntervals() {
  const set = window.setInterval.bind(window);
  const clear = window.clearInterval.bind(window);
  const live = new Set();
  window.__TAG_TIMERS__ = { started: 0, live };
  window.setInterval = (fn, ms, ...rest) => {
    const id = set(fn, ms, ...rest);
    if (ms === 5000) {
      window.__TAG_TIMERS__.started++;
      live.add(id);
    }
    return id;
  };
  window.clearInterval = (id) => {
    live.delete(id);
    return clear(id);
  };
}

function stubTauri() {
  const connections = [
    {
      kind: "postgres",
      id: "local",
      name: "kioskuno-wallet",
      host: "localhost",
      port: 5432,
      database: "kioskuno-wallet",
      username: "app",
      environment: "local",
      allow_mcp: true,
    },
  ];
  const catalog = (db) => ({
    databases: [
      {
        name: db,
        schemas: [
          {
            name: "public",
            tables: [
              {
                name: "migrations",
                columns: [{ name: "id", type_name: "int8", nullable: false }],
                primary_key: ["id"],
                indexes: [],
                row_estimate: { Approximate: 15 },
                partition_of: null,
              },
            ],
          },
        ],
      },
    ],
  });
  const t0 = Date.now();
  const base = { session: t0 - 150_000, client: "claude-code", connection: "local", database: "kioskuno-wallet" };
  // The newest read was 20 s ago: the tag shows now and clears in ~40 s.
  const log = [
    { ...base, ts: t0 - 90_000, tool: "describe_table", target: "public.migrations", ms: 2, verdict: "ok" },
    { ...base, ts: t0 - 20_000, tool: "query", sql: "select * from migrations", rows: 15, ms: 4, verdict: "ok" },
  ];
  window.__MCP_NEXT__ = [];
  let offset = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "kioskuno-wallet", catalog: catalog("kioskuno-wallet"), elapsed_ms: 1 };
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
await page.clock.install({ time: Date.now() });
await page.addInitScript(countIntervals);
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
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: 640, height: 120 } });
  console.log(`${OUT}/${name}.png`);
};
// The agent mark's green dot: the shown pill keeps the mark while the connection is shared (2026-10-17).
const TAG = '[data-testid="win-tab"][data-on] [data-testid="win-mcp"][data-recent]';
const timers = () => page.evaluate(() => ({ started: window.__TAG_TIMERS__.started, live: window.__TAG_TIMERS__.live.size }));
const hasTag = async () => !!(await page.$(TAG));
// Fast-forwards the page's clock, letting the stubbed invokes settle.
const advance = async (ms) => {
  await page.clock.runFor(ms);
  await page.waitForTimeout(100);
};

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="local"]');
await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]');

// 1. A read 20 s ago: the tag shows and its timer runs.
await page.waitForSelector(TAG);
let t = await timers();
check(t.live === 1, `tag shown with its timer running (live ${t.live})`);
await shot("1-tag");

// 2. 35 s on (55 s after the read) the tag is still there.
await advance(35_000);
check(await hasTag(), "tag still shown 55 s after the read");

// 3. Past the minute the tag clears on the next 5 s tick, and the timer stops.
await advance(10_000);
check(!(await hasTag()), "tag cleared a minute after the read");
t = await timers();
check(t.live === 0, `timer stopped once no entry is under a minute old (live ${t.live})`);
await shot("2-cleared");

// 4. Two quiet minutes: nothing restarts it.
const startedQuiet = t.started;
await advance(120_000);
t = await timers();
check(
  t.live === 0 && t.started === startedQuiet,
  `stays stopped while the log is quiet (live ${t.live}, started ${t.started - startedQuiet} more)`,
);
check(!(await hasTag()), "no tag while quiet");

// 5. A new read: the poll brings it, the tag comes back and the timer restarts.
await page.evaluate(() => {
  window.__MCP_NEXT__.push({
    ts: Date.now(),
    session: Date.now() - 300_000,
    client: "claude-code",
    tool: "query",
    connection: "local",
    database: "kioskuno-wallet",
    sql: "select count(*) from migrations",
    rows: 1,
    ms: 2,
    verdict: "ok",
  });
});
await advance(3_500);
check(await hasTag(), "a new read brings the tag back");
t = await timers();
check(t.live === 1, `timer running again (live ${t.live})`);
await shot("3-again");

// 6. And it clears and stops again a minute after that read.
await advance(55_000);
check(await hasTag(), "tag still shown inside the minute");
await advance(10_000);
check(!(await hasTag()), "tag cleared again after the minute");
t = await timers();
check(t.live === 0, `timer stopped again (live ${t.live})`);

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
