#!/usr/bin/env node
// Table-tab runs that overlap, and tabs that outlive their connection
// (stubbed `invoke`; every browse takes 500 ms so gestures land mid-run):
//   - a second sort made while the first loads is applied, not dropped, and
//     the first one's rows never show over it;
//   - a sort made while Load more is in flight drops the appended page and
//     loads the sorted first page;
//   - a retargeted Preview tab's SQL line and Edit SQL (⌘E) never show the
//     previous table's SQL while the new table loads;
//   - moving the window to another connection closes the table tabs whose
//     table that connection doesn't have (Undo offered), without browsing
//     them; query tabs stay.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/table-run-races-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/table-run-races";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  window.__DELAY__ = 0;
  const col = (name, type_name, nullable = true) => ({ name, type_name, nullable });
  const table = (name, columns) => ({ name, kind: "table", columns, primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 2500 }, partition_of: null });
  const COLS = {
    orders: [col("id", "int8", false), col("status", "text"), col("total", "numeric")],
    kiosks: [col("id", "int8", false), col("name", "text")],
    players: [col("id", "integer", false), col("handle", "text")],
  };
  const catalogs = {
    pg: { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: [table("orders", COLS.orders), table("kiosks", COLS.kiosks), table("devices", COLS.kiosks)] }] }] } },
    game: { database: "main", catalog: { databases: [{ name: "main", schemas: [{ name: "main", tables: [table("players", COLS.players)] }] }] } },
  };
  // Like core's table_browse_query; pages continue with OFFSET in the stub.
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    if (a.offset) sql += ` OFFSET ${a.offset}`;
    return sql + ";";
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "wallet-dev", host: "db", port: 5432, database: "wallet", username: "app" },
              { kind: "sqlite", id: "game", name: "game", path: "/x/game.db" },
            ],
            active_connection_id: null,
          };
        case "open_window": {
          const c = catalogs[args.connectionId];
          return { database: c.database, catalog: c.catalog, elapsed_ms: 2, cached: false, open_seq: 1 };
        }
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          const sql = args.sql;
          window.__RAN__ = [...(window.__RAN__ ?? []), sql];
          await new Promise((r) => setTimeout(r, window.__DELAY__));
          const from = /FROM \w+\.(\w+)/.exec(sql)?.[1] ?? "orders";
          const cols = COLS[from] ?? COLS.orders;
          const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1000);
          const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
          const desc = /ORDER BY total DESC/.test(sql);
          const n = Math.max(0, Math.min(limit, 2500 - offset));
          return {
            columns: cols.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) => {
              const id = desc ? 2500 - offset - i : offset + i + 1;
              return cols.map((c) => (c.name === "id" ? { Int: id } : c.name === "total" ? { Text: `${id}.00` } : { Text: `${from} ${id}` }));
            }),
            row_count: n,
            elapsed_ms: window.__DELAY__,
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
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
const lineText = () => page.getAttribute(`${line} [data-sql-text]`, "data-sql-text").catch(() => null);
const idle = () => page.waitForFunction((sel) => !document.querySelector(sel)?.querySelector('[data-state="running"]'), `${line} [data-line-end]`);
const settled = async () => {
  await page.waitForTimeout(150);
  await idle();
};
const ran = () => page.evaluate(() => window.__RAN__ ?? []);
const firstId = () => page.textContent(`${ws} [data-row="0"] [data-col="0"]`);
const rowCount = () => page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", `${line} [data-line-end]`);
const delay = (ms) => page.evaluate((v) => (window.__DELAY__ = v), ms);
const tabTitles = () => page.$$eval(`${ws} [data-testid="query-tab"][data-reorder-key] [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent.trim()));

const connect = async (id) => {
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click(`[data-conn-id="${id}"] button`);
};
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await connect("pg");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="wallet.public.orders"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row]`);
await settled();

// 1. Two sorts, the second made while the first loads: the second applies.
await delay(500);
let before = (await ran()).length;
await page.click(`${ws} [data-header="total"]`);
await page.waitForTimeout(120);
await page.click(`${ws} [data-header="total"]`);
await page.waitForTimeout(1300);
await settled();
const sorts = (await ran()).slice(before);
check(sorts.length === 2 && /total NULLS LAST/.test(sorts[0]) && /total DESC/.test(sorts[1]), `both sorts ran, in order (${sorts.map((s) => /ORDER BY [^\n]*/.exec(s)?.[0]).join(" · ")})`);
check(/ORDER BY total DESC NULLS LAST, id/.test(await lineText()), `the line shows the second sort: ${await lineText()}`);
check((await firstId()) === "2500", `the rows are the second sort's (first id ${await firstId()})`);
await page.screenshot({ path: `${OUT}/1-second-sort-applied.png` });

// 1b. The first answer never shows over the second: sample the grid while the second runs.
before = (await ran()).length;
await page.click(`${ws} [data-header="total"]`); // → unsorted
await page.waitForTimeout(120);
await page.click(`${ws} [data-header="total"]`); // → asc, queued
const seen = new Set();
for (let i = 0; i < 24; i++) {
  seen.add(await firstId());
  await page.waitForTimeout(50);
}
await settled();
check(!seen.has("1") || (await firstId()) === "1", "no outdated page flashed between the two runs");
check((await ran()).length - before === 2 && /ORDER BY total NULLS LAST, id/.test(await lineText()), `ended on the queued sort: ${await lineText()}`);

// 2. Load more in flight, then a sort: the appended page is dropped, the sorted first page shows.
await delay(0);
await page.click(`${ws} [data-header="total"]`); // → desc
await settled();
await delay(500);
before = (await ran()).length;
await page.click(`${ws} [data-load-more]`);
await page.waitForTimeout(120);
await page.click(`${ws} [data-header="total"]`); // → unsorted
await page.waitForTimeout(1300);
await settled();
const after = (await ran()).slice(before);
check(after.length === 2 && /OFFSET 1000/.test(after[0]) && !/OFFSET/.test(after[1]) && /ORDER BY id LIMIT/.test(after[1].replace(/\n/g, " ")), `Load more, then the sort's first page (${after.map((s) => s.replace(/\n/g, " ")).join(" | ")})`);
check((await page.locator(`${ws} [data-row]`).count()) > 0 && (await firstId()) === "1", `the sorted first page, not the appended rows (first id ${await firstId()})`);
check((await rowCount()).includes("1,000"), `1,000 rows, not 2,000: ${(await rowCount()).trim()}`);

// 3. Retarget the Preview tab: while the new table loads, the line and ⌘E aren't the old table's.
await delay(0);
await page.click(`${ws} [data-table="wallet.public.kiosks"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="query-tab"][data-preview][data-title="kiosks"]`);
await settled();
check(/FROM public\.kiosks/.test(await lineText()), "a Preview tab on kiosks");
await delay(1500);
await page.click(`${ws} [data-table="wallet.public.devices"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="query-tab"][data-preview][data-title="devices"]`);
await page.waitForTimeout(100);
const mid = await lineText();
check(!mid?.includes("kiosks"), `mid-load, the line isn't kiosks' SQL: ${JSON.stringify(mid)}`);
await page.screenshot({ path: `${OUT}/2-retarget-mid-load.png` });
await page.keyboard.press("Control+e");
await page.waitForSelector(`${ws} textarea[data-testid="sql-editor"]`, { timeout: 600 }).catch(() => null);
const edited = (await page.$(`${ws} textarea[data-testid="sql-editor"]`)) ? await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`) : "";
check(/FROM public\.devices/.test(edited), `⌘E mid-load opens devices' SQL, not kiosks': ${JSON.stringify(edited.replace(/\n/g, " "))}`);
await page.waitForTimeout(1600);
await delay(0);

// 4. Keep a table tab, then move the window to another connection.
await page.click(`${ws} [data-table="wallet.public.orders"] [data-testid="sb-row-main"]`, { modifiers: ["ControlOrMeta"] });
await settled();
const titlesBefore = await tabTitles();
before = (await ran()).length;
await connect("game");
await page.waitForSelector(`${ws}[data-conn-state="connected"] [data-table="main.main.players"]`);
await page.waitForTimeout(500);
const titlesAfter = await tabTitles();
// Before: Query 1, the kept orders tab, the Preview tab (devices), ⌘E's query tab (titled devices).
check(
  JSON.stringify(titlesBefore) === JSON.stringify(["Query 1", "orders", "devices", "devices"]) &&
    JSON.stringify(titlesAfter) === JSON.stringify(["Query 1", "devices"]),
  `the two table tabs are closed, the query tabs stay: ${titlesBefore.join(", ")} → ${titlesAfter.join(", ")}`,
);
const browsedOld = (await ran()).slice(before).filter((s) => /orders|kiosks|devices/.test(s));
check(browsedOld.length === 0, `no browse of the old connection's tables (${browsedOld.map((s) => s.replace(/\n/g, " ")).join(" | ")})`);
const toast = await page.textContent("[data-toast]").catch(() => "");
check(/Closed .*not in main/.test(toast ?? "") && (await page.$("[data-toast-undo]")) !== null, `toast says so, with Undo: ${toast}`);
await page.screenshot({ path: `${OUT}/3-connection-switch.png` });
// A tab whose table the new connection has is browsed as usual.
await page.click(`${ws} [data-table="main.main.players"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row]`);
check(/FROM main\.players/.test((await ran()).at(-1)), "the new connection's tables browse");
await browser.close();
