#!/usr/bin/env node
// Tips (stubbed `invoke`, the page's clock moved a day between tips): the five
// rule-based tips of Tips.ts, each a 12 px line under its control, earned by a
// counted trigger and retired by doing what it teaches. The second Preview
// retarget waits for its rows (never while a query runs), then shows under the
// tab row; ⌘-click retires it. The same day nothing else shows (one a day).
// The first chip earns "Type on a column to filter" under the SQL line; typing
// on a cell retires it. The third Data | Structure click earns the ⌥⌘1 / ⌥⌘2
// tip under the thumb; the chord retires it. The second drag of one column
// shows "Widths are remembered" under that column, once. The third database
// picker open shows its ⌘↵ footer; ⌘↵ retires it. ⌘K Hide tips turns them off.
// Counters and retirements are saved (`rowkery.tips`).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/tips-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/tips";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const TX = [col("id", "int8"), col("amount", "numeric"), col("status", "text")];
  const table = (name) => ({ name, kind: "table", columns: TX, primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 40 }, partition_of: null });
  const tables = [table("kiosks"), table("wallet_tx"), table("wallets")];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "wallet-prd", host: "db", port: 5432, database: "wallet", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: args?.database ?? "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [
            { name: "wallet", size_bytes: 1_000_000 },
            { name: "orders", size_bytes: 2_000_000 },
          ];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table}${args.filter?.trim() ? `\nWHERE (${args.filter.trim()})` : ""}\nORDER BY id\nLIMIT ${args.limit ?? 1000};`;
        case "run_query": {
          // Slow enough to see that no tip shows while a query runs.
          await new Promise((r) => setTimeout(r, 400));
          const n = /WHERE/.test(args.sql) ? 3 : 8;
          return {
            columns: TX.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) => [{ Int: 100 + i }, { Text: "52.00" }, { Text: i % 2 ? "settled" : "pending" }]),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
          };
        }
        default:
          return null;
      }
    },
  };
}

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
let now = new Date(2026, 9, 5, 10).getTime();
await page.clock.install({ time: now });
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
const row = (name) => `${ws} [data-table="wallet.public.${name}"] [data-testid="sb-row-main"]`;
const cell = (r, c) => `${ws} [data-row="${r}"] [data-col="${c}"]`;
const tips = () => page.$$eval("[data-tip]", (els) => els.filter((e) => e.dataset.tip).map((e) => e.dataset.tip));
const tip = (id) => `[data-tip="${id}"]`;
const nextDay = async () => {
  now += 24 * 60 * 60 * 1000;
  await page.clock.setSystemTime(now);
};
const saved = async () => {
  await page.waitForTimeout(1200); // persist flushes within a second
  return page.evaluate(() => JSON.parse(localStorage.getItem("rowkery.tips") ?? "null"));
};
const idle = () => page.waitForFunction((sel) => !document.querySelector(sel), `${ws} [data-testid="query-tab-spin"]`);

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
// The fake clock can hold the frame that focuses the picker: ↵ waits for it.
await page.waitForFunction(() => !!document.activeElement?.closest('[data-testid="conn-popover"]'));
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. Preview tab reused: the second retarget, after its rows land.
await page.click(row("wallet_tx"));
await idle();
await page.click(row("kiosks"));
await idle();
check((await tips()).length === 0, "the first retarget earns nothing");
await page.click(row("wallets"));
await page.waitForSelector(`${ws} [data-testid="query-tab-spin"]`);
check(!(await tips()).includes("preview-reused"), "no tip while the retargeted tab's query runs");
await page.waitForSelector(tip("preview-reused"));
check((await page.textContent(tip("preview-reused"))) === "Preview tab reused · Ctrl-click a table to keep it", "second retarget: 'Preview tab reused · Ctrl-click a table to keep it'");
const tabsBox = await page.locator(`${ws} [data-testid="query-tabs"]`).boundingBox();
const tipBox = await page.locator(tip("preview-reused")).boundingBox();
check(tipBox.y >= tabsBox.y + tabsBox.height - 6 && tipBox.height <= 24, "it sits under the tab row as one short line");
check((await page.$eval(tip("preview-reused"), (e) => getComputedStyle(e).fontSize)) === "12px", "12 px");
await page.screenshot({ path: `${OUT}/1-preview-reused.png` });
await page.click(row("kiosks"), { modifiers: ["ControlOrMeta"] });
await page.waitForFunction((sel) => !document.querySelector(sel), tip("preview-reused"));
check((await saved())?.retired?.includes("preview-reused"), "Ctrl-click keeps a table and retires the tip (saved)");

// One a day: the first chip today earns its tip but doesn't show it.
await idle();
await page.click(cell(0, 2), { button: "right" });
await page.click('[data-menu="grid"] [data-item="f-only"]');
await page.waitForSelector(`${line} [data-chip="0"]`);
await idle();
await page.waitForTimeout(300);
check((await tips()).length === 0, "one tip a day: the chip's tip waits for tomorrow");

// 2. Type on a column to filter (next day, the next chip).
await nextDay();
await page.click(cell(0, 1), { button: "right" });
await page.click('[data-menu="grid"] [data-item="f-only"]');
await page.waitForSelector(`${line} [data-chip="1"]`);
await page.waitForSelector(`${line} ${tip("type-to-filter")}`);
check((await page.textContent(tip("type-to-filter"))) === "Type on a column to filter", "a chip: 'Type on a column to filter' under the SQL line");
await page.screenshot({ path: `${OUT}/2-type-to-filter.png` });
await page.click(cell(0, 2));
await page.keyboard.press("p");
await page.waitForSelector(`${line} [data-chip-editor]`);
check(!(await tips()).includes("type-to-filter"), "typing on a column opens a chip and retires the tip");
await page.keyboard.press("Escape");

// 3. ⌥⌘1 / ⌥⌘2 (Ctrl+Alt here): the third click on the thumb.
await nextDay();
const thumb = (v) => `${ws} [data-testid="view-switch"] [data-view="${v.toLowerCase()}"]`;
await page.click(thumb("Structure"));
await page.click(thumb("Data"));
check((await tips()).length === 0, "two thumb clicks: nothing yet");
await page.click(thumb("Structure"));
await page.waitForSelector(tip("view-keys"));
check((await page.textContent(tip("view-keys"))) === "Ctrl+Alt+1 / Ctrl+Alt+2 switch Data and Structure", "third click: the chords, from commands.ts");
const sw = await page.locator(`${ws} [data-testid="view-switch"]`).boundingBox();
const vt = await page.locator(tip("view-keys")).boundingBox();
check(vt.y >= sw.y + sw.height && Math.abs(vt.x + vt.width - (sw.x + sw.width)) < 2, "under the thumb, right-aligned with it");
await page.screenshot({ path: `${OUT}/3-view-keys.png` });
await page.keyboard.press("Control+Alt+1");
await page.waitForFunction((sel) => !document.querySelector(sel), tip("view-keys"));
check((await saved())?.retired?.includes("view-keys"), "the chord retires it");

// 4. Widths are remembered: the second drag of the same column.
await nextDay();
await page.waitForSelector(`${ws} [data-row]`);
const drag = async (dx) => {
  const h = await page.locator(`${ws} [data-header="amount"] [data-testid="col-resize-handle"]`).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2, { steps: 3 });
  await page.mouse.up();
};
await drag(30);
check((await tips()).length === 0, "one drag: nothing yet");
await drag(20);
await page.waitForSelector(tip("widths-remembered"));
check((await page.textContent(tip("widths-remembered"))) === "Widths are remembered for this table", "second drag: 'Widths are remembered for this table'");
const hc = await page.locator(`${ws} [data-header="amount"]`).boundingBox();
const wt = await page.locator(tip("widths-remembered")).boundingBox();
check(wt.y >= hc.y + hc.height && Math.abs(wt.x - hc.x) < 12, "under the grid header, at the dragged column");
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/4-widths.png` });
check((await saved())?.retired?.includes("widths-remembered"), "shown once: retired on display");

// 5. The database picker's third open: its footer becomes the ⌘↵ tip.
// One at a time: the widths tip fades first (8 s).
await page.waitForFunction(() => !document.querySelector("[data-tip=\"widths-remembered\"]"), null, { timeout: 15000 });
await nextDay();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Control+Shift+D");
  await page.waitForSelector('[data-testid="db-popover"]');
  await page.waitForFunction(() => document.activeElement?.closest('[data-testid="db-popover"]'));
  if (i < 2) {
    check((await page.$(`[data-testid="db-popover"] ${tip("db-new-window")}`)) === null, `open ${i + 1}: the static footer`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[data-testid="db-popover"]'));
  }
}
await page.waitForSelector(`[data-testid="db-popover"] ${tip("db-new-window")}`);
check((await page.textContent(tip("db-new-window"))) === "Ctrl+↵ opens a database in a new window", "third open: the footer reads the tip");
await page.screenshot({ path: `${OUT}/5-db-new-window.png` });
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
check((await saved())?.retired?.includes("db-new-window"), "Ctrl+↵ opens it in a new window and retires the tip");

// Hide tips (⌘K): saved as off.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type(">hide tips");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:hide-tips"]');
await page.click('[data-testid="cp-row"][data-item="cmd:hide-tips"]');
check((await saved())?.off === true, "⌘K Hide tips turns them off");
const final = await saved();
check(
  ["preview-reused", "type-to-filter", "view-keys", "widths-remembered", "db-new-window"].every((id) => final.retired.includes(id)),
  `all five retired: ${final.retired.join(", ")}`,
);
await browser.close();
