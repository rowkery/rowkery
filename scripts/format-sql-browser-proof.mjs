#!/usr/bin/env node
// Format SQL (⌘I, src/sqlFormat.ts) in a query tab with three statements
// (stubbed `invoke`):
//
// 1. With the caret in the second statement, ⌘I lays out that one only, in
//    the tabular style; the first and third stay byte for byte, and so do the
//    second's string and comment.
// 2. ⌘Z brings the whole text back in one step.
// 3. Select all, then ⌘I formats all three; the selection stays on them.
// 4. A statement that doesn't parse stays as typed, and an error toast names
//    its line.
// 5. ⌘K "prettify" finds Format SQL, and ↵ runs it.
// 6. On a table tab ⌘I still inserts a row in the grid.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/format-sql-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/format-sql";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const tables = [
    {
      name: "orders",
      kind: "table",
      columns: [col("id", "bigint", { nullable: false }), col("status", "text")],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 2 },
      partition_of: null,
    },
  ];
  const conn = { kind: "postgres", id: "pg", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" };
  localStorage.clear();
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 3, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table": {
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: [{ name: "id", type_name: "int8" }, { name: "status", type_name: "text" }] });
            send({ t: "rows", seq: 0, rows: [[{ Int: 1 }, { Text: "paid" }], [{ Int: 2 }, { Text: "open" }]] });
            send({ t: "done", status: "ok", row_count: 2, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${rest.table}\nORDER BY id\nLIMIT ${rest.limit};` };
        }
        default:
          return null;
      }
    },
  };
}

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok" : "FAIL"}: ${msg}`);
  if (!cond) failed++;
};

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const FIRST = "select 1;";
const SECOND = "select o.id, COUNT(*) as n from orders o where o.status = 'it''s -- not;  a comment' -- keep  me\ngroup by o.id;";
const THIRD = "select   3";
const TEXT = `${FIRST}\n\n${SECOND}\n\n${THIRD}`;
const editor = `${ws} textarea`;
const value = () => page.$eval(editor, (ta) => ta.value);
const setText = (text, caret) =>
  page.evaluate(
    ([sel, text, caret]) => {
      const ta = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event("select", { bubbles: true }));
    },
    [editor, text, caret],
  );
/** Waits for the editor's text to change from `from` (the formatter loads on first use). */
const changed = (from) =>
  page
    .waitForFunction(([sel, from]) => document.querySelector(sel).value !== from, [editor, from], { timeout: 5000 })
    .then(() => true, () => false);

// 1. The caret's statement only.
await setText(TEXT, TEXT.indexOf("COUNT"));
await page.waitForTimeout(100);
await page.keyboard.press("Control+I");
check(await changed(TEXT), "⌘I changes the text");
const once = await value();
const formatted = [
  "SELECT    o.id,",
  "          count(*) AS n",
  "FROM      orders o",
  "WHERE     o.status = 'it''s -- not;  a comment' -- keep  me",
  "GROUP BY  o.id;",
].join("\n");
check(once === `${FIRST}\n\n${formatted}\n\n${THIRD}`, "only the second statement is laid out, its string and comment as typed");
await page.screenshot({ path: `${OUT}/1-caret-statement.png` });

// 2. One undo step.
await page.keyboard.press("ControlOrMeta+Z");
await page.waitForTimeout(100);
check((await value()) === TEXT, "⌘Z brings the text back in one step");
await page.screenshot({ path: `${OUT}/2-undone.png` });

// 3. A selection formats every statement it touches.
await page.keyboard.press("ControlOrMeta+A");
await page.keyboard.press("Control+I");
check(await changed(TEXT), "⌘I with everything selected changes the text");
const all = await value();
check(all === `SELECT    1;\n\n${formatted}\n\nSELECT    3`, "all three statements are laid out");
const sel = await page.$eval(editor, (ta) => [ta.selectionStart, ta.selectionEnd]);
check(sel[0] === 0 && sel[1] === all.length, "the selection stays on what was formatted");
await page.screenshot({ path: `${OUT}/3-all-selected.png` });

// 4. A parse error leaves the text alone and says where.
const BAD = "select 1;\nselect from where );";
await setText(BAD, BAD.length - 2);
await page.keyboard.press("Control+I");
const toast = await page.waitForSelector('[data-toast="error"]', { timeout: 5000 }).catch(() => null);
check(!!toast, "an error toast shows");
// Text on purpose: the toast names the editor's line.
check(((await toast?.textContent()) ?? "").includes("line 2"), "the toast names line 2");
check((await value()) === BAD, "the text stays as typed");
await page.screenshot({ path: `${OUT}/4-parse-error.png` });

// 5. ⌘K finds it by a synonym.
await setText(TEXT, 2);
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("prettify");
const row = await page
  .waitForSelector('[data-testid="cp-row"][data-item="cmd:format-sql"][aria-selected="true"]', { timeout: 3000 })
  .catch(() => null);
check(!!row, "⌘K prettify picks Format SQL");
await page.screenshot({ path: `${OUT}/5-palette.png` });
await page.keyboard.press("Enter");
check(await changed(TEXT), "↵ formats");
check((await value()) === `SELECT    1;\n\n${SECOND}\n\n${THIRD}`, "from ⌘K, the caret's statement only");

// 6. A table tab keeps ⌘I for Insert row.
await page.click(`${ws} [data-table="rowkery.public.orders"] [data-testid="sb-row-main"]`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "2", ws);
await page.click(`${ws} [data-testid="rg-body"] [data-row="0"] [data-col="1"]`);
await page.keyboard.press("Control+I");
const tray = await page.waitForSelector(`${ws} [data-edit-tray]`, { timeout: 3000 }).catch(() => null);
check(!!tray, "⌘I in a table tab's grid stages a new row");
await page.screenshot({ path: `${OUT}/6-table-insert-row.png` });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log(`screenshots in ${OUT}`);
