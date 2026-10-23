#!/usr/bin/env node
// Staged edits stay with the connection they were staged on (rowkery/reports#8;
// stubbed `invoke`, two Postgres connections whose `rowkery` databases both
// have public.kiosks). Stage an edit on staging, ⇧⌘O to prod: the tab stays,
// the edits bar is gone, a toast says the edits are parked, and ⌘S commits
// nothing. Back on staging the bar returns with the edit, and its commit
// names staging. ⌘A then ⌫ then ⌘S opens Review SQL instead of committing
// (safe mode Off); its Commit sends the SQL it showed. Esc's Discard keeps
// its Undo through another toast (⌘C's "Copied"): ⌥⌘Z still brings the edits
// back, and the Undo toast returns once the other one goes.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/edits-connection-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/edits-connection";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const col = (name, type_name, extra = {}) => ({ name, type_name, nullable: true, ...extra });
  const tables = [
    {
      name: "kiosks",
      kind: "table",
      columns: [col("id", "bigint", { nullable: false }), col("city", "text")],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 3 },
      partition_of: null,
    },
  ];
  const conn = (id, name) => ({ kind: "postgres", id, name, host: `${id}.example`, port: 5432, database: "rowkery", username: "rowkery", safe_mode: "off" });
  const conns = [conn("staging", "Staging"), conn("prod", "Prod")];
  window.__CALLS__ = [];
  window.__CLIP__ = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t) => void window.__CLIP__.push(t), readText: async () => window.__CLIP__.at(-1) ?? "" },
  });
  const sqlFor = (changes) =>
    `BEGIN;\n${changes.map((c) => (c.op === "delete" ? `DELETE FROM public.kiosks WHERE id = ${c.key[0].value.Int};` : `UPDATE public.kiosks SET city = '${c.set?.[0]?.value?.Text}' WHERE id = ${c.key[0].value.Int};`)).join("\n")}\nCOMMIT;`;
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      window.__CALLS__.push([cmd, rest]);
      switch (cmd) {
        case "list_connections":
          return { connections: conns, active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: ++nextId };
        case "review_changes":
          return { statements: [], sql: sqlFor(rest.changes) };
        case "apply_changes": {
          const n = (op) => rest.changes.filter((c) => c.op === op).length;
          return { status: "committed", inserted: n("insert"), updated: n("update"), deleted: n("delete"), elapsed_ms: 4 };
        }
        case "browse_table": {
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: [{ name: "id", type_name: "int8" }, { name: "city", type_name: "text" }] });
            send({ t: "rows", seq: 0, rows: [1, 2, 3].map((i) => [{ Int: i }, { Text: `c${i}` }]) });
            send({ t: "done", status: "ok", row_count: 3, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: "SELECT * FROM public.kiosks\nORDER BY id\nLIMIT 1000;" };
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
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const connectTo = async (id) => {
  const opens = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "open_window").length);
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.click(`[data-testid="conn-popover"] [data-conn-id="${id}"] button`);
  await page.waitForFunction(
    ([n, id]) => window.__CALLS__.filter(([c, a]) => c === "open_window" && a.connectionId === id).length > 0 && window.__CALLS__.filter(([c]) => c === "open_window").length > n,
    [opens, id],
  );
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const cell = (row, col) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${col}"]`);
const rowMark = (row) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"]`).getAttribute("data-mark");
const tray = () => page.locator(`${ws} [data-edit-tray]`);
const changes = () => tray().getAttribute("data-changes", { timeout: 1000 }).catch(() => null);
const applied = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "apply_changes").map(([, a]) => a));
// Text on purpose: the toast's words are what's under test.
const toastText = () => page.locator("[data-toast] [data-testid=toast-message]").textContent({ timeout: 1500 }).catch(() => null);
const stageText = async (row, col, text) => {
  await cell(row, col).click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};
const showsRows = () =>
  page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "3", ws);

await page.waitForSelector(ws);
await connectTo("staging");
await page.click(`${ws} [data-table="rowkery.public.kiosks"] [data-testid="sb-row-main"]`);
await showsRows();
await settle();

// 1. Staged on staging.
await stageText(0, 1, "Ipoh");
check((await rowMark(0)) === "edit" && (await changes()) === "1", "an edit is staged on staging; the bar counts 1");
await shot("1-staged-on-staging");

// 2. ⇧⌘O to prod: the tab stays, the edits are parked, ⌘S sends nothing.
await connectTo("prod");
await showsRows();
await settle();
check((await page.locator(`${ws} [data-testid="query-tab"][data-title="kiosks"]`).count()) === 1, "the kiosks tab stays open on prod");
check((await tray().count()) === 0, "the edits bar is gone on prod");
check((await rowMark(0)) === null, "row 1 shows no edit mark on prod");
const parked = await toastText();
check(parked === "Parked 1 edit staged on Staging", `a toast says the edit is parked (${parked})`);
await shot("2-parked-on-prod");
await cell(1, 1).click();
await page.keyboard.press("Control+s");
await page.waitForTimeout(200);
check((await applied()).length === 0, "⌘S on prod commits nothing");

// 3. Back on staging: the bar and the edit come back, and the commit names staging.
await connectTo("staging");
await showsRows();
await settle();
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes") === "1", ws, { timeout: 3000 });
check((await rowMark(0)) === "edit", "back on staging, the edit and its bar return");
check((await toastText()) === "Restored 1 edit staged on Staging", `a toast says so (${await toastText()})`);
await shot("3-restored-on-staging");
await page.keyboard.press("Control+s");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
const sent = (await applied()).at(-1);
check(sent.connectionId === "staging" && sent.changes.length === 1, `apply_changes names the connection the edit was staged on (${sent.connectionId})`);
await settle();
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-edit-tray]`), ws, { timeout: 3000 });

// 4. ⌘A ⌫ ⌘S: Review SQL first, even with safe mode Off.
await cell(0, 0).click();
await page.keyboard.press("Control+a");
await page.keyboard.press("Backspace");
check((await rowMark(0)) === "delete" && (await rowMark(2)) === "delete" && (await changes()) === "3", "every loaded row is marked for delete");
const before = (await applied()).length;
await page.keyboard.press("Control+s");
await page.waitForSelector("[data-review-sql] [data-review-text*='DELETE']");
check((await applied()).length === before, "⌘S opened Review SQL and committed nothing");
await shot("4-review-before-delete-all");
await page.click("[data-review-sql] [data-review-commit]");
await page.waitForSelector(`${ws} [data-edit-tray="done"]`);
const reviewed = (await applied()).at(-1);
check(reviewed.confirmed?.includes("DELETE FROM public.kiosks WHERE id = 3"), "Review's Commit sends the SQL it showed");
await settle();
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-edit-tray]`), ws, { timeout: 3000 });

// 5. Esc discards; another toast doesn't take its Undo.
await stageText(1, 1, "Klang");
await page.locator(`${ws} [data-testid="results-grid-wrap"]`).focus();
await page.keyboard.press("Escape");
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-edit-tray]`), ws, { timeout: 1500 }).catch(() => {});
if ((await tray().count()) > 0) await page.keyboard.press("Escape");
await page.waitForFunction((ws) => !document.querySelector(`${ws} [data-edit-tray]`), ws, { timeout: 1500 });
check((await toastText()) === "Discarded 1 edit", "Esc discards the edit, with an Undo toast");
await cell(0, 1).click();
await page.keyboard.press("Control+c");
await page.waitForFunction(() => window.__CLIP__.length > 0);
check((await toastText())?.startsWith("Copied"), "⌘C's toast replaces it on screen");
await page.waitForFunction(() => document.querySelector("[data-toast] [data-testid=toast-message]")?.textContent === "Discarded 1 edit", null, { timeout: 5000 });
check((await page.locator("[data-toast-undo]").count()) === 1, "once Copied goes, the Discard toast and its Undo come back");
await shot("5-undo-back");
await page.keyboard.press("Control+Alt+z");
await page.waitForFunction((ws) => document.querySelector(`${ws} [data-edit-tray]`)?.getAttribute("data-changes") === "1", ws, { timeout: 3000 });
check((await rowMark(1)) === "edit", "⌥⌘Z puts the discarded edit back");

await browser.close();
