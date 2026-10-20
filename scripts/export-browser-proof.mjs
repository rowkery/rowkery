#!/usr/bin/env node
// Export and Copy all (stubbed `invoke`; the native save dialog is core's,
// so `export_results` stands in for it): ⇧⌘E exports the whole result of the
// statement the tab last ran, not just the loaded page; the tab shows
// "Exporting · n rows" with Cancel meanwhile and a toast names the file;
// Esc cancels; a dismissed dialog does nothing. A query tab holds its whole
// result, so ⌘K offers plain Copy results. A table tab with rows left says
// "Copy loaded 1,000 rows" vs "Copy all results"; Copy all runs core-side,
// and Export exports its browse without the page LIMIT.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/export-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/export";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const TOTAL = 2500;
  window.__CALLS__ = [];
  window.__DIALOG__ = "/home/me/players.csv";
  window.__SLOW__ = false;
  let nextId = 0;
  let cancel = null;
  const table = { name: "players", columns: [{ name: "n", type_name: "int8", nullable: false }], primary_key: ["n"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 2500 }, partition_of: null };
  const exportRun = (args, path) =>
    new Promise((resolve) => {
      const id = ++nextId;
      let rows = 0;
      const tick = () => {
        rows += 500;
        args.onFrame.onmessage({ t: "progress", rows });
        if (rows >= TOTAL) {
          args.onFrame.onmessage({ t: "done", rows: TOTAL, error: null, cancelled: false, path });
          cancel = null;
        } else timer = setTimeout(tick, window.__SLOW__ ? 400 : 20);
      };
      let timer = setTimeout(tick, 20);
      cancel = () => {
        clearTimeout(timer);
        args.onFrame.onmessage({ t: "done", rows, error: null, cancelled: true, path });
      };
      resolve(id);
    });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (["run_query", "export_results", "copy_all_results", "cancel_query", "browse_table_sql"].includes(cmd)) {
        const { onFrame, ...rest } = args;
        window.__CALLS__.push({ cmd, ...rest });
      }
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return `SELECT * FROM "public"."players"\nORDER BY "n"${args.limit === 0 ? "" : `\nLIMIT ${args.limit}`};`;
        case "browse_table":
        case "run_query": {
          const id = ++nextId;
          const n = 1000;
          setTimeout(() => {
            const f = (x) => args.onFrame.onmessage({ query_id: id, ...x });
            f({ t: "columns", columns: [{ name: "n", type_name: "int8" }] });
            f({ t: "rows", seq: 0, rows: Array.from({ length: n }, (_, i) => [{ Int: i + 1 }]) });
            f({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return cmd === "browse_table" ? { query_id: id, sql: "SELECT * FROM players" } : id;
        }
        case "export_results":
          // The save dialog: dismissed when __DIALOG__ is null.
          if (!window.__DIALOG__) return null;
          return exportRun(args, window.__DIALOG__);
        case "copy_all_results":
          return exportRun(args, null);
        case "cancel_query":
          cancel?.();
          return null;
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter((c) => c.cmd === cmd), cmd);
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const toast = async () => {
  await page.waitForSelector("[data-toast]");
  return page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent.trim()).join(" "));
};
const palette = async (q) => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-row"]');
  await page.keyboard.type(q);
  await page.waitForTimeout(80);
  return page.$$eval('[data-testid="cp-row"][data-item]', (els) => els.map((e) => `${e.dataset.item}=${e.querySelector('[data-testid="cp-label"]').textContent}`));
};

await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.type("SELECT n FROM players");
await page.keyboard.press("Control+Enter");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
await settle();

const rows = await palette("copy");
check(rows.some((r) => r === "cmd:copy-csv=Copy results as CSV") && !rows.some((r) => r.startsWith("cmd:copy-all-csv")), `⌘K on a query tab: Copy results, all of it loaded (${rows.join(" | ")})`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// ⇧⌘E: the whole statement, slow enough to watch, then Esc cancels it.
await page.evaluate(() => (window.__SLOW__ = true));
await page.click(`${ws} [data-testid="results-grid-wrap"]`);
await page.keyboard.press("Control+Shift+E");
await page.waitForSelector(`${ws} [data-exporting]`);
const exp = (await calls("export_results"))[0];
check(exp?.sql === "SELECT n FROM players" && exp.table === "players" && exp.engine === "postgres", `⇧⌘E exports the statement the tab ran (${JSON.stringify(exp)})`);
check((await page.textContent(`${ws} [data-exporting]`)).includes("Exporting"), "the tab reads Exporting · n rows");
await page.waitForFunction((ws) => Number(document.querySelector(`${ws} [data-exporting]`)?.dataset.exporting) >= 500, ws);
await page.screenshot({ path: `${OUT}/1-exporting.png` });
await page.keyboard.press("Escape");
check((await toast()) === "Export cancelled", "Esc cancels the export");
await settle();

// Fast, to the end.
await page.evaluate(() => (window.__SLOW__ = false));
await page.waitForTimeout(1800);
await page.keyboard.press("Control+Shift+E");
await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("Exported"));
check((await toast()).replace(/\s+/g, " ") === "Exported 2,500 rows players.csv", `toast names the rows and file (${await toast()})`);
await page.screenshot({ path: `${OUT}/2-exported.png` });

// Dismissed dialog: nothing.
await page.evaluate(() => (window.__DIALOG__ = null));
const before = (await calls("export_results")).length;
// 2026-10-13: wait out the "Exported" toast first (it lives 2.6 s; this used
// to press 2 s after it and read it as the dismissed dialog's toast).
await page.waitForFunction(() => !document.querySelector("[data-toast]"), null, { timeout: 5000 });
await page.keyboard.press("Control+Shift+E");
await page.waitForTimeout(200);
const dismissed = { calls: (await calls("export_results")).length - before, running: !!(await page.$(`${ws} [data-testid="card-meta"][data-state="running"]`)), toast: await page.$eval("[data-toast]", (e) => e.textContent).catch(() => null) };
check(dismissed.calls === 1 && !dismissed.running && dismissed.toast === null, `dismissing the dialog does nothing (${JSON.stringify(dismissed)})`);

// A table tab exports its browse without the page LIMIT.
await page.evaluate(() => (window.__DIALOG__ = "/home/me/players.sql"));
await page.click(`${ws} [data-table="rowkery.public.players"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
await settle();
const tableRows = await palette("copy");
check(tableRows.some((r) => r.startsWith("cmd:copy-csv=Copy loaded 1,000 rows as CSV")) && tableRows.some((r) => r === "cmd:copy-all-csv=Copy all results as CSV"), `⌘K on a table tab: loaded vs all (${tableRows.join(" | ")})`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(1800);
await page.click(`${ws} [data-testid="results-grid-wrap"]`);
await page.keyboard.press("Control+Shift+E");
await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("players.sql"));
const tableExp = (await calls("export_results")).at(-1);
check(!tableExp.sql.includes("LIMIT") && tableExp.table === "players" && tableExp.schema === "public", `table tab: whole table, INSERT target public.players (${JSON.stringify(tableExp)})`);
// Copy all from ⌘K.
await palette("copy all results as csv");
await page.click('[data-testid="cp-row"][data-item="cmd:copy-all-csv"]');
await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("Copied"));
const copy = (await calls("copy_all_results"))[0];
check(/players/.test(copy?.sql ?? "") && !/LIMIT/.test(copy?.sql ?? "") && copy.format === "csv", `Copy all runs the whole browse core-side as CSV (${copy?.sql})`);
check((await toast()).replace(/\s+/g, " ") === "Copied 2,500 rows CSV", `toast says so (${await toast()})`);
await browser.close();
