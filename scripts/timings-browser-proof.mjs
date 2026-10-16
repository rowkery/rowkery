#!/usr/bin/env node
// Timings sheet, COMMENTs and tooltips (stubbed `invoke`, no webview or
// Postgres): ⌘K "Timings" (and its synonym "latency") opens the sheet with
// the launch marks, ⌘K open and the last query against their budgets, Copy
// puts the lines on the clipboard and Esc closes; Postgres table and column
// comments show in the sidebar row and grid header tooltips, in Structure
// and in Quick Look; tooltips print the chord commands.ts gives. Asserts on
// data-* attributes only.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/timings-browser-proof.mjs [outDir]
//
// Needs the `playwright` package (global install is fine) and Chromium.
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/timings";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const tables = [
    {
      name: "wallet_tx",
      comment: "Ledger of wallet movements. One row per transaction; amount is signed.\nWritten by the payments service.",
      columns: [
        { name: "id", type_name: "bigint", nullable: false },
        { name: "wallet_id", type_name: "bigint", nullable: false, comment: "The wallet this movement belongs to." },
        { name: "amount", type_name: "numeric(12,2)", nullable: false, comment: "Signed: negative is a debit." },
        { name: "note", type_name: "text", nullable: true },
      ],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 3 },
      table_bytes: 8192,
      index_bytes: 8192,
      partition_of: null,
    },
    {
      name: "wallets",
      columns: [{ name: "id", type_name: "bigint", nullable: false }],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 2 },
      partition_of: null,
    },
  ];
  const catalog = { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] };
  const connections = [
    { kind: "postgres", id: "pg", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "wallet", username: "rowkery" },
  ];
  const tx = {
    columns: [
      { name: "id", type_name: "int8" },
      { name: "wallet_id", type_name: "int8" },
      { name: "amount", type_name: "numeric" },
      { name: "note", type_name: "text" },
    ],
    rows: [
      [{ Int: 1 }, { Int: 10 }, { Text: "12.50" }, { Text: "top-up" }],
      [{ Int: 2 }, { Int: 10 }, { Text: "-4.00" }, "Null"],
      [{ Int: 3 }, { Int: 11 }, { Text: "9.99" }, { Text: "refund" }],
    ],
    row_count: 3,
    elapsed_ms: 4,
    error: null,
    cancelled: false,
  };
  const one = { columns: [{ name: "x", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 2, error: null, cancelled: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 1000;`;
        case "run_query":
          return /wallet_tx/.test(args.sql ?? "") ? tx : one;
        case "follow_keys":
          return [];
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.

let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
  } else console.log(`ok: ${msg}`);
};
const shot = async (name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};

// 1. Tooltips print the registry's chord (Linux keys here).
check((await page.getAttribute('[data-testid="conn-chip"]', "title")) === "Switch connection  Ctrl+Shift+O", "connection chip tooltip");
// ⌘B has no button (the key hides the sidebar); the title bar's ⌘K
// carries the registry's keys.
check((await page.textContent('[data-testid="search-cap-key"]')) === "Ctrl K", "⌘K's keycap reads Ctrl K");
check((await page.getAttribute('[data-testid="win-add"]', "title")) === "Open a new window  Ctrl+T", "new window tooltip");

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
check((await page.getAttribute(`${visible} [data-testid="sb-refresh"]`, "title")) === "Reload tables and columns  Ctrl+R", "refresh schema tooltip");

// 2. A table COMMENT is the sidebar row's tooltip.
const rowTitle = await page.getAttribute(`${visible} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`, "title");
check(rowTitle === "public.wallet_tx\nLedger of wallet movements. One row per transaction; amount is signed.", `sidebar row tooltip has the comment's first line (${JSON.stringify(rowTitle)})`);

// 3. Browse it: commented headers carry the comment first in their tooltip.
await page.click(`${visible} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${visible} [data-row="0"]`);
await page.waitForTimeout(200);
const header = (name) => page.$eval(`${visible} [data-header="${name}"]`, (e) => ({ c: e.hasAttribute("data-comment"), t: e.title }));
const wallet = await header("wallet_id");
check(wallet.c && wallet.t.startsWith("The wallet this movement belongs to.\nwallet_id · int8"), `wallet_id header tooltip starts with its comment (${JSON.stringify(wallet.t)})`);
const note = await header("note");
check(!note.c && note.t.startsWith("note · text"), "an uncommented header keeps type and profile first");
check(note.t.includes("Click sorts by this column · Shift-click adds a secondary sort"), "header sort hint is a verb phrase, with this platform's Shift");

// 4. Quick Look prints column comments under the field names.
await page.click(`${visible} [data-row="0"] [data-col="0"]`);
await page.keyboard.press("Space");
await page.waitForSelector(`${visible} [data-quicklook]`);
const qlComments = await page.$$eval(`${visible} [data-quicklook] [data-comment]`, (els) => els.map((e) => [e.dataset.comment, e.textContent]));
check(
  JSON.stringify(qlComments) === JSON.stringify([["wallet_id", "The wallet this movement belongs to."], ["amount", "Signed: negative is a debit."]]),
  `Quick Look shows column comments (${JSON.stringify(qlComments)})`,
);
await shot("1-quicklook-comments");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 5. Structure: the table comment's first line under the title, column comments under names.
check((await page.getAttribute(`${visible} [data-testid="view-switch"] [role="tab"][data-on]`, "title")) === "Show the rows  Ctrl+Alt+1", "Data tab tooltip");
await page.keyboard.press("Control+Alt+2");
await page.waitForSelector(`${visible} [data-table-comment]`);
const tableComment = await page.$eval(`${visible} [data-table-comment]`, (e) => [e.textContent, e.title]);
check(tableComment[0] === "Ledger of wallet movements. One row per transaction; amount is signed.", "Structure prints the table comment's first line");
check(tableComment[1].includes("Written by the payments service."), "and its tooltip holds all of it");
const colComments = await page.$$eval(`${visible} [data-column-comment]`, (els) => els.map((e) => e.dataset.columnComment));
check(JSON.stringify(colComments) === JSON.stringify(["wallet_id", "amount"]), `Structure prints column comments only where present (${colComments.join(", ")})`);
await shot("2-structure-comments");
await page.keyboard.press("Control+Alt+1");

// 6. Run a query so Timings has a last query.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.fill('[data-testid="cp-search"] input', ">new query tab");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-closing] [data-testid="cp-panel"]', { state: "detached" });
await page.waitForSelector(`${visible} textarea[data-testid="sql-editor"]`);
await page.focus(`${visible} textarea[data-testid="sql-editor"]`);
await page.keyboard.type("SELECT 1;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${visible} [data-header="x"]`);
await page.waitForTimeout(300);

// 7. ⌘K "latency" finds Timings; it opens the sheet.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.fill('[data-testid="cp-search"] input', "latency");
await page.waitForTimeout(50);
check((await page.$eval('[data-testid="cp-row"][aria-selected="true"]', (e) => e.dataset.item)) === "cmd:timings", "\"latency\" finds Timings");
await page.keyboard.press("Enter");
await page.waitForSelector("[data-timings]");
const rows = await page.$$eval("[data-timing]", (els) =>
  Object.fromEntries(els.map((e) => [e.dataset.timing, { ms: e.dataset.ms === undefined ? null : Number(e.dataset.ms), over: e.hasAttribute("data-over") }])),
);
// The dev server runs development React; latency-browser-proof.mjs budgets the build.
// The palette row reads the platform's key (Ctrl+K here).
check(rows["Ctrl+K open (last)"]?.ms != null, `the Ctrl+K open that opened it is measured (${rows["Ctrl+K open (last)"]?.ms})`);
check(rows["run → first frame"]?.ms != null, `the last query's first frame is measured (${rows["run → first frame"]?.ms})`);
check(rows["database"]?.ms === 2, "the database's own time is the done frame's");
check(rows["process → window painted"] !== undefined, "launch rows are listed");
const sections = await page.$$eval("[data-section]", (els) => els.map((e) => e.dataset.section));
check(sections[0] === "Launch" && sections[1].startsWith("Last query · Query"), `sections (${sections.join(", ")})`);
check((await page.textContent('[data-testid="tm-where"]')) === "wallet-local / wallet", "the title row names connection / database");
await shot("3-timings");

await page.click("[data-timings-copy]");
await page.waitForTimeout(200);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.startsWith("Timings · wallet-local / wallet\n\nLaunch\n"), "Copy starts with the heading and Launch");
check(/Ctrl\+K open \(last\) [\d.]+ ms \(budget 16(, over)?\)/.test(clip), "Copy prints measured ms with the budget");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-timings]", { state: "detached" });
check(true, "Esc closes the sheet");

await browser.close();
console.log(failed ? `${failed} failed` : "all ok");
process.exitCode = failed ? 1 : 0;
