#!/usr/bin/env node
// Table tab paging (stubbed `invoke` recording each `browse_table`): pages of
// 1,000 by default; scrolling to the last rows loads the next page, asked for
// by keyset (`key` = the primary key, `after` = the last row loaded); the SQL
// line's end reads "1,000 of ≈2,500 rows" until the last page; its LIMIT menu
// (1,000 · 5,000 · All, which is up to the 1,000,000-row cap) reloads at
// the new size; a table without a primary
// key pages by OFFSET and says so in the ≈'s tooltip.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/keyset-paging-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/keyset-paging";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const table = (name, primary_key) => ({ name, columns: [col("id", "int8"), col("label", "text")], primary_key, indexes: [], foreign_keys: [], row_estimate: { Approximate: 2500 }, partition_of: null });
  const tables = [table("events", ["id"]), table("logs", [])];
  const TOTAL = 2500;
  window.__BROWSES__ = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const { onFrame, ...rest } = args;
          window.__BROWSES__.push(rest);
          // Keyset when `after` is given with a key, else OFFSET (like core).
          const from = rest.key?.length && rest.after ? rest.after.id.Int : (rest.offset ?? 0);
          const n = Math.max(0, Math.min(rest.limit === 0 ? Infinity : rest.limit, TOTAL - from));
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: [{ name: "id", type_name: "int8" }, { name: "label", type_name: "text" }] });
            for (let i = 0; i < n; i += 500) {
              send({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, n - i) }, (_, j) => [{ Int: from + i + j + 1 }, { Text: `e${from + i + j + 1}` }]) });
            }
            send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          // The first page's SQL as core builds it.
          const order = rest.key?.length ? `\nORDER BY ${rest.key.join(", ")}` : "";
          const limit = rest.limit ? `\nLIMIT ${rest.limit}` : "";
          return { query_id: queryId, sql: `SELECT * FROM public.${rest.table}${order}${limit};` };
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

const browses = () => page.evaluate(() => window.__BROWSES__);
const rowCount = () => page.getAttribute(`${ws} [data-testid="results-grid-wrap"]`, "data-row-count").then(Number);
// The SQL line's count (without the time), its LIMIT and its menu.
const count = () => page.textContent(`${ws} [data-line-end] [data-count]`);
const limitAttr = () => page.getAttribute(`${ws} [data-sql-line] [data-limit]`, "data-limit");
const pickLimit = async (n) => {
  await page.click(`${ws} [data-sql-line] [data-limit]`);
  await page.click(`[data-menu="page-size"] [data-item="${n}"]`);
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const toBottom = () => page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = el.scrollHeight));

await page.click(`${ws} [data-table="rowkery.public.events"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
await settle();
let b = await browses();
check(b.length === 1 && b[0].limit === 1000 && JSON.stringify(b[0].key) === '["id"]' && !b[0].after && b[0].offset === 0, `first page: 1,000 rows, key [id], no after (${JSON.stringify(b[0])})`);
// Paper (2026-10-10): the count reads "312 of 36,152 rows · 3 ms".
check((await count()) === "1,000 of ≈2,500 rows", `the line reads 1,000 of ≈2,500 rows (${await count()})`);
check((await page.textContent(`${ws} [data-line-end]`)).includes("1,000 of ≈2,500 rows · 3 ms"), "with the time after it");
check((await limitAttr()) === "1000" && (await page.textContent(`${ws} [data-limit]`)) === "LIMIT 1000", "page size control reads LIMIT 1000");
check((await page.getAttribute(`${ws} [data-sql-text]`, "data-sql-text")) === "SELECT * FROM public.events ORDER BY id LIMIT 1000;", "the line shows the first page's SQL");
check((await page.textContent(`${ws} [data-load-more]`)).includes("Load more"), "Load more is offered");
await page.screenshot({ path: `${OUT}/1-first-page.png` });

await toBottom();
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "2000", ws);
await settle();
b = await browses();
check(b.length === 2 && b[1].after?.id?.Int === 1000 && b[1].after?.label?.Text === "e1000" && b[1].offset === 1000, `scrolling to the end asks for the rows after id 1000 (${JSON.stringify(b[1]?.after)})`);

await toBottom();
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "2500", ws);
await settle();
await page.waitForTimeout(150);
await toBottom();
await page.waitForTimeout(200);
b = await browses();
check(b.length === 3 && b[2].after?.id?.Int === 2000, "third page after id 2000");
check((await count()) === "2,500 of 2,500 rows" && (await page.$(`${ws} [data-load-more]`)) === null, `last page: 2,500 of 2,500, no Load more, no fourth call (${await count()}, ${b.length} calls)`);
// Rows keep their elements as they scroll (keyed by slot), so DOM order isn't row order.
const ids = await page.$$eval(`${ws} [data-row] [data-col="0"]`, (els) =>
  els
    .sort((x, y) => Number(x.closest("[data-row]").dataset.row) - Number(y.closest("[data-row]").dataset.row))
    .slice(-2)
    .map((e) => e.textContent),
);
check(ids.at(-1) === "2500", `last row is id 2500 (${ids})`);
await page.screenshot({ path: `${OUT}/2-all-pages.png` });

await pickLimit(5000);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-sql-line] [data-limit]`)?.getAttribute("data-limit") === "5000", ws);
await settle();
b = await browses();
check(b.at(-1).limit === 5000 && !b.at(-1).after && (await rowCount()) === 2500, "page size 5,000 reloads the first page at 5,000");
check((await page.getAttribute(`${ws} [data-sql-text]`, "data-sql-text")).endsWith("LIMIT 5000;"), "the line reads LIMIT 5000");
await pickLimit(0);
await page.waitForFunction((ws) => /LIMIT 1000000;$/.test(document.querySelector(`${ws} [data-sql-text]`)?.getAttribute("data-sql-text") ?? ""), ws);
await settle();
b = await browses();
check(b.at(-1).limit === 1_000_000 && (await count()) === "2,500 of 2,500 rows", "All: every row up to the 1,000,000-row cap");
check(
  (await page.getAttribute(`${ws} [data-sql-text]`, "data-sql-text")).endsWith("LIMIT 1000000;") &&
    (await page.$(`${ws} [data-sql-line] [data-limit="0"]`)) !== null,
  "All rows: the SQL's LIMIT is the cap; the control still reads All's page size",
);

// No primary key: OFFSET, said in the tooltip.
await page.click(`${ws} [data-table="rowkery.public.logs"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "1000", ws);
await settle();
await page.waitForTimeout(200);
check((await browses()).filter((x) => x.table === "logs").length === 1 && (await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => el.scrollTop)) === 0, "a new table starts at the top: one page, not a cascade of them");
check((await page.getAttribute(`${ws} [data-count-exact]`, "title")).includes("pages use OFFSET"), "no primary key: the ≈'s tooltip says pages use OFFSET");
await page.click(`${ws} [data-load-more]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "2000", ws);
b = await browses();
check(b.at(-1).key.length === 0 && b.at(-1).offset === 1000, "its next page goes by offset 1,000");
await browser.close();
