#!/usr/bin/env node
// Grid copy→paste round trip on an editable table tab (stubbed `invoke`):
// ⌘C on a 2×2 block with NULL and a multi-line cell, then paste into another
// row, keeps typed NULL vs text, empty text and embedded newlines; the toast
// counts only cells outside the table, not parse failures from CSV splitting.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/grid-paste-roundtrip-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/grid-paste-roundtrip";
const DEV_URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const ORIGIN = new URL(DEV_URL).origin;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
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
    table("paste_demo", [id, col("city", "text"), col("note", "text")], 6),
  ];
  const wire = {
    paste_demo: [
      { name: "id", type_name: "int8" },
      { name: "city", type_name: "text" },
      { name: "note", type_name: "text" },
    ],
  };
  const total = { paste_demo: 6 };
  const rowOf = (n) => [
    { Int: n },
    n === 1 ? { Null: null } : n === 2 ? { Text: "line1\nline2" } : { Text: `city${n}` },
    n === 2 ? { Text: "NULL" } : n === 3 ? { Text: "" } : { Text: `note${n}` },
  ];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "wallet", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const t = rest.table;
          const from = rest.key?.length && rest.after ? rest.after.id.Int : (rest.offset ?? 0);
          const n = Math.max(0, Math.min(rest.limit === 0 ? Infinity : rest.limit, total[t] - from));
          const queryId = ++nextId;
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: wire[t] });
            for (let i = 0; i < n; i += 500) {
              send({ t: "rows", seq: i / 500, rows: Array.from({ length: Math.min(500, n - i) }, (_, j) => rowOf(from + i + j + 1)) });
            }
            send({ t: "done", status: "ok", row_count: n, affected_rows: null, elapsed_ms: 3, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
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
const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
const page = await context.newPage();
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(DEV_URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const COLS = ["id", "city", "note"];
const cell = (row, column) => page.locator(`${ws} [data-testid="rg-body"] [data-row="${row}"] [data-col="${COLS.indexOf(column)}"]`);
const edited = async (row, column) => (await cell(row, column).getAttribute("data-edited")) === "";
const nullPill = (row, column) => cell(row, column).locator('[data-testid="rg-null"]');
const toastText = () => page.locator("[data-toast]").last().textContent();

await page.click(`${ws} [data-table="rowkery.public.paste_demo"] [data-testid="sb-row-main"]`);
await page.waitForFunction(([ws]) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "6", [ws]);

check((await nullPill(0, "city").count()) === 1, "row 1 city is NULL");
check((await cell(1, "city").textContent()).includes("line1"), "row 2 city is multi-line");

// Select 2×2 block: rows 0–1, city–note.
await cell(0, "city").click();
await cell(1, "note").click({ modifiers: ["Shift"] });
await page.keyboard.press("Control+c");
await page.waitForTimeout(100);

await cell(3, "city").click();
await page.keyboard.press("Control+v");
await page.waitForSelector("[data-toast]");

check((await nullPill(3, "city").count()) === 1, "pasted NULL stays NULL");
check(await edited(3, "note"), "pasted note1 is staged");
check(await edited(4, "city"), "pasted multi-line cell is one staged edit");
check((await cell(4, "city").textContent()).includes("line1"), "multi-line text survived paste");
check(await edited(4, "note"), 'pasted text "NULL" is staged as text');
let toast = (await toastText()) ?? "";
check(toast === "Pasted 4 cells", `full block toast (${toast})`);

await cell(0, "city").click();
await cell(1, "note").click({ modifiers: ["Shift"] });
await page.keyboard.press("Control+c");
await page.waitForTimeout(100);
await cell(5, "city").click();
await page.keyboard.press("Control+v");
await page.waitForSelector("[data-toast]");
toast = (await toastText()) ?? "";
check(toast.includes("Pasted 2 of 4") && toast.includes("outside the table") && !toast.includes("didn't parse"), `partial paste toast (${toast})`);

await page.screenshot({ path: `${OUT}/grid-paste-roundtrip.png` });
await context.close();
await browser.close();
process.exit(process.exitCode ?? 0);
