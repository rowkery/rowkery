#!/usr/bin/env node
// Run SQL file (stubbed `invoke`; core's scan and run are stood in for):
// ⌘K "Run SQL file…" opens the native dialog, then the inspector's panel
// says what the file does, the destructive kinds in red, with a red "Run on
// shop" focused. Keep going switches the transaction to Per statement, and
// Whole file puts On error back to Stop. Run shows the statement, elapsed
// time and a bar; Esc doesn't close it meanwhile, Cancel rolls back. A
// dropped .sql that can't run in one transaction says why and offers only
// Per statement; a run whose answer never comes (the call itself fails)
// says its outcome is unknown, not that it rolled back; a custom-format dump
// is refused with the pg_restore hint.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sql-file-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sql-file";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  window.__DIALOG__ = "/Users/me/Downloads/shop-2026-10-20.sql";
  let stop = null;
  const kinds = [
    { label: "DROP TABLE", count: 4, destructive: true },
    { label: "SET", count: 11, destructive: false },
    { label: "CREATE TABLE", count: 4, destructive: false },
    { label: "COPY", count: 4, destructive: false },
    { label: "ALTER TABLE", count: 9, destructive: false },
    { label: "CREATE INDEX", count: 6, destructive: false },
  ];
  const scans = {
    "shop-2026-10-20.sql": { bytes: 432013312, source: "pg_dump 16.4", statements: 38, kinds, copy_rows: 2410332, writes: true, per_statement: null, refused: null },
    "cleanup.sql": {
      bytes: 2048,
      source: null,
      statements: 3,
      kinds: [
        { label: "UPDATE", count: 1, destructive: false },
        { label: "VACUUM", count: 1, destructive: false },
        { label: "CREATE INDEX", count: 1, destructive: false },
      ],
      copy_rows: 0,
      writes: true,
      per_statement: { line: 4, reason: "VACUUM can't run inside a transaction" },
      refused: null,
    },
  };
  const table = { name: "orders", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (/sql_file|choose_file|open_window/.test(cmd)) {
        const { onFrame, ...rest } = args ?? {};
        window.__CALLS__.push({ cmd, ...rest });
      }
      switch (cmd) {
        case "list_connections":
          return {
            connections: [{ kind: "postgres", id: "pg", name: "shop", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery", safe_mode: "confirm" }],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "choose_file":
          return window.__DIALOG__;
        case "scan_sql_file": {
          const name = args.path.split("/").pop();
          if (name.endsWith(".dump"))
            return { bytes: 9000, source: null, statements: 0, kinds: [], copy_rows: 0, writes: false, per_statement: null, refused: { line: null, message: "This is a pg_dump archive (custom format), not a .sql file. Turn it into one with pg_restore -f out.sql, then run out.sql." } };
          for (const bytes of [1 << 20, 2 << 20]) {
            args.onFrame.onmessage({ t: "read", bytes });
            await new Promise((r) => setTimeout(r, 30));
          }
          return scans[name];
        }
        case "run_sql_file":
          // Refused before anything ran.
          if (window.__REFUSE__) return Promise.reject(window.__REFUSE__);
          return new Promise((resolve, reject) => {
            let done = 0;
            const started = Date.now();
            const tick = () => {
              done++;
              args.onFrame.onmessage({ t: "progress", done, line: done * 40, current: done === 12 ? "COPY public.orders (id, customer_id, total, placed_at) FROM stdin" : `ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id)`, bytes: done * 11000000, rows: done * 60000 });
              // The call fails mid-run: what ran is unknown.
              if (window.__LOSE_ANSWER__ && done >= 5) return reject("Rowkery's core stopped before it answered");
              if (done >= 38) {
                stop = null;
                resolve({ done, rows: 2410332, elapsed_ms: Date.now() - started, failed: null, errors: 0, first_error: null, cancelled: false, rolled_back: false, lost: 0 });
              } else timer = setTimeout(tick, window.__SLOW__ ? 300 : 10);
            };
            let timer = setTimeout(tick, 10);
            stop = () => {
              clearTimeout(timer);
              resolve({ done, rows: done * 60000, elapsed_ms: Date.now() - started, failed: null, errors: 0, first_error: null, cancelled: true, rolled_back: true, lost: 0 });
            };
          });
        case "cancel_sql_file":
          stop?.();
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const panel = '[data-inspector="sqlfile"]';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const calls = (cmd) => page.evaluate((cmd) => window.__CALLS__.filter((c) => c.cmd === cmd), cmd);
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());
const checked = (name) => page.$eval(`${panel} [data-sql-file-option="${name}"] [aria-checked="true"]`, (e) => e.dataset.value);

// ⌘K → the dialog → the panel.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-row"]');
await page.keyboard.type("import sql");
await page.waitForTimeout(80);
const rows = await page.$$eval('[data-testid="cp-row"][data-item]', (els) => els.map((e) => `${e.dataset.item}=${e.querySelector('[data-testid="cp-label"]').textContent}`));
check(rows[0] === "cmd:run-sql-file=Run SQL file…", `⌘K finds Run SQL file… by "import" (${rows.join(" | ")})`);
await page.keyboard.press("Enter");
await page.waitForSelector(`${panel} [data-sql-file="ready"]`);
check((await calls("choose_file"))[0]?.kind === "sql", "it opens the dialog for .sql files");
check((await text(`${panel} [data-sql-file-meta]`)) === "shop-2026-10-20.sql · 412 MB · pg_dump 16.4", `meta line: ${await text(`${panel} [data-sql-file-meta]`)}`);
const kindRows = await page.$$eval(`${panel} [data-sql-kind]`, (els) => els.map((e) => `${e.dataset.sqlKind}${e.classList.contains("destructive") ? "!" : ""}`));
check(kindRows[0] === "DROP TABLE!" && kindRows.filter((k) => k.endsWith("!")).length === 1, `kinds, destructive first and red (${kindRows.join(", ")})`);
check((await text(`${panel} .insp-label`)).toLowerCase() === "what it does · 38 statements", "the count of statements heads the list");
check((await text(`${panel} [data-sql-kind="COPY"]`)).includes("2,410,332 rows"), "COPY says how many rows");
const run = await page.$eval(`${panel} [data-sql-file-run]`, (e) => ({ text: e.textContent, danger: e.classList.contains("danger"), focused: document.activeElement === e }));
check(run.text === "Run on shop" && run.danger && run.focused, `Run is red, names the connection and has the focus (${JSON.stringify(run)})`);
check((await checked("transaction")) === "whole" && (await checked("on-error")) === "stop", "defaults: Whole file, Stop");
await page.screenshot({ path: `${OUT}/1-ready.png` });

await page.click(`${panel} [data-sql-file-option="on-error"] [data-value="keep"]`);
check((await checked("transaction")) === "each", "Keep going switches the transaction to Per statement");
await page.click(`${panel} [data-sql-file-option="transaction"] [data-value="whole"]`);
check((await checked("on-error")) === "stop", "Whole file puts On error back to Stop");

// Run, slowly: progress, Esc stays, Cancel rolls back.
await page.evaluate(() => (window.__SLOW__ = true));
await page.click(`${panel} [data-sql-file-run]`);
await page.waitForSelector(`${panel} [data-sql-file-running]`);
const runCall = (await calls("run_sql_file"))[0];
check(runCall?.wholeFile === true && runCall.keepGoing === false && runCall.confirmed === true, `Run sends Whole file, Stop, confirmed (${JSON.stringify(runCall)})`);
await page.waitForFunction((p) => /Statement [3-9] of 38/.test(document.querySelector(`${p} [data-sql-file-running]`)?.textContent ?? ""), panel);
await page.screenshot({ path: `${OUT}/2-running.png` });
await page.keyboard.press("Escape");
await page.click(`${panel} [data-inspector-close]`);
check(!!(await page.$(`${panel} [data-sql-file-running]`)), "neither Esc nor × closes the panel while it runs");
check((await text(`${panel} [data-sql-file-cancel]`)) === "Cancel and roll back", "Cancel says it rolls back");
await page.click(`${panel} [data-sql-file-cancel]`);
await page.waitForSelector(`${panel} [data-sql-file-ended="cancelled"]`);
check((await text(`${panel} [data-sql-file-ended]`)).includes("Nothing was kept."), `cancelled: ${await text(`${panel} [data-sql-file-ended]`)}`);
await page.screenshot({ path: `${OUT}/3-cancelled.png` });
await page.keyboard.press("Escape");
await page.waitForFunction((p) => !document.querySelector(p), panel);
check((await calls("forget_sql_file")).length >= 1, "closing forgets the scan");

// Dropped: a file that can't run in one transaction.
const drop = (path) => page.evaluate((path) => window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "drop", paths: [path] } })), path);
await drop("/Users/me/cleanup.sql");
await page.waitForSelector(`${panel} [data-sql-file="ready"]`);
const forced = await page.$eval(`${panel} [data-sql-file-option="transaction"] [data-value="whole"]`, (e) => e.disabled);
check(forced && (await checked("transaction")) === "each", "Whole file is off for a file with VACUUM");
check((await text(`${panel} [data-sql-file-why]`)) === "Line 4: VACUUM can't run inside a transaction", "and it says why, before Run");
const plain = await page.$eval(`${panel} [data-sql-file-run]`, (e) => e.classList.contains("ink"));
check(plain, "nothing destructive: Run is ink");
await page.screenshot({ path: `${OUT}/4-per-statement.png` });
await page.evaluate(() => (window.__SLOW__ = false));
await page.click(`${panel} [data-sql-file-run]`);
await page.waitForSelector(`${panel} [data-sql-file-ended="done"]`);
check((await calls("run_sql_file")).at(-1)?.wholeFile === false, "it runs per statement");
check((await text(`${panel} [data-sql-file-ended]`)).startsWith("Done 38 statements · 2,410,332 rows"), `done: ${await text(`${panel} [data-sql-file-ended]`)}`);
await page.screenshot({ path: `${OUT}/5-done.png` });

// The answer never comes: the outcome is unknown, never "Nothing was kept".
await page.click(`${panel} [data-sql-file-close]`);
await page.waitForFunction((p) => !document.querySelector(p), panel);
await drop("/Users/me/cleanup.sql");
await page.waitForSelector(`${panel} [data-sql-file="ready"]`);
await page.evaluate(() => (window.__LOSE_ANSWER__ = true));
await page.click(`${panel} [data-sql-file-run]`);
await page.waitForSelector(`${panel} [data-sql-file-ended="unknown"]`);
const lost = await text(`${panel} [data-sql-file-ended]`);
check(lost.startsWith("Outcome unknown"), `lost answer: ${lost}`);
check(
  (await text(`${panel} [data-sql-file-kept]`)) === "Rowkery lost track of this run; check the tables it touches.",
  "it says to check the tables",
);
check(!lost.includes("Nothing was kept") && !lost.includes("rolled back"), "and claims no rollback");
await page.screenshot({ path: `${OUT}/5b-outcome-unknown.png` });
await page.evaluate(() => (window.__LOSE_ANSWER__ = false));

// A refusal: nothing ran, so it says so plainly, never "Outcome unknown".
await page.click(`${panel} [data-sql-file-close]`);
await page.waitForFunction((p) => !document.querySelector(p), panel);
await drop("/Users/me/cleanup.sql");
await page.waitForSelector(`${panel} [data-sql-file="ready"]`);
await page.evaluate(() => (window.__REFUSE__ = "A SQL file is already running in this window."));
await page.click(`${panel} [data-sql-file-run]`);
await page.waitForSelector(`${panel} [data-sql-file-ended="failed"]`);
const refused = await text(`${panel} [data-sql-file-ended]`);
check(!refused.includes("Outcome unknown"), `a refusal isn't unknown: ${refused}`);
check(refused.includes("A SQL file is already running in this window."), "it names the refusal");
check((await text(`${panel} [data-sql-file-kept]`)) === "Nothing was kept.", "and nothing was kept");
await page.screenshot({ path: `${OUT}/5c-refused.png` });
await page.evaluate(() => (window.__REFUSE__ = null));

// A custom-format archive: refused, with the way forward.
await page.click(`${panel} [data-sql-file-close]`);
await page.waitForFunction((p) => !document.querySelector(p), panel);
await drop("/Users/me/shop.dump");
await page.waitForSelector(`${panel} [data-sql-file-refused]`);
check((await text(`${panel} [data-sql-file-refused]`)).includes("pg_restore -f out.sql"), "a .dump archive is refused with the pg_restore hint");
check(!(await page.$(`${panel} [data-sql-file-run]`)), "and there is no Run");
await page.screenshot({ path: `${OUT}/6-refused.png` });
await browser.close();
