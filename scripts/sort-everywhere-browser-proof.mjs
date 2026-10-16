#!/usr/bin/env node
// Sort everywhere (stubbed `invoke`; the stub builds SQL the way core does,
// with an explicit column list and several ORDER BY keys, and orders its rows
// by them): on a table tab a header click cycles asc → desc → off on the
// server, the ORDER BY clause of the SQL line rewrites and gets the 600 ms
// neutral wash (captured mid-wash); ⇧-click adds a secondary key marked "2";
// the header menu sorts, hides a column (the line's SELECT lists the rest, a
// "Hid note · Undo" toast, a 6 px grip that shows it again) and copies its
// name. On a query tab a header click sorts the loaded rows (hollow arrow),
// and the cell menu opens the table the query reads as a table tab.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sort-everywhere-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sort-everywhere";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const COLS = [
    ["id", "int8"],
    ["wallet_id", "int8"],
    ["amount", "numeric"],
    ["status", "text"],
    ["note", "text"],
  ];
  const col = ([name, type_name]) => ({ name, type_name, nullable: name !== "note" });
  const tables = [{ name: "wallet_tx", kind: "table", columns: COLS.map(col), primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 36150 }, partition_of: null }];
  // Twelve rows: amounts repeat so a secondary key matters; some notes NULL.
  const DATA = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    wallet_id: 1000 + (i % 4),
    amount: [50, 920, 410, 50, 388, 920][i % 6],
    status: i % 3 ? "settled" : "pending",
    note: i % 4 ? `fee ${i}` : null,
  }));
  // Like core's table_browse_query (first page).
  const browseSql = (a) => {
    const list = a.columns?.length ? a.columns.join(", ") : "*";
    let sql = `SELECT ${list} FROM ${a.schema}.${a.table}`;
    if (a.filter?.trim()) sql += `\nWHERE (${a.filter.trim()})`;
    const order = [...(a.order ?? []).map((o) => `${o.column}${o.desc ? " DESC" : ""} NULLS LAST`), ...(a.key ?? []).filter((k) => !(a.order ?? []).some((o) => o.column === k))];
    if (order.length) sql += `\nORDER BY ${order.join(", ")}`;
    if (a.limit) sql += `\nLIMIT ${a.limit}`;
    return sql + ";";
  };
  const cell = (v) => (v === null ? "Null" : typeof v === "number" ? { Int: v } : { Text: v });
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
          // The columns the SELECT names (or all), the rows in ORDER BY order.
          const list = /^SELECT (.*?) FROM/.exec(args.sql)?.[1] ?? "*";
          const names = list === "*" ? COLS.map((c) => c[0]) : list.split(", ");
          const keys = (/ORDER BY (.*?)(\n|;|$)/.exec(args.sql)?.[1] ?? "")
            .split(", ")
            .filter(Boolean)
            .map((k) => ({ column: k.split(" ")[0], desc: / DESC/.test(k) }));
          const rows = [...DATA].sort((a, b) => {
            for (const k of keys) {
              const x = a[k.column];
              const y = b[k.column];
              if (x === y) continue;
              if (x === null) return 1;
              if (y === null) return -1;
              return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
            }
            return 0;
          });
          return {
            columns: names.map((n) => ({ name: n, type_name: COLS.find((c) => c[0] === n)[1] })),
            rows: rows.map((r) => names.map((n) => cell(r[n]))),
            row_count: rows.length,
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const line = `${ws} [data-sql-line]`;
const lineText = () => page.getAttribute(`${line} [data-sql-text]`, "data-sql-text");
const waitLine = (text) =>
  page.waitForFunction(([sel, t]) => document.querySelector(sel)?.getAttribute("data-sql-text") === t, [`${line} [data-sql-text]`, text]);
const header = (name) => `${ws} [data-header="${name}"]`;
const sortOf = (name) =>
  page.$eval(header(name), (el) => [el.dataset.sort ?? null, el.dataset.sortRank ?? null, el.dataset.sortMode ?? null]);
const columnTexts = (c) =>
  page.$$eval(`${ws} [data-row]`, (rows, c) => rows.sort((a, b) => a.dataset.row - b.dataset.row).map((r) => r.querySelector(`[data-col="${c}"]`)?.textContent), c);

await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} [data-table="wallet.public.wallet_tx"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-row]`);
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check(true, "table tab opens on SELECT * … ORDER BY id");

// Header click: asc, with the ORDER BY clause washed (captured mid-600 ms).
await page.click(header("amount"));
await page.waitForSelector(`${line} [data-wash="order"]`);
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/1-wash-mid.png` });
const wash = await page.$eval(`${line} [data-wash="order"]`, (el) => ({
  text: el.textContent,
  bg: getComputedStyle(el).backgroundColor,
  // The wash itself, independent of when the frame was sampled.
  anim: el.getAnimations().map((a) => ({ ms: a.effect.getTiming().duration, from: a.effect.getKeyframes()[0]?.backgroundColor }))[0] ?? null,
}));
const hoverTone = await page.evaluate(() => {
  const p = document.createElement("i");
  p.style.background = "var(--hover)";
  document.body.append(p);
  const c = getComputedStyle(p).backgroundColor;
  p.remove();
  return c;
});
check(wash.text === "ORDER BY amount NULLS LAST, id", `the wash covers the ORDER BY clause: ${wash.text}`);
check(
  // Paper (2026-10-10): the wash is the paper's neutral --hover, never the accent.
  wash.anim?.ms === 600 && wash.anim?.from === hoverTone && !/217, 100, 26|238, 122, 47/.test(`${wash.bg} ${wash.anim?.from}`),
  `neutral --hover wash for 600 ms, never orange: ${wash.bg} ${JSON.stringify(wash.anim)}`,
);
check((await lineText()) === "SELECT * FROM public.wallet_tx ORDER BY amount NULLS LAST, id LIMIT 1000;", `asc: ${await lineText()}`);
check(JSON.stringify(await sortOf("amount")) === JSON.stringify(["asc", "1", "server"]), "solid ascending arrow on amount (server)");
// Paper (2026-10-10): the sort glyph is the prototype's ▲ / ▼ in the accent.
check((await page.textContent(`${header("amount")} [data-testid="rg-sort"]`)) === "▲", "glyph ▲");
await page.waitForFunction((sel) => !document.querySelector(sel), `${line} [data-wash]`, { timeout: 1500 });
check(true, "the wash is gone after 600 ms");
await page.screenshot({ path: `${OUT}/2-after-wash.png` });

// Second click: desc. Third: off (the key order only).
await page.click(header("amount"));
await waitLine("SELECT * FROM public.wallet_tx ORDER BY amount DESC NULLS LAST, id LIMIT 1000;");
check((await sortOf("amount"))[0] === "desc", "second click: descending");
check((await columnTexts(2))[0] === "920", "rows reordered by the server (920 first)");
await page.click(header("amount"));
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check((await sortOf("amount"))[0] === null, "third click: off");

// ⇧-click adds a secondary key: "2" by its arrow.
await page.click(header("amount"));
await waitLine("SELECT * FROM public.wallet_tx ORDER BY amount NULLS LAST, id LIMIT 1000;");
await page.click(header("status"), { modifiers: ["Shift"] });
await waitLine("SELECT * FROM public.wallet_tx ORDER BY amount NULLS LAST, status NULLS LAST, id LIMIT 1000;");
check(JSON.stringify(await sortOf("status")) === JSON.stringify(["asc", "2", "server"]), "⇧-click: status is sort key 2");
check((await page.textContent(`${header("status")} [data-testid="rg-sort-rank"]`)) === "2", 'a small "2" by the secondary arrow');
await page.click(header("status"), { modifiers: ["Shift"] });
await waitLine("SELECT * FROM public.wallet_tx ORDER BY amount NULLS LAST, status DESC NULLS LAST, id LIMIT 1000;");
check(true, "⇧-click again: secondary descending, primary kept");
await page.screenshot({ path: `${OUT}/3-secondary.png` });

// Header menu: Sort descending, Clear sort.
await page.click(header("amount"), { button: "right" });
await page.waitForSelector('[data-menu="header"]');
const items = await page.$$eval('[data-menu="header"] [data-item]', (els) => els.map((e) => e.textContent));
check(
  ["Sort ascending", "Sort descending", "Clear sort", "Hide column", "Copy column name"].every((t) => items.some((i) => i.startsWith(t))),
  `header menu: ${items.join(" | ")}`,
);
await page.screenshot({ path: `${OUT}/4-header-menu.png` });
await page.click('[data-menu="header"] [data-item="clear"]');
await waitLine("SELECT * FROM public.wallet_tx ORDER BY status DESC NULLS LAST, id LIMIT 1000;");
check(true, "Clear sort drops that key, the other stays");
await page.click(header("status"), { button: "right" });
await page.click('[data-menu="header"] [data-item="clear"]');
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");

// Copy column name.
await page.click(header("wallet_id"), { button: "right" });
await page.click('[data-menu="header"] [data-item="copy-name"]');
await page.waitForTimeout(100);
check((await page.evaluate(() => navigator.clipboard.readText())) === "wallet_id", "Copy column name");

// Hide column: explicit SELECT list, washed; toast with Undo; a grip.
await page.click(header("note"), { button: "right" });
// Record washes as the DOM gets them (a busy machine may paint no frame
// inside the 600 ms for a poll to see).
await page.evaluate(() => {
  window.__WASHED__ = [];
  new MutationObserver((ms) => {
    for (const m of ms) {
      const nodes = m.type === "attributes" ? [m.target] : [...m.addedNodes];
      for (const n of nodes) {
        if (!(n instanceof Element)) continue;
        // The washed clause, or a part of the line that holds it.
        for (const w of [n, ...n.querySelectorAll("[data-wash]")])
          if (w.dataset?.wash) window.__WASHED__.push([w.dataset.wash, w.textContent]);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-wash"] });
});
await page.click('[data-menu="header"] [data-item="hide"]');
await waitLine("SELECT id, wallet_id, amount, status FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check(true, "Hide column rewrites the SELECT list");
const washedList = await page
  .waitForFunction(() => window.__WASHED__.find(([w]) => w === "select")?.[1], null, { timeout: 3000 })
  .then((h) => h.jsonValue(), () => null);
check(washedList === "id, wallet_id, amount, status", `the SELECT list is washed: ${washedList}`);
const toast = await page.textContent("[data-toast]");
check(/Hid note/.test(toast) && /Undo/.test(toast), `toast: ${toast}`);
check((await page.$(header("note"))) === null, "note is gone from the grid");
await page.waitForSelector(`${ws} [data-hidden-grip="note"]`);
const gripW = await page.$eval(`${ws} [data-hidden-grip="note"]`, (el) => el.getBoundingClientRect().width);
check(gripW === 6, `a 6 px grip where note was (${gripW}px)`);
await page.screenshot({ path: `${OUT}/5-hidden.png` });
// A long explicit list truncates inside the statement's body; LIMIT, ; and + Filter stay.
check((await page.$(`${line} [data-testid="sql-line-body"] [data-clause="select"]`)) !== null, "the SELECT list sits in the line's body");
await page.setViewportSize({ width: 900, height: 800 });
await page.waitForTimeout(100);
const fit = await page.evaluate((sel) => {
  const box = document.querySelector(`${sel} [data-sql-text]`).getBoundingClientRect();
  const body = document.querySelector(`${sel} [data-testid="sql-line-body"]`);
  // Paper (2026-10-10): + Filter sits in the WHERE row, under the QUERY row.
  const whereBox = document.querySelector(`${sel} [data-testid="sql-line-where"]`).getBoundingClientRect();
  const inside = (q) => {
    const r = document.querySelector(`${sel} ${q}`).getBoundingClientRect();
    const b = q === "[data-add-filter]" ? whereBox : box;
    return r.width > 0 && r.left >= b.left && r.right <= b.right + 1;
  };
  return { cut: body.scrollWidth > body.clientWidth, limit: inside("[data-limit]"), filter: inside("[data-add-filter]") };
}, line);
check(fit.cut && fit.limit && fit.filter, `narrow window: the body gives way, LIMIT and + Filter stay (${JSON.stringify(fit)})`);
await page.screenshot({ path: `${OUT}/5b-hidden-narrow.png` });
await page.setViewportSize({ width: 1280, height: 800 });
// Undo puts it back.
await page.click("[data-toast-undo]");
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check((await page.$(`${ws} [data-hidden-grip]`)) === null, "Undo shows note again (SELECT *)");
// Hide again; the grip's menu shows it.
await page.click(header("status"), { button: "right" });
await page.click('[data-menu="header"] [data-item="hide"]');
await waitLine("SELECT id, wallet_id, amount, note FROM public.wallet_tx ORDER BY id LIMIT 1000;");
// Saved once typing pauses (persist.ts flushes after a second).
const saved = await page
  .waitForFunction(() => (localStorage.getItem("rowkery.windows") ?? "").includes('"hidden":["status"]'), null, { timeout: 4000 })
  .then(() => true, () => false);
check(saved, "hidden columns persist with the tab");
await page.click(`${ws} [data-hidden-grip="status"]`);
await page.waitForSelector('[data-menu="hidden-columns"]');
await page.screenshot({ path: `${OUT}/6-grip-menu.png` });
await page.click('[data-menu="hidden-columns"] [data-item="status"]');
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check(true, "the grip's menu shows the column again");

// A filter chip from the cell menu washes the WHERE clause (its chips) too.
await page.click(`${ws} [data-row="0"] [data-col="3"]`, { button: "right" });
await page.click('[data-menu="grid"] [data-item="f-only"]');
await page.waitForFunction(
  (sel) => document.querySelector(sel)?.getAttribute("data-sql-text")?.includes("WHERE (status = 'pending')"),
  `${line} [data-sql-text]`,
);
const whereWashed = await page
  .waitForFunction(() => window.__WASHED__.some(([w]) => w === "where"), null, { timeout: 3000 })
  .then(() => true, () => false);
check(whereWashed, "a new chip washes the WHERE clause");
await page.hover(`${line} [data-chip="0"]`);
await page.click(`${line} [data-chip-remove="0"]`);
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");

// Query tab: client-side sort (hollow arrow), then Open as table tab.
await page.click(`${ws} [data-testid="query-tab"][data-title="Query 1"]`);
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT * FROM public.wallet_tx");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-row]`);
const runs = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "run_query").length);
await page.click(header("note"));
await page.waitForSelector(`${header("note")}[data-sort="asc"]`);
check(JSON.stringify(await sortOf("note")) === JSON.stringify(["asc", "1", "client"]), "query tab: client sort");
check((await page.textContent(`${header("note")} [data-testid="rg-sort"]`)) === "⇧", "hollow arrow (reads differently from a server sort)");
check((await page.getAttribute(header("note"), "title")).includes("sorts the loaded rows"), "tooltip: sorts the loaded rows");
const notes = await columnTexts(4);
check(notes.slice(-3).every((t) => t === "NULL"), `NULLs last: ${notes.join(",")}`);
check(notes[0] === "fee 1" && notes[1] === "fee 10", "text in order");
check((await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "run_query").length)) === runs, "nothing reran");
await page.click(header("note"));
await page.waitForSelector(`${header("note")}[data-sort="desc"]`);
check((await columnTexts(4))[0] === "fee 9", "second click: descending");
await page.screenshot({ path: `${OUT}/7-query-client-sort.png` });

await page.click(`${ws} [data-row="0"] [data-col="0"]`, { button: "right" });
await page.waitForSelector('[data-menu="grid"] [data-item="open-table"]');
await page.screenshot({ path: `${OUT}/8-open-as-table.png` });
await page.click('[data-menu="grid"] [data-item="open-table"]');
await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-sql-line]'));
await waitLine("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
check(true, "Open as table tab lands on the table tab, no filter");
await browser.close();
