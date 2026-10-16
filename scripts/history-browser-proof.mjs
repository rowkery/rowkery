#!/usr/bin/env node
// Per-window history (stubbed `invoke`): browsing tables from the panel and
// opening Structure are steps; ‹ › at the tab row's left and ⌘[ ⌘] (Alt+←
// Alt+→ here) walk them, retargeting the Preview tab with each step's sort
// and filter as you left it; a new step from the middle drops the ones
// ahead; right-click ‹ lists the stack (newest first) to jump; ⌘K offers
// Back / Forward only when there is somewhere to go.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/history-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/history";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__BROWSES__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const table = (name) => ({ name, columns: [col("id", "int8"), col("name", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null });
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: ["kiosks", "players", "wallets"].map(table) }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const { onFrame, ...rest } = args;
          window.__BROWSES__.push({ table: rest.table, order: rest.order, filter: rest.filter });
          const id = ++nextId;
          setTimeout(() => {
            const f = (x) => onFrame.onmessage({ query_id: id, ...x });
            f({ t: "columns", columns: [{ name: "id", type_name: "int8" }, { name: "name", type_name: "text" }] });
            f({ t: "rows", seq: 0, rows: [1, 2, 3].map((n) => [{ Int: n }, { Text: `${rest.table} ${n}` }]) });
            f({ t: "done", status: "ok", row_count: 3, affected_rows: null, elapsed_ms: 1, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          // The SQL core builds (`table_browse_query`): sort, then the key.
          const key = rest.key ?? [];
          const order = [...(rest.order ?? []), ...key.filter((k) => !(rest.order ?? []).some((o) => o.column === k)).map((column) => ({ column, desc: false }))];
          let sql = `SELECT * FROM public.${rest.table}`;
          if (rest.filter?.trim()) sql += `\nWHERE (${rest.filter.trim()})`;
          if (order.length) sql += `\nORDER BY ${order.map((o) => o.column + (o.desc ? " DESC" : "") + (key.length && !key.includes(o.column) ? " NULLS LAST" : "")).join(", ")}`;
          if (rest.limit) sql += `\nLIMIT ${rest.limit}`;
          return { query_id: id, sql: sql + ";" };
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
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const hist = () => page.getAttribute(`${ws} [data-history]`, "data-history");
const back = `${ws} [data-history-back]`;
const fwd = `${ws} [data-history-forward]`;
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const browse = async (t) => {
  await page.click(`${ws} [data-table="rowkery.public.${t}"] [data-testid="sb-row-main"]`);
  await page.waitForFunction(([ws, t]) => [...document.querySelectorAll(`${ws} [data-testid="query-tab-title"]`)].some((e) => e.textContent === t), [ws, t]);
  await settle();
};
const tabTitles = () => page.$$eval(`${ws} [data-testid="query-tab"] [data-testid="query-tab-title"]`, (els) => els.map((e) => e.textContent));
const lastBrowse = () => page.evaluate(() => window.__BROWSES__.at(-1));
const lineSql = () => page.getAttribute(`${ws} [data-sql-text]`, "data-sql-text");
const activeTitle = () => page.textContent(`${ws} [data-testid="query-tab"][aria-selected="true"] [data-testid="query-tab-title"]`);

check((await page.isDisabled(back)) && (await page.isDisabled(fwd)), "‹ › start disabled");
await browse("wallets");
check((await hist()) === "1/1" && (await page.isDisabled(back)), "browsing wallets is the first step");
await browse("kiosks");
check((await hist()) === "2/2" && (await page.getAttribute(back, "title")) === "Back to wallets  Alt+←", `‹ enabled: ${await page.getAttribute(back, "title")}`);
check((await tabTitles()).join("|") === "Query 1|kiosks", "the Preview tab was retargeted, not a new tab");
// Sort kiosks, then open Structure: a step that remembers the sort.
await page.locator(`${ws} [data-header="name"]`).first().click();
await settle();
await page.keyboard.press("Control+Alt+2");
await page.waitForTimeout(100);
check((await hist()) === "3/3", "Structure is a step");
await page.screenshot({ path: `${OUT}/1-structure.png` });

await page.keyboard.press("Alt+ArrowLeft");
await settle();
check((await hist()) === "2/3" && (await lineSql()).includes("FROM public.kiosks ORDER BY name"), `Alt+← back to kiosks' rows, sort kept (${await lineSql()})`);
await page.keyboard.press("Alt+ArrowLeft");
await settle();
let b = await lastBrowse();
// Sorting kept the kiosks tab (it stopped being the Preview tab), so wallets
// opens in a new Preview tab.
check((await hist()) === "1/3" && b.table === "wallets" && (await activeTitle()) === "wallets", `again: wallets (${await tabTitles()})`);
check((await page.getAttribute(fwd, "title")) === "Forward to kiosks · name ↑  Alt+→", `› names the target: ${await page.getAttribute(fwd, "title")}`);
await page.click(fwd);
await settle();
check((await hist()) === "2/3" && (await activeTitle()) === "kiosks" && (await lineSql()).includes("ORDER BY name"), `› returns to the kiosks tab, sorted by name (${await lineSql()})`);

// A new step from the middle drops the steps ahead.
await browse("players");
check((await hist()) === "3/3", "browsing players from the middle replaces Structure as the last step");

// Right-click ‹: the stack, newest first; pick a step to jump there.
await page.click(back, { button: "right" });
await page.waitForSelector('[data-menu="history"]');
const items = await page.$$eval('[data-menu="history"] [data-item]', (els) => els.map((e) => `${e.getAttribute("aria-checked")}:${e.textContent.replace("✓", "").trim()}`));
check(items.join("|") === "true:▦  players|false:▦  kiosks · name ↑|false:▦  wallets", `stack list, newest first (${items.join(" | ")})`);
await page.screenshot({ path: `${OUT}/2-stack-list.png` });
await page.click('[data-menu="history"] [data-item="0"]');
await settle();
check((await hist()) === "1/3" && (await lastBrowse()).table === "wallets", "picking wallets jumps there");

// ⌘K: Back only when there is somewhere to go.
await page.keyboard.press("Control+k");
await page.keyboard.type("back");
await page.waitForTimeout(100);
const back1 = await page.$('[data-testid="cp-row"][data-item="cmd:history-back"]');
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("forward");
await page.waitForTimeout(100);
const fwd1 = await page.$('[data-testid="cp-row"][data-item="cmd:history-forward"]');
check(!back1 && !!fwd1, "⌘K: Forward listed, Back not (at the first step)");
await page.keyboard.press("Enter");
await settle();
check((await hist()) === "2/3", "⌘K Forward walks forward");
await browser.close();
