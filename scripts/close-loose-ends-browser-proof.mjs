#!/usr/bin/env node
// What a close takes with it, without a Tauri webview (stubbed `invoke`):
// a Run All whose tab closes between statements runs none of the rest; a tab
// closed while its rows stream comes back (⌘⇧T) with those rows marked
// cancelled, not as a finished result (a finished one shown during a re-run
// stays as it was); closing a window whose tabs hold
// unsaved SQL says so in its Undo toast.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/close-loose-ends-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/close-loose-ends";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    { kind: "postgres", id: "local", name: "Docker Postgres", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery", environment: "local" },
  ];
  const catalog = { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [] }] }] };
  window.__RUNS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 10 };
        case "run_query": {
          window.__RUNS__.push(args.sql);
          const n = /SELECT (\d+)/i.exec(args.sql)?.[1] ?? "0";
          if (n === "9") {
            // Streams three rows, then keeps going until the proof ends it.
            const channel = args.onFrame;
            channel?.onmessage({ t: "columns", query_id: 0, columns: [{ name: "n", type_name: "int4" }] });
            channel?.onmessage({ t: "rows", query_id: 0, seq: 0, rows: [[{ Int: 1 }], [{ Int: 2 }], [{ Int: 3 }]] });
            await new Promise((resolve) => (window.__END__ = resolve));
          }
          // SELECT 7 is slow, so the tab can close while it runs; nothing
          // here cancels it, as core cancels only the statement in flight.
          await new Promise((r) => setTimeout(r, n === "7" ? 600 : 30));
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: Number(n) }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        }
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 })).newPage();
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  localStorage.clear();
  const tabs = [
    { kind: "query", title: "Query 1", sql: "" },
    { kind: "query", title: "Query 2", sql: "" },
  ];
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "local", database: "rowkery", tabs, activeTab: 0 }, { connectionId: "local", database: "rowkery" }], active: 0 }),
  );
});
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(visible + '[data-conn-state="connected"]');
const type = async (sql) => {
  await page.click(visible + ' [data-testid="sql-editor"]');
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(sql);
};

// 1. Run All; the tab closes while the second statement runs: the third never runs.
await type("SELECT 1;\nSELECT 7;\nSELECT 3;");
await page.keyboard.press("Control+k");
await page.keyboard.type(">run all statements");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:run-all"]');
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__RUNS__.length === 2);
await page.keyboard.press("Control+w");
await page.waitForTimeout(1200);
const runs = await page.evaluate(() => window.__RUNS__);
check(JSON.stringify(runs) === JSON.stringify(["SELECT 1;", "SELECT 7;"]), `nothing ran after the close: ${JSON.stringify(runs)}`);

// 2. Closed while its rows stream: Undo's reopen marks them cancelled.
await page.evaluate(() => (window.__RUNS__ = []));
await type("SELECT 9");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(visible + ' [data-row="2"]');
await page.keyboard.press("Control+w");
await page.waitForTimeout(200);
await page.keyboard.press("Control+Shift+t");
await page.waitForSelector(visible + ' [data-row="2"]');
const meta = await page.locator(visible + ' [data-testid="card-meta"]').first();
check((await meta.getAttribute("data-state")) === "cancelled", `the reopened rows say "${(await meta.textContent()).trim()}"`);
await page.screenshot({ path: `${OUT}/1-reopened-mid-run.png` });
await page.evaluate(() => window.__END__?.());

// A finished result shown while a re-run is on its way stays as it was.
await type("SELECT 1");
await page.keyboard.press("Control+Enter");
await page.waitForFunction((sel) => document.querySelector(`${sel} [data-row="0"] [data-col="0"]`)?.textContent === "1", visible);
await type("SELECT 7");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(200);
await page.keyboard.press("Control+w");
await page.waitForTimeout(200);
await page.keyboard.press("Control+Shift+t");
await page.waitForSelector(visible + ' [data-row="0"]');
const kept = await page.locator(visible + ' [data-testid="card-meta"]').first().getAttribute("data-state");
check(kept !== "cancelled", `a finished result reopened mid re-run isn't marked cancelled (${kept})`);
await page.waitForTimeout(700);

// 3. Closing the window: its toast names the unsaved SQL.
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "close-window" })));
await page.waitForTimeout(300);
const toast = (await page.locator('[data-testid="toast-message"]').textContent()).trim();
check(toast.endsWith("with unsaved SQL"), `the window's toast reads "${toast}"`);
await page.screenshot({ path: `${OUT}/2-window-toast.png` });
await browser.close();
