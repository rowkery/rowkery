#!/usr/bin/env node
// Cell editing's edge cases (stubbed `invoke`, a table tab paging 2,500 rows
// by keyset; row-edits-browser-proof.mjs covers the editors themselves):
// ↵↵ on a NULL cell, and ⌘↵ on a jsonb the editor opened untouched, stage
// nothing; the JSON editor keeps a jsonb's big numbers and `1.0` as stored
// and closes when you click away; a page loading below keeps the staged
// marks and an open editor; a double-tapped ⌘S sends one commit; an edit
// staged while a commit runs stays staged after it; ⌫ on a lone cell of a
// one-column table marks its row (its row number again unmarks); the cell menu's Set
// NULL appears only where ⌥⇧N works (a nullable column, a row not marked for
// delete); ⌘C, the SQL line's selection stats and Quick Look (and its ⌘C)
// read the staged values. Find exists on query tabs only, where nothing is
// staged.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/edit-review-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/edit-review";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

const BIG_JSON = '{"n": 12345678901234567890, "price": 1.0}';

function stubTauri(BIG_JSON) {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const table = (name, columns, rows) => ({
    name,
    kind: "table",
    columns,
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const id = col("id", "bigint", { nullable: false });
  const tables = [
    table("kiosks", [id, col("name", "text", { nullable: false }), col("city", "text"), col("price", "numeric"), col("meta", "jsonb")], 2500),
    table("tags", [id], 3),
  ];
  const wire = {
    kiosks: [
      { name: "id", type_name: "int8" },
      { name: "name", type_name: "text" },
      { name: "city", type_name: "text" },
      { name: "price", type_name: "numeric" },
      { name: "meta", type_name: "jsonb" },
    ],
    tags: [{ name: "id", type_name: "int8" }],
  };
  const total = { kiosks: 2500, tags: 3 };
  const rowOf = (t, n) =>
    t === "tags"
      ? [{ Int: n }]
      : [
          { Int: n },
          { Text: `k${n}` },
          n % 5 === 1 ? { Null: null } : { Text: `c${n}` },
          { Text: `${n}.50` },
          { Text: n === 1 ? BIG_JSON : `{"floor": ${n % 5}}` },
        ];
  window.__CALLS__ = [];
  window.__CLIP__ = [];
  // A later page lands after `__PAGE_DELAY__` ms, a commit after `__APPLY_DELAY__`.
  window.__PAGE_DELAY__ = 5;
  window.__APPLY_DELAY__ = 5;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t) => void window.__CLIP__.push(t), readText: async () => window.__CLIP__.at(-1) ?? "" },
  });
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      window.__CALLS__.push([cmd, rest]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "wallet", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "apply_changes": {
          await new Promise((r) => setTimeout(r, window.__APPLY_DELAY__));
          const n = (op) => rest.changes.filter((c) => c.op === op).length;
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 24 };
        }
        case "browse_table": {
          const t = rest.table;
          const from = rest.key?.length && rest.after ? rest.after.id.Int : (rest.offset ?? 0);
          const n = Math.max(0, Math.min(rest.limit === 0 ? Infinity : rest.limit, total[t] - from));
          const queryId = ++nextId;
          setTimeout(
            () => {
              const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
              send({ t: "columns", columns: wire[t] });
              for (let i = 0; i < n; i += 500) {
                send({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, n - i) }, (_, j) => rowOf(t, from + i + j + 1)) });
              }
              send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
            },
            from > 0 ? window.__PAGE_DELAY__ : 5,
          );
          return { query_id: queryId, sql: `SELECT * FROM public.${t}\nORDER BY id\nLIMIT ${rest.limit};` };
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
const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri, BIG_JSON);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const rowCount = () => page.getAttribute(`${ws} [data-testid="results-grid-wrap"]`, "data-row-count").then(Number);
const openTable = async (name, rows) => {
  await page.click(`${ws} [data-table="rowkery.public.${name}"] [data-testid="sb-row-main"]`);
  await page.waitForFunction(([ws, rows]) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === String(rows), [ws, rows]);
  await settle();
};
const COLS = ["id", "name", "city", "price", "meta"];
const cell = (row, column) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${COLS.indexOf(column)}"]`);
const cellText = async (row, column) => (await cell(row, column).textContent()).trim();
const edited = async (row, column) => (await cell(row, column).getAttribute("data-edited")) === "";
const rowMark = (row) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"]`).getAttribute("data-mark");
const editorKind = () => page.locator(`${ws} [data-cell-editor]`).getAttribute("data-cell-editor", { timeout: 1500 }).catch(() => null);
const noEditor = async () => (await page.locator(`${ws} [data-cell-editor]`).count()) === 0;
const tray = () => page.locator(`${ws} [data-edit-tray]`);
const changes = () => tray().getAttribute("data-changes", { timeout: 1000 }).catch(() => null);
const applied = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").map(([, a]) => a));
const clip = () => page.evaluate(() => window.__CLIP__.at(-1));
const stageText = async (row, column, text) => {
  await cell(row, column).click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};

await openTable("kiosks", 1000);

// 1. ↵↵ on a NULL cell stages nothing (it used to stage '').
check((await cell(0, "city").locator('[data-testid="rg-null"]').count()) === 1, "row 1's city is NULL");
await cell(0, "city").click();
await page.keyboard.press("Enter");
check((await editorKind()) === "text", "↵ opens the editor on the NULL cell");
await page.keyboard.press("Enter");
check(await noEditor(), "↵ closes it");
check(!(await edited(0, "city")) && (await rowMark(0)) === null && (await tray().count()) === 0, "nothing staged: the cell is still NULL, no mark, no tray");
// A value typed over the same text is no edit either.
await stageText(1, "city", "c2");
check(!(await edited(1, "city")) && (await tray().count()) === 0, "retyping a cell's own value stages nothing");

// 2. The JSON editor: a jsonb past 2^53 with 1.0 opens as stored; ⌘↵ untouched stages nothing.
await cell(0, "meta").click();
await page.keyboard.press("Enter");
check((await editorKind()) === "json", "JSON editor on meta");
const opened = await page.locator(`${ws} [data-cell-editor="json"] textarea`).inputValue();
check(opened === BIG_JSON, `the editor shows the stored text (${opened})`);
await shot("1-json-as-stored");
await page.keyboard.press("Control+Enter");
check(await noEditor(), "⌘↵ closes it");
check(!(await edited(0, "meta")) && (await tray().count()) === 0, "an untouched jsonb is not staged (no rewritten value)");
// A small jsonb pretty-prints (nothing to lose) and still stages nothing untouched.
await cell(2, "meta").click();
await page.keyboard.press("Enter");
check((await page.locator(`${ws} [data-cell-editor="json"] textarea`).inputValue()) === '{\n  "floor": 3\n}', "a jsonb without lossy numbers opens pretty-printed");
await page.keyboard.press("Control+Enter");
check(!(await edited(2, "meta")), "and closes unstaged");

// 3. Clicking away closes the JSON editor and, since 2026-10-13,
//    keeps a changed value as a pending edit, like the text editor.
await cell(3, "meta").click();
await page.keyboard.press("Enter");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type('{"floor": 9}');
await cell(5, "name").click();
check(await noEditor(), "clicking another cell closes the JSON editor");
check(await edited(3, "meta"), "and keeps the changed value as a pending edit");

// 4. Set NULL in the cell menu only where ⌥⇧N works.
const menuHas = async (row, column, id) => {
  await cell(row, column).click({ button: "right" });
  await page.waitForSelector('[data-menu="grid"]');
  const has = (await page.locator(`[data-menu="grid"] [data-item="${id}"]`).count()) > 0;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-menu="grid"]'));
  return has;
};
check(await menuHas(2, "city", "set-null"), "a nullable cell's menu offers Set NULL");
check(!(await menuHas(2, "name", "set-null")), "a NOT NULL column's menu doesn't");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="4"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
check((await rowMark(4)) === "delete", "row 5 marked for delete");
check(!(await menuHas(4, "city", "set-null")), "a row marked for delete offers no Set NULL");
await cell(4, "city").click();
await page.keyboard.press("Control+Alt+n");
check(!(await edited(4, "city")), "and ⌥⇧N leaves it too");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="4"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
check((await rowMark(4)) === null, "unmarked");

// 5. Copy, selection stats and Quick Look read staged values.
await stageText(1, "city", "Ipoh");
check((await cellText(1, "city")) === "Ipoh" && (await edited(1, "city")), "city staged as Ipoh");
await cell(1, "city").click();
await page.keyboard.press("Control+c");
await page.waitForFunction(() => window.__CLIP__.length > 0);
check((await clip()) === "Ipoh", `⌘C copies the staged value (${await clip()})`);
await cell(1, "city").click();
await cell(2, "city").click({ modifiers: ["Shift"] });
await page.keyboard.press("Control+c");
await page.waitForFunction(() => window.__CLIP__.length > 1);
check((await clip()) === "Ipoh\nc3", `⌘C on a block copies staged values (${JSON.stringify(await clip())})`);
await stageText(1, "price", "10");
await cell(1, "price").click();
await cell(2, "price").click({ modifiers: ["Shift"] });
await page.waitForSelector(`${ws} [data-stats]`);
const stats = await page.textContent(`${ws} [data-stats]`);
check(stats.includes("sum 13.50"), `selection stats add the staged 10 to 3.50 (${stats})`);
await cell(1, "city").click();
await page.keyboard.press("Space");
await page.waitForSelector('[data-testid="ql-head"]');
const qlCity = await page.locator(".ql-field", { has: page.locator("dt", { hasText: /^city$/ }) }).locator("dd").textContent();
check(qlCity.trim() === "Ipoh", `Quick Look shows the staged city (${qlCity})`);
await shot("2-quick-look-staged");
await page.keyboard.press("Control+c");
await page.waitForFunction(() => window.__CLIP__.length > 2);
const qlJson = JSON.parse(await clip());
check(qlJson.city === "Ipoh" && qlJson.price === "10", `Quick Look's ⌘C copies the staged row (${qlJson.city}, ${qlJson.price})`);
await page.keyboard.press("Escape");

// 6. A page loading below keeps the marks and an open editor.
await page.evaluate(() => (window.__PAGE_DELAY__ = 700));
await cell(6, "city").click();
await page.keyboard.press("Enter");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("typing");
await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = el.scrollHeight));
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws, { timeout: 3000 }).catch(() => {});
const loading = await page.evaluate(() => window.__CALLS__.filter(([c, a]) => c === "browse_table" && a.after).length);
check(loading === 1, "scrolling to the end asked for the next page");
check((await editorKind()) === "text", "the editor stays open while the page loads");
check((await changes()) === "2", `the tray still counts the edited rows while it loads (${await changes()}: row 1, and row 3's JSON kept by the click away)`);
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "2000", ws);
await settle();
check((await editorKind()) === "text", "and after the page lands");
check((await page.locator(`${ws} [data-cell-editor] input`).inputValue()) === "typing", "with the text typed so far");
await page.keyboard.press("Escape");
await page.$eval(`${ws} [data-testid="results-grid-wrap"]`, (el) => (el.scrollTop = 0));
await page.waitForTimeout(100);
check((await edited(1, "city")) && (await edited(1, "price")), "the staged cells still show their marks");
await page.evaluate(() => (window.__PAGE_DELAY__ = 5));

// 7. A double-tapped ⌘S sends one commit; an edit staged while it runs stays.
await page.evaluate(() => (window.__APPLY_DELAY__ = 600));
await page.keyboard.press("Control+s");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="committing"]`);
await page.locator(`${ws} [data-commit]`).click({ force: true }).catch(() => {});
await stageText(7, "city", "Klang");
check(await edited(7, "city"), "an edit staged while the commit runs shows");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`, { timeout: 4000 });
const sent = await applied();
check(sent.length === 1, `one apply_changes for a double ⌘S and a click (${sent.length})`);
check(sent[0].changes.length === 2 && sent[0].changes.some((c) => c.set.length === 2), "it carried row 1's two staged cells (and row 3's JSON)");
await settle();
await page.waitForTimeout(200);
check(await edited(7, "city"), "the edit staged during the commit is still staged");
check(!(await edited(1, "city")) && !(await edited(1, "price")), "the committed cells are no longer marked");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes") === "1", ws, { timeout: 4000 });
check(true, "the tray counts the 1 left");
await shot("3-after-commit");
await page.evaluate(() => (window.__APPLY_DELAY__ = 5));
await page.locator(`${ws} [data-discard]`).click();

// 8. ⌫ on a one-column table: a lone cell marks its row, like any cell; its row number again unmarks.
await openTable("tags", 3);
await page.locator(`${ws} [data-testid="rg-body"] [data-row="0"] [data-col="0"]`).click();
await page.keyboard.press("Backspace");
check((await rowMark(0)) === "delete", "⌫ on a lone cell of a one-column table marks its row");
await page.locator(`${ws} [data-testid="rg-body"] [data-row="0"] [data-testid="rg-gutter"]`).click();
await page.keyboard.press("Backspace");
check((await rowMark(0)) === null, "⌫ on its row number unmarks it");
await shot("4-one-column");

await browser.close();
