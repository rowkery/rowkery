#!/usr/bin/env node
// The key strip (stubbed `invoke`, Linux keys): "one retiring line" per
// zone (chosen 2026-10-05).
//
// 1. The editor's strip (left of Run) and the grid's (over its bottom edge)
//    stay while shown, focused or not, 12.5 px (2026-10-13); the
//    panel's (under the filter box) shows only while the panel has focus.
// 2. Every key comes from the registry's canRun: while a query runs the
//    editor's first item is "Ctrl+. cancel", and Ctrl+. cancels; a query
//    tab's grid offers find, a table tab's filter and "↵ edit" (it has a primary key).
// 3. The editor's strip never retires now: after each of its keys was
//    pressed three times, and across a relaunch, it is still there, with no
//    glyph and no ⌘K "Show key hints" (2026-10-13).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/key-strip-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/key-strip";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "wallet" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  window.__CALLS__ = [];
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: false });
  const tables = [
    { name: "kiosks", kind: "table", columns: [col("id"), col("city", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 2 }, partition_of: null },
  ];
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.table} LIMIT 1000`;
        case "run_query": {
          if (args.sql.includes("pg_sleep")) {
            await new Promise((resolve) => (window.__PENDING__ = resolve));
            return { columns: [], rows: [], row_count: 0, elapsed_ms: 5, error: null, cancelled: true };
          }
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "city", type_name: "text" }],
            rows: [[{ Int: 1 }, { Text: "KL" }], [{ Int: 2 }, { Text: "Penang" }]],
            row_count: 2,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
        }
        case "cancel_query":
          window.__PENDING__?.();
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
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const connected = () => page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await connected();
await page.waitForTimeout(300);

/** zone → "keys label · …" for every strip on screen. */
const strips = () =>
  page.$$eval("[data-key-strip]", (els) =>
    Object.fromEntries(
      els.map((e) => [
        e.dataset.keyStrip,
        [...e.querySelectorAll("[data-strip-item]")].map((i) => `${i.dataset.keys} ${i.textContent.replace(/^·/, "").trim().split(" ").pop()}`).join(" · "),
      ]),
    ),
  );
const editor = `${ws} textarea[data-testid="sql-editor"]`;
const focusEditor = async () => {
  await page.click(editor);
  await page.waitForTimeout(80);
};

// 1 · Nothing focused: only the persistent editor strip (2026-10-13).
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(100);
check(Object.keys(await strips()).join() === "editor", `nothing focused: only the editor's strip, which stays (${Object.keys(await strips()).join()})`);
check(!!(await page.$(`${ws} [data-testid="sb-filter"] + [data-key-strip-slot]`)), "the panel keeps its line reserved, so focusing a row never shifts the list");
await focusEditor();
let s = await strips();
check(
  Object.keys(s).join() === "editor" && s.editor === "Ctrl+↵ run · Ctrl+E plan · Ctrl+Space complete · Ctrl+K search · Ctrl+N connect · Ctrl+Shift+/ keys",
  `editor focused: ${JSON.stringify(s)}`,
);
check(!!(await page.$(`${ws} [data-testid="composer"] [data-key-strip="editor"] + [data-testid="run-btn"]`)), "it sits left of Run");
const fontSize = await page.$eval('[data-key-strip="editor"]', (e) => getComputedStyle(e).fontSize);
check(fontSize === "12.5px", `12.5 px (${fontSize})`);
await page.screenshot({ path: `${OUT}/1-editor.png` });

// 2 · Running: Ctrl+. cancel first, and it cancels.
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT pg_sleep(30);");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(250);
s = await strips();
check(s.editor?.startsWith("Ctrl+. cancel ·") && !s.editor.includes("run"), `running: ${s.editor}`);
await page.screenshot({ path: `${OUT}/2-running.png` });
await page.keyboard.press("Control+Period");
await page.waitForTimeout(300);
check((await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "cancel_query").length)) === 1, "Ctrl+. cancelled it");
check((await strips()).editor?.startsWith("Ctrl+↵ run"), "and Run is back first");

// Grid: a query tab's result.
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT 1;");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"] [data-col]`);
await page.click(`${ws} [data-testid="results-grid-wrap"] [data-col]`);
await page.waitForTimeout(100);
s = await strips();
check(Object.keys(s).sort().join() === "editor,grid" && s.grid === "Space look · Ctrl+F find · Ctrl+C copy · ? keys", `grid focused (query tab): ${JSON.stringify(s)}`);
check(!!(await page.$(`${ws} [data-testid="results-card"] > [data-key-strip="grid"]`)), "an overlay in the results card");
await page.screenshot({ path: `${OUT}/3-grid.png` });
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(350);
check(!!(await page.$('[data-key-strip="grid"]')), "it stays after the next key (no fade since 2026-10-13)");

// Panel.
await page.focus(`${ws} [data-testid="sb-row-main"]`);
await page.waitForTimeout(100);
s = await strips();
check(Object.keys(s).sort().join() === "editor,grid,panel" && s.panel === "/ filter · ↵ open · Ctrl+B hide · ? keys", `panel focused: ${JSON.stringify(s)}`);
check(!!(await page.$(`${ws} [data-testid="sb-filter"] + [data-key-strip="panel"]`)), "under the filter box");
await page.screenshot({ path: `${OUT}/4-panel.png` });

// A table tab's grid: edit and filter.
await page.click(`${ws} [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"] [data-col]`);
await page.click(`${ws} [data-testid="results-grid-wrap"] [data-col]`);
await page.waitForTimeout(100);
s = await strips();
check(s.grid === "↵ edit · Space look · Ctrl+F filter · Ctrl+C copy · ? keys", `grid focused (table tab): ${s.grid}`);

// 3 · The editor's keys pressed three times each: its strip stays.
await page.click(`${ws} [data-testid="query-tab"][data-reorder-key]`);
await page.waitForSelector(editor);
const closeOverlay = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};
for (let n = 0; n < 3; n++) {
  await focusEditor();
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(150);
  await focusEditor();
  await page.keyboard.press("Control+Space");
  await page.keyboard.press("Escape");
  await focusEditor();
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await closeOverlay();
  await focusEditor();
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(200);
  await closeOverlay();
  await focusEditor();
  check(!!(await page.$('[data-key-strip="editor"]')), `still shown after ${n + 1} round${n ? "s" : ""}`);
  await page.keyboard.press("Control+Shift+Slash");
  await page.waitForSelector("[data-shortcuts]");
  await closeOverlay();
}
await focusEditor();
await page.waitForTimeout(200);
await page.waitForTimeout(1200); // persist.ts flushes within a second
const used = await page.evaluate(() => JSON.parse(localStorage.getItem("rowkery.usedKeys") ?? "{}"));
check(["run", "complete", "command-palette", "new-connection", "keyboard-shortcuts"].every((k) => used[k] >= 3), `each editor key pressed 3× (${JSON.stringify(used)})`);
check(!!(await page.$('[data-key-strip="editor"]')), "the editor strip stays (it no longer retires)");
check(!(await page.$(`${ws} [data-key-strip-glyph="editor"]`)), "and no keyboard glyph replaces it");
await page.click(`${ws} [data-testid="results-grid-wrap"] [data-col]`).catch(() => {});
await page.waitForTimeout(100);
await page.screenshot({ path: `${OUT}/5-editor-retired.png` });
await page.focus(`${ws} [data-testid="sb-row-main"]`);
await page.waitForTimeout(100);
check(!!(await page.$('[data-key-strip="panel"]')), "the panel keeps its own strip");

// Retired across a relaunch.
await page.waitForTimeout(1300);
await page.reload();
await connected();
await focusEditor();
check(!!(await page.$('[data-key-strip="editor"]')), "still there after a relaunch");

// ⌘K offers no Show key hints: nothing retired.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">key hints");
await page.waitForTimeout(200);
check(!(await page.$('[data-item="cmd:show-key-hints"]')), "⌘K offers no Show key hints while nothing retired");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

await browser.close();
