#!/usr/bin/env node
// Agent query limit proof with a stubbed Tauri `invoke`: each shared card in
// Settings › Agents picks 10 s, 30 s, 1 min or 5 min (saves mcp_timeout_s;
// unset reads 10 s), an unshared card shows none, and a logged call's Access
// box states the limit it ran under. The server's side (the limit applied to
// Postgres and SQLite, the call timeout growing with it) is proved by
// `cargo test -p rowkery-mcp`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/agent-timeout-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/agent-timeout";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const pg = (id, name, host, environment, extra) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: name,
    username: "app",
    environment,
    mcp_access: { [name]: { mode: "all", tables: [] } },
    ...extra,
  });
  const connections = [
    pg("local", "kioskuno-wallet", "localhost", "local", { allow_mcp: true }),
    pg("prd", "payments-prod-reporting-replica-eu-west", "payments.db.internal", "prd", { allow_mcp: true, mcp_timeout_s: 300 }),
    pg("stg", "analytics-stg", "10.0.12.7", "stg", { allow_mcp: false }),
  ];
  const t0 = Date.now();
  const log = [
    {
      session: t0 - 90_000,
      client: "claude-code",
      ts: t0 - 60_000,
      tool: "query",
      connection: "prd",
      database: "payments-prod-reporting-replica-eu-west",
      sql: "select date_trunc('month', paid_at) m, sum(amount) from payments group by 1 order by 1",
      rows: 24,
      ms: 41_200,
      verdict: "ok",
      scope: { databases: 1, mode: "all", tables: 0, timeout_s: 300, max_rows: 200 },
    },
  ];
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "save_connection": {
          const i = connections.findIndex((c) => c.id === args.connection.id);
          if (i >= 0) connections[i] = args.connection;
          return null;
        }
        case "mcp_activity":
          return args.since == null ? { entries: structuredClone(log), offset: log.length, reset: true } : { entries: [], offset: log.length, reset: false };
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

async function open(colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri);
  await page.goto(URL);
  await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.keyboard.type("MCP access");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="agents-sharing"]');
  return page;
}
const shot = async (page, name) => {
  await page.waitForTimeout(250);
  await page.locator('[data-testid="mcp-map"]').screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const checked = (page, id) => page.getAttribute(`[data-mcp-conn="${id}"] [data-mcp-timeout][aria-checked="true"]`, "data-mcp-timeout");

for (const scheme of ["light", "dark"]) {
  const page = await open(scheme);
  if (scheme === "light") {
    check((await checked(page, "local")) === "10", "an unset limit reads 10 s");
    check((await checked(page, "prd")) === "300", "a saved limit reads as saved (5 min)");
    check((await page.locator('[data-mcp-conn="stg"] [data-mcp-timeout]').count()) === 0, "an unshared card shows no limit");
    await page.click('[data-mcp-conn="local"] [data-mcp-timeout="30"]');
    await page.waitForSelector('[data-mcp-conn="local"] [data-mcp-timeout="30"][aria-checked="true"]');
    const save = await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "save_connection").at(-1)?.[1]?.connection);
    check(save?.id === "local" && save?.mcp_timeout_s === 30 && save?.allow_mcp === true, "picking 30 s saves mcp_timeout_s 30 and keeps sharing on");
    check(!(await page.isVisible('[data-testid="mcp-editor"]')), "picking a limit doesn't open Edit access");
  }
  await shot(page, `cards-${scheme}`);
  await page.close();
}

// The log's Access box: the limit the call ran under.
{
  const page = await open("light");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+A");
  await page.waitForSelector('[data-testid="agents-page"]');
  await page.waitForSelector('[data-testid="mcp-detail"] [data-mcp-box="access"]');
  const limits = await page.textContent('[data-mcp-box="access"] .mcp-kv');
  check(limits.includes("5 min"), "the Access box states 5 min for a call run under it");
  await page.locator('[data-mcp-box="access"]').screenshot({ path: `${OUT}/log-access.png` });
  console.log(`${OUT}/log-access.png`);
  await page.close();
}

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
