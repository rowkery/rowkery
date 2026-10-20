#!/usr/bin/env node
// Filter chips on a table tab (stubbed `invoke`; the stub builds SQL the way
// core does): ⌘F opens one chip editor in the SQL line (value focused, "any
// text column", ILIKE); a typed value becomes an ILIKE chip over the text
// columns, `amount > 100` a chip, free SQL an expression chip. Chips read as
// the SQL they add, joined by AND, inside core's WHERE (…). Click edits a
// chip, × and ⌫ remove one. Right-click a value, click a profile segment or
// drag across histogram bars to add chips. Typing on a cell is locked until
// the first chip, then opens the chip editor for that column (# still
// counts). Typing in the column and operator pickers moves to the row that
// starts with it, ↵ picks it. Chips persist with the tab. ⌘F on a query tab
// finds in the rows.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/filter-chips-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/filter-chips";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("relaunch")) localStorage.clear();
  window.__CALLS__ = [];
  const TOTAL = 36150;
  const col = (name, type_name, nullable = false) => ({ name, type_name, nullable });
  const COLUMNS = [col("id", "int8"), col("amount", "numeric"), col("status", "text"), col("note", "text", true), col("kiosk_id", "int4")];
  const tables = [{ name: "wallet_tx", kind: "table", columns: COLUMNS, primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: TOTAL }, partition_of: null }];
  // Like core's table_browse_query (first page).
  const browseSql = (a) => {
    let sql = `SELECT * FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    return sql + ";";
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "wallet-prd", host: "db", port: 5432, database: "wallet", username: "app" }], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table_sql":
          return browseSql(args);
        case "run_query": {
          window.__LAST_SQL__ = args.sql;
          const limit = Number(/LIMIT (\d+)/.exec(args.sql)?.[1] ?? 1000);
          const filtered = /WHERE/.test(args.sql);
          const n = filtered ? 312 : Math.min(limit, TOTAL);
          return {
            columns: COLUMNS.map((c) => ({ name: c.name, type_name: c.type_name })),
            rows: Array.from({ length: n }, (_, i) => [
              { Int: 48207 - i },
              { Text: ["920.00", "410.50", "388.00", "52.00"][i % 4] },
              { Text: i % 4 ? "settled" : "pending" },
              i % 3 ? "Null" : { Text: i % 2 ? "fee for Bangsar" : "it's ok" },
              { Int: 1 + (i % 5) },
            ]),
            row_count: n,
            elapsed_ms: 3,
            error: null,
            cancelled: false,
          };
        }
        case "count_rows":
          await new Promise((r) => setTimeout(r, 50));
          return args.filter ? 312 : 36152;
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
const lineText = () => page.getAttribute(`${line} [data-sql-text]`, "data-sql-text");
const waitLine = (part) =>
  page.waitForFunction(([sel, s]) => document.querySelector(sel)?.getAttribute("data-sql-text")?.includes(s), [`${line} [data-sql-text]`, part]);
const chips = () => page.$$eval(`${line} [data-chip]`, (els) => els.map((e) => [e.getAttribute("data-chip-kind"), e.getAttribute("data-chip-sql")]));
const editor = `${line} [data-chip-editor]`;
const cell = (row, col) => `${ws} [data-row="${row}"] [data-col="${col}"]`;
const idle = () => page.waitForFunction((sel) => !document.querySelector(sel)?.querySelector('[data-state="running"]'), `${line} [data-line-end]`);

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row]`);
await waitLine("LIMIT 1000");

// Before the first chip: typing on a cell only shows the tip; # still counts.
await page.click(cell(0, 2));
await page.keyboard.press("p");
await page.waitForSelector(`${line} [data-tip]`);
check((await page.$(editor)) === null, "type-to-filter is locked before the first chip (no editor)");
check((await page.textContent(`${line} [data-tip]`)).includes("typing filters after your first filter"), `locked tip: ${await page.textContent(`${line} [data-tip]`)}`);
await page.keyboard.press("Shift+Digit3");
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("36,152"), `${line} [data-line-end]`);
check(true, "# counts exactly, never starts a chip");

// ⌘F → chip editor, value focused, any text column, ILIKE.
await page.keyboard.press("Control+f");
await page.waitForSelector(editor);
check((await page.getAttribute(editor, "data-column")) === "*" && (await page.getAttribute(editor, "data-op")) === "ILIKE", "⌘F: any text column · ILIKE");
check(await page.evaluate((sel) => document.activeElement === document.querySelector(`${sel} textarea`), editor), "the value field has focus");
await page.keyboard.type("bangsar");
await page.screenshot({ path: `${OUT}/1-editor.png` });
await page.keyboard.press("Enter");
await waitLine("WHERE");
await idle();
check((await lineText()) === "SELECT * FROM public.wallet_tx WHERE (status ILIKE '%bangsar%' OR note ILIKE '%bangsar%') ORDER BY id LIMIT 1000;", `ILIKE over the text columns: ${await lineText()}`);
check(JSON.stringify(await chips()) === JSON.stringify([["any", "status ILIKE '%bangsar%' OR note ILIKE '%bangsar%'"]]), `one chip: ${JSON.stringify(await chips())}`);
check(/WHERE \(status ILIKE/.test(await page.evaluate(() => window.__LAST_SQL__)), "the query that ran has the chip's WHERE");
await page.waitForSelector(`${line} [data-tip]`);
check((await page.textContent(`${line} [data-tip="type-to-filter"]`)) === "Type on a column to filter", "first chip: tip 'Type on a column to filter'");
await page.screenshot({ path: `${OUT}/2-ilike-chip.png` });

// A bare fragment becomes a chip. ⌘F focuses the value in the same task as
// its key, before any frame: a key typed right after it lands in the value
// (focused a frame later, the first key went to the grid or nowhere).
const focusedAtOnce = await page.evaluate(async (sel) => {
  const init = { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true };
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return document.activeElement === document.querySelector(`${sel} textarea`);
}, editor);
check(focusedAtOnce, "⌘F focuses the value before the next frame");
await page.waitForSelector(editor);
await page.keyboard.type("amount > 100");
await page.keyboard.press("Enter");
await waitLine("amount > 100");
await idle();
check((await lineText()).includes("WHERE ((status ILIKE '%bangsar%' OR note ILIKE '%bangsar%') AND amount > 100) ORDER BY"), `fragment chip joined by AND: ${await lineText()}`);
check(JSON.stringify((await chips())[1]) === JSON.stringify(["pred", "amount > 100"]), "amount > 100 is a chip");

// Free SQL becomes an expression chip, untouched.
const expr = "created_at > now() - interval '1 day'";
await page.keyboard.press("Control+f");
await page.waitForSelector(editor);
await page.keyboard.insertText(expr);
await page.keyboard.press("Enter");
await waitLine("interval");
await idle();
check(JSON.stringify((await chips())[2]) === JSON.stringify(["expr", expr]), `expression chip: ${JSON.stringify((await chips())[2])}`);
check((await lineText()).includes(`AND amount > 100 AND ${expr})`), "the expression sits in the WHERE as typed");
check((await page.$$(`${line} [data-testid="sql-chip-and"]`)).length === 2, "chips joined by a dim AND");
await page.screenshot({ path: `${OUT}/3-three-chips.png` });

// Click a chip to edit it in place.
await page.click(`${line} [data-chip="1"]`);
await page.waitForSelector(`${line} [data-chip-editor="1"]`);
check((await page.getAttribute(editor, "data-column")) === "amount" && (await page.getAttribute(editor, "data-op")) === ">", "editing amount > 100: column and operator kept");
// The operator picker reads SQL with a dim gloss.
await page.click(`${editor} [data-chip-op]`);
await page.waitForSelector('[data-menu="chip-op"]');
// The picker leads with a number column's four (words first, the SQL as the gloss) and More…
const rowText = (els) => els.map((e) => e.textContent.replace(/^\s*✓\s*/, "").trim()); // Text on purpose: the rows' words and SQL.
const opRows = await page.$$eval('[data-menu="chip-op"] [data-item]', rowText);
check(
  opRows.length === 5 && opRows[0] === "is =" && opRows[1] === "more than >" && opRows[3] === "between BETWEEN" && opRows[4] === "More…",
  `operator picker, a number column: ${opRows.join(" · ")}`,
);
await page.click('[data-menu="chip-op"] [data-item="more"]');
await page.waitForFunction(() => document.querySelectorAll('[data-menu="chip-op"] [data-item]').length === 12);
const allRows = await page.$$eval('[data-menu="chip-op"] [data-item]', rowText);
check(allRows[0] === "is =" && allRows[2] === "is not, or empty IS DISTINCT FROM" && allRows[7] === "contains ILIKE" && allRows[11] === "is not empty IS NOT NULL", `More… lists them all: ${allRows.join(" · ")}`);
await page.screenshot({ path: `${OUT}/4-operator-picker.png` });
await page.click('[data-menu="chip-op"] [data-item=">="]');
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-op") === ">=", editor);
await page.focus(`${editor} textarea`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("200");
await page.keyboard.press("Enter");
await waitLine("amount >= 200");
await idle();
check(JSON.stringify((await chips())[1]) === JSON.stringify(["pred", "amount >= 200"]), "edited chip: amount >= 200");

// Type-to-select in the pickers, like a Mac menu: letters move to the row, ↵ picks it.
await page.keyboard.press("Control+f");
await page.waitForSelector(editor);
await page.click(`${editor} [data-chip-column]`);
await page.waitForSelector('[data-menu="chip-column"]');
await page.keyboard.type("st");
await page.waitForSelector('[data-menu="chip-column"] [data-item="status"].is-cursor');
await page.screenshot({ path: `${OUT}/4b-type-to-select.png` });
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-column") === "status", editor, { timeout: 2000 }).catch(() => {});
check((await page.getAttribute(editor, "data-column")) === "status", "typing st in the column picker and ↵ picks status");
await page.click(`${editor} [data-chip-op]`);
await page.waitForSelector('[data-menu="chip-op"]');
await page.keyboard.type("is n");
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-op") === "IS DISTINCT FROM", editor, { timeout: 2000 }).catch(() => {});
check((await page.getAttribute(editor, "data-op")) === "IS DISTINCT FROM", "typing is n in the operator picker and ↵ picks is not, or empty");
// In a list short enough to scroll, a typed row scrolled under a still pointer keeps the cursor.
const size = page.viewportSize();
await page.setViewportSize({ width: size.width, height: 300 });
await page.click(`${editor} [data-chip-column]`);
await page.waitForSelector('[data-menu="chip-column"]');
const scrolls = await page.$eval('[data-menu="chip-column"]', (m) => m.scrollHeight > m.clientHeight);
const first = await page.$('[data-menu="chip-column"] [data-item]');
const firstBox = await first.boundingBox();
await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
await page.keyboard.type("k");
await page.waitForTimeout(150);
const cursorRow = await page.$eval('[data-menu="chip-column"] .is-cursor', (e) => e.getAttribute("data-item")).catch(() => null);
check(scrolls && cursorRow === "kiosk_id", `a scrolling list keeps the typed row under a still pointer (scrolls: ${scrolls}, cursor: ${cursorRow})`);
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-column") === "kiosk_id", editor, { timeout: 2000 }).catch(() => {});
check((await page.getAttribute(editor, "data-column")) === "kiosk_id", "↵ picks the typed row, not the one under the pointer");
await page.setViewportSize(size);
await page.focus(`${editor} textarea`);
await page.keyboard.press("Escape");
await page.waitForFunction((sel) => !document.querySelector(sel), editor);

// × removes a chip; ⌫ removes a focused one.
await page.hover(`${line} [data-chip="2"]`);
await page.click(`${line} [data-chip-remove="2"]`);
await page.waitForFunction((sel) => !document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("interval"), `${line} [data-sql-text]`);
await idle();
check((await chips()).length === 2, "× removed the expression chip");
await page.focus(`${line} [data-chip="0"]`);
await page.keyboard.press("Backspace");
await page.waitForFunction((sel) => !document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("bangsar"), `${line} [data-sql-text]`);
await idle();
check((await lineText()) === "SELECT * FROM public.wallet_tx WHERE (amount >= 200) ORDER BY id LIMIT 1000;", `⌫ removed the focused chip: ${await lineText()}`);

// ↵ in the value applies what was typed, even with a completion list open
// ("match" lists regexp_match); only an arrowed-to or ⌃Space item is taken.
await page.keyboard.press("Control+f");
await page.waitForSelector(editor);
await page.keyboard.type("no-match");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("no-match"), `${line} [data-sql-text]`);
await idle();
check((await lineText()).includes("ILIKE '%no-match%'") && !(await lineText()).includes("regexp"), `↵ applies the typed value: ${await lineText()}`);
await page.focus(`${line} [data-chip="1"]`);
await page.keyboard.press("Backspace");
await page.waitForFunction((sel) => !document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("no-match"), `${line} [data-sql-text]`);
await idle();

// Right-click a value → Only rows where status = 'settled'.
await page.click(cell(1, 2), { button: "right" });
await page.waitForSelector('[data-menu="grid"] [data-item="f-only"]');
const menuRows = await page.$$eval('[data-menu="grid"] [data-item^="f-"]', (els) => els.map((e) => e.textContent.trim()));
// status is NOT NULL here, so there's no "IS NULL" row (it could only be empty).
check(
  menuRows.join(" · ") === "Only rows where status = 'settled' · Hide rows where status = 'settled'",
  `cell menu: ${menuRows.slice(0, 3).join(" · ")}`,
);
await page.screenshot({ path: `${OUT}/5-cell-menu.png` });
await page.click('[data-menu="grid"] [data-item="f-only"]');
await waitLine("status = 'settled'");
await idle();
check(JSON.stringify((await chips())[1]) === JSON.stringify(["pred", "status = 'settled'"]), "right-click value → chip status = 'settled'");
// Hide rows on a number: kiosk_id <> 2 (unquoted).
await page.click(cell(1, 4), { button: "right" });
await page.click('[data-menu="grid"] [data-item="f-hide"]');
await waitLine("kiosk_id IS DISTINCT FROM 2");
await idle();
check(true, "Hide rows where kiosk_id = 2 → kiosk_id IS DISTINCT FROM 2 (keeps the NULL rows)");

// A profile segment → status = 'pending'.
await page.click(`${ws} [data-header="status"] [data-seg="pending"]`);
await waitLine("status = 'pending'");
await idle();
check((await chips()).some(([, sql]) => sql === "status = 'pending'"), "profile segment → status = 'pending'");
check((await page.$(`${ws} [data-testid="rg-sort"]`)) === null, "the segment click didn't sort");

// Drag across histogram bars → kiosk_id BETWEEN 1 AND 3.
const hist = await page.$(`${ws} [data-header="kiosk_id"] [data-hist]`);
const box = await hist.boundingBox();
await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 });
await page.screenshot({ path: `${OUT}/6-histogram-drag.png` });
await page.mouse.up();
await waitLine("kiosk_id BETWEEN 1 AND 3");
await idle();
check((await chips()).some(([, sql]) => sql === "kiosk_id BETWEEN 1 AND 3"), "histogram drag → kiosk_id BETWEEN 1 AND 3");
check((await page.$(`${ws} [data-testid="rg-sort"]`)) === null, "the drag didn't sort");
await page.screenshot({ path: `${OUT}/7-grid-chips.png` });

// Unlocked: typing on a status cell opens the chip editor for status.
await page.click(cell(2, 2));
await page.keyboard.press("p");
await page.waitForSelector(editor);
check((await page.getAttribute(editor, "data-column")) === "status" && (await page.getAttribute(editor, "data-op")) === "ILIKE", "type-to-filter: chip editor on status");
check((await page.inputValue(`${editor} textarea`)) === "p", "the key is the first character");
await page.screenshot({ path: `${OUT}/8-type-to-filter.png` });
await page.keyboard.press("Escape");
await page.waitForFunction((sel) => !document.querySelector(sel), editor);
check(true, "Esc drops the draft only");
await page.click(cell(2, 1));
await page.keyboard.press("Shift+Digit3");
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("312 of 312") || document.querySelector(sel)?.textContent.includes("Counting"), `${line} [data-line-end]`);
check((await page.$(editor)) === null, "# still counts after unlock (no editor)");
await page.keyboard.press("?");
check((await page.$(editor)) === null, "? never starts a chip");

// Chips persist with the tab.
await page.waitForTimeout(1300);
const saved = await page.evaluate(() => localStorage.getItem("rowkery.windows"));
check(saved?.includes('"chips"') && saved.includes("kiosk_id"), "chips are saved with the tab");
await page.evaluate(() => sessionStorage.setItem("relaunch", "1"));
const before = await chips();
await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, `${line} [data-chip]`);
check(JSON.stringify(await chips()) === JSON.stringify(before), `restored chips: ${(await chips()).map((c) => c[1]).join(" AND ")}`);

// ⌘F on a query tab: find in the loaded rows.
await page.click(`${ws} [data-testid="query-tab-add"]`);
await page.waitForSelector(`${ws} textarea[data-testid="sql-editor"]`);
await page.fill(`${ws} textarea[data-testid="sql-editor"]`, "SELECT * FROM wallet_tx;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-row]`);
await page.keyboard.press("Control+f");
await page.waitForSelector(`${ws} [data-find-input]`);
await page.keyboard.type("bangsar");
await page.waitForFunction((sel) => Number(document.querySelector(sel)?.getAttribute("data-find-count")) > 0, `${ws} [data-find] [data-find-count]`);
const count = await page.textContent(`${ws} [data-find] [data-find-count]`);
check(/^1 of \d+/.test(count) && (await page.$(`${ws} [data-col][data-find="current"]`)) !== null, `find: ${count}, current match ringed`);
await page.keyboard.press("Enter");
check((await page.textContent(`${ws} [data-find] [data-find-count]`)).startsWith("2 of"), "↵ steps to the next match");
await page.keyboard.press("Shift+Enter");
check((await page.textContent(`${ws} [data-find] [data-find-count]`)).startsWith("1 of"), "⇧↵ steps back");
await page.screenshot({ path: `${OUT}/9-find.png` });
await page.keyboard.press("Escape");
await page.waitForFunction((sel) => !document.querySelector(sel), `${ws} [data-find]`);
check((await page.$(`${ws} [data-col][data-find]`)) === null, "Esc clears the find");
await browser.close();
