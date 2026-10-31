#!/usr/bin/env node
// Errors that teach, on a query tab (stubbed `invoke`; the stub answers like
// Postgres with SQLSTATE and the 1-based position): the caret jumps to the
// token the server pointed at, which gets a dotted underline; the error view
// shows the server's sentence, "Did you mean name?" for an unknown column
// (42703, from the statement's tables' columns) or table (42P01), and the
// raw text as psql prints it with the SQLSTATE. ↵ in the token or "Replace
// and run" fixes it and reruns; without a suggestion ↵ is a newline; any
// edit removes the underline.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/query-error-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/query-error";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__RUNS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [
    { name: "kiosks", columns: [col("id", "int8"), col("name", "text"), col("city", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null },
    { name: "players", columns: [col("id", "int8"), col("nickname", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null },
  ];
  const fail = (sql, word, message, sqlstate) => ({ error: message, sqlstate, error_position: sql.indexOf(word) + 1, columns: [], rows: [], row_count: 0, elapsed_ms: 1, cancelled: false });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          const sql = args.sql;
          window.__RUNS__.push(sql);
          if (/\bnmae\b/.test(sql)) return fail(sql, "nmae", 'column "nmae" does not exist', "42703");
          if (/\bkiosk\b/.test(sql)) return fail(sql, "kiosk", 'relation "kiosk" does not exist', "42P01");
          if (/\bFORM\b/.test(sql)) return fail(sql, "FORM", 'syntax error at or near "FORM"', "42601");
          if (/^INSERT/.test(sql))
            return { ...fail(sql, "", 'duplicate key value violates unique constraint "kiosks_pkey"', "23505"), error_position: null, error_detail: "DETAIL:  Key (id)=(1) already exists." };
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
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
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const editor = `${ws} textarea[data-testid="sql-editor"]`;
const setSql = (text) =>
  page.evaluate(([sel, text]) => {
    const ta = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, [editor, text]);
const caretAt = async (offset) => {
  await page.focus(editor);
  await page.evaluate(([sel, o]) => document.querySelector(sel).setSelectionRange(o, o), [editor, offset]);
};
const settle = () => page.waitForFunction((ws) => !document.querySelector(`${ws} [data-testid="card-meta"][data-state="running"]`), ws);
const runs = () => page.evaluate(() => window.__RUNS__);
const value = () => page.$eval(editor, (el) => el.value);
const mark = () => page.getAttribute(`${ws} [data-mark]`, "data-mark").catch(() => null);
const hasMark = () => page.evaluate((ws) => !!document.querySelector(`${ws} [data-mark]`), ws);

// 42703 on line 2: caret jumps, underline, suggestion, raw text.
const text = "SELECT 1;\nSELECT id, nmae FROM kiosks;";
await setSql(text);
await caretAt(text.length);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="42703"]`);
await page.waitForTimeout(100);
const at = text.indexOf("nmae");
check((await runs()).at(-1) === "SELECT id, nmae FROM kiosks;", "ran the statement on line 2");
check((await mark()) === `${at}-${at + 4}`, `the token is underlined (${await mark()})`);
check((await page.$eval(editor, (el) => [el.selectionStart, document.activeElement === el])).join() === `${at},true`, "the caret jumped there; the editor keeps focus");
check((await page.textContent(`${ws} [data-testid="qe-sentence"]`)) === 'column "nmae" does not exist', "the server's sentence");
check((await page.getAttribute(`${ws} [data-suggestion]`, "data-suggestion")) === "name", "Did you mean name?");
const raw = await page.textContent(`${ws} [data-testid="qe-raw"]`);
check(raw.includes("LINE 1: SELECT id, nmae FROM kiosks;") && raw.includes("42703") && /\n\s{19}\^/.test(raw), `raw text with LINE, caret and SQLSTATE (${JSON.stringify(raw)})`);
// Class on purpose: .ln.err is the red line-number mark under test.
check((await page.textContent(`${ws} [data-testid="sql-highlight"] .ln.err`)).includes("nmae"), "the line number is marked");
await page.screenshot({ path: `${OUT}/1-did-you-mean.png` });

// ↵ in the token: replace and rerun.
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__RUNS__.length === 2);
await settle();
check((await runs()).at(-1) === "SELECT id, name FROM kiosks;" && (await value()) === "SELECT 1;\nSELECT id, name FROM kiosks;", "↵ replaced nmae with name and ran it");
check(!(await hasMark()) && (await page.$(`${ws} [data-query-error]`)) === null, "underline and error gone");

// 42P01: the button.
await setSql("SELECT * FROM kiosk;");
await caretAt(5);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="42P01"]`);
check((await page.getAttribute(`${ws} [data-suggestion]`, "data-suggestion")) === "kiosks", "unknown table: Did you mean kiosks?");
await page.click(`${ws} [data-testid="qe-replace"]`);
await page.waitForFunction(() => window.__RUNS__.at(-1) === "SELECT * FROM kiosks;");
check(true, "Replace and run ran SELECT * FROM kiosks;");
await settle();

// No suggestion: ↵ is a newline; any edit removes the underline.
await setSql("SELECT id FORM kiosks;");
await caretAt(1);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="42601"]`);
await page.waitForTimeout(100);
check((await page.$(`${ws} [data-suggestion]`)) === null && (await hasMark()), "syntax error: underline, no suggestion");
await page.screenshot({ path: `${OUT}/2-syntax-error.png` });
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
check((await value()).includes("\n") && (await runs()).length === 5 && !(await hasMark()), "↵ without a suggestion is a newline, and the edit removes the underline");

// The server's DETAIL under the raw text, as psql prints it (rowkery/reports#43).
await setSql("INSERT INTO kiosks VALUES (1);");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-query-error="23505"]`);
const dupe = await page.textContent(`${ws} [data-testid="qe-raw"]`);
check(/ERROR: {2}duplicate key[^\n]*\n\s*DETAIL: {2}Key \(id\)=\(1\) already exists\./.test(dupe), `DETAIL under the error (${JSON.stringify(dupe)})`);
await page.screenshot({ path: `${OUT}/3-detail.png` });
await browser.close();
