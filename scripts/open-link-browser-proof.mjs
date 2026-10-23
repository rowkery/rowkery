#!/usr/bin/env node
// rowkery:// links from Rowkery's views in the chat, with a stubbed Tauri
// `invoke` (open_link.rs resolves the link from the activity log; its own
// test proves that half). The page takes the waiting link (take_open_link)
// once connections are loaded, and again on each `rowkery:open-link`:
// - Launched by Open in Rowkery: a new window on the call's connection, an
//   "Agent query" tab holding the agent's SQL, not run: the user presses ⌘↵.
// - Another while that window is open: a new tab in the same window, not run.
// - Review in Rowkery: the Agents page on that proposal, not the oldest.
// - A call no longer in the log, a logged query that fails the read guard
//   again (refused), a proposal decided since, or a connection since
//   deleted: a toast, nothing opens.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/open-link-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/open-link";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const catalog = {
    databases: [
      {
        name: "shop",
        schemas: [
          {
            name: "public",
            tables: ["orders", "payment_providers"].map((name) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  };
  const connections = [
    { kind: "postgres", id: "shop", name: "shop-prd", host: "db.internal", port: 5432, database: "shop", username: "app", environment: "prd", allow_mcp: true },
  ];
  const now = Date.now();
  const proposal = (n, reason) => ({
    id: `p_00000000000${n}`,
    ts: now - (3 - n) * 60_000,
    connection: "shop",
    database: "shop",
    sql: `UPDATE orders SET status = 'failed' WHERE id = ${48110 + n}`,
    reason,
    client: "claude-ai",
  });
  const queue = [proposal(1, "The older one."), proposal(2, "Mark the stuck Paylane order as failed.")];
  // What take_open_link hands over next (the first one launched the app).
  window.__LINKS__ = [
    { kind: "sql", connection: "shop", database: "shop", sql: "SELECT id, total FROM orders WHERE status = 'pending' ORDER BY id" },
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
        case "take_open_link":
          return window.__LINKS__.shift() ?? null;
        case "open_window":
          await new Promise((r) => setTimeout(r, 40));
          return { database: "shop", catalog, elapsed_ms: 40 };
        case "mcp_activity":
          return { entries: [], offset: 0, reset: true };
        case "proposals_waiting":
          return structuredClone(queue);
        case "proposal_plan":
          return { connection_name: "shop-prd", statements: [{ verb: "UPDATE", target: "orders", sql: queue.find((p) => p.id === args.id).sql, destructive: false, triggers: [] }] };
        case "run_query":
          return { columns: [{ name: "id", type_name: "int8" }, { name: "total", type_name: "numeric" }], rows: [[{ Int: 48113 }, { Text: "129.00" }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const ws = '[data-testid="workspace"]:not([hidden])';
const ranSql = () =>
  page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "run_query").map(([, a]) => JSON.stringify(a)));
const link = (l) => page.evaluate((x) => {
  window.__LINKS__.push(x);
  window.dispatchEvent(new CustomEvent("rowkery:open-link"));
}, l);

// 1. Launched by a link: a window on shop, the agent's SQL in its tab, not run.
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const active = await page.textContent(`${ws} [data-testid="query-tab"][data-on] [data-testid="query-tab-title"]`);
check(active === "Agent query", `its tab is the shown one: "${active}"`);
await page.waitForTimeout(500);
check((await ranSql()).length === 0, "the launch link's SQL did not run by itself");
await shot("1-launched-by-link");

// 2. Another link while the window is open: a new tab there, not run until ⌘↵.
const tabsBefore = await page.locator(`${ws} [data-testid="query-tab"]`).count();
await link({ kind: "sql", connection: "shop", database: "shop", sql: "SELECT count(*) FROM payment_providers" });
await page.waitForFunction((n) => document.querySelectorAll('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"]').length === n, tabsBefore + 1);
check(true, "a second link opens a new tab in the same window");
await page.waitForTimeout(500);
check((await ranSql()).length === 0, "the second link's SQL did not run by itself");
await page.keyboard.press("ControlOrMeta+Enter");
await page.waitForFunction(() => window.__ROWKERY_CALLS__.some(([c, a]) => c === "run_query" && JSON.stringify(a).includes("payment_providers")));
check(true, "⌘↵ runs it");
check((await page.locator('[data-testid="workspace"]').count()) === 1, "no second window");
await shot("2-second-link");

// 3. Review in Rowkery: the Agents page on that proposal.
await link({ kind: "proposal", id: "p_000000000002" });
await page.waitForSelector('[data-testid="agents-page"][data-proposal="p_000000000002"]');
check(true, "Review opens the Agents page on the card's proposal, not the oldest");
await shot("3-review-link");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="agents-page"]', { state: "detached" });

// 4. A call no longer in the log; a proposal decided since; a connection since deleted.
await link({ kind: "gone" });
await page.waitForSelector('[data-toast="error"]');
// Text on purpose: the toast's wording is under test.
check(/activity log/.test(await page.textContent('[data-testid="toast-message"]')), "a gone call says so");
await shot("4-gone");
await link({ kind: "refused" });
await page.waitForFunction(() => /isn't a single read/.test(document.querySelector('[data-testid="toast-message"]')?.textContent ?? ""));
check(true, "a forged log entry that fails the guard says so");
await shot("4b-refused");
await link({ kind: "decided" });
await page.waitForFunction(() => /isn't waiting/.test(document.querySelector('[data-testid="toast-message"]')?.textContent ?? ""));
check((await page.locator('[data-testid="agents-page"]').count()) === 0, "a decided proposal says so and opens nothing");
const runs = (await ranSql()).length;
await link({ kind: "sql", connection: "deleted", database: null, sql: "SELECT 1" });
await page.waitForFunction(() => /isn't in Rowkery/.test(document.querySelector('[data-testid="toast-message"]')?.textContent ?? ""));
check((await ranSql()).length === runs, "a deleted connection runs nothing");

await browser.close();
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
