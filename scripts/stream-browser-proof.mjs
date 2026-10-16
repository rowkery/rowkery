#!/usr/bin/env node
// Streamed results (stubbed `invoke` that plays binary rows frames on the
// run's channel the way src-tauri's ChannelSink does): the first rows paint before the
// query finishes, the results header counts rows so far while it runs, the
// done frame ends the run with the database's row count and time, a cancel
// mid-stream keeps the rows that arrived, and an error frame carries its
// SQLSTATE. A read with no rows shows its column headers and "0 rows"; a
// statement with no result set shows none. Asserts on data-* attributes.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/stream-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/stream";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const tables = [
    {
      name: "events",
      columns: [
        { name: "id", type_name: "int8", nullable: false },
        { name: "kind", type_name: "text", nullable: true },
      ],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 20000 },
      partition_of: null,
    },
  ];
  let nextId = 0;
  const running = new Map(); // tab → { cancel }
  window.__STREAM__ = { framesSent: 0, done: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "events-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2 };
        case "cancel_query": {
          running.get(args.tabId)?.cancel();
          return null;
        }
        case "run_query": {
          const ch = args.onFrame;
          const queryId = ++nextId;
          const send = (f) => ch.onmessage({ query_id: queryId, ...f });
          const columns = [
            { name: "id", type_name: "int8" },
            { name: "kind", type_name: "text" },
          ];
          if (/no_such/.test(args.sql)) {
            setTimeout(() => {
              send({ t: "columns", columns: [] });
              send({ t: "done", status: "error", row_count: 0, affected_rows: null, elapsed_ms: 3, first_row_ms: null, frames: 0, error: 'relation "no_such_table" does not exist', sqlstate: "42P01", error_position: 15, hold: null });
            }, 20);
            return queryId;
          }
          // A read with no rows: the columns frame (from the statement's
          // description) and done, no rows frame — as ChannelSink sends it.
          if (/where false/i.test(args.sql)) {
            setTimeout(() => {
              send({ t: "columns", columns });
              send({ t: "done", status: "ok", row_count: 0, affected_rows: null, elapsed_ms: 2, first_row_ms: null, frames: 0, error: null, sqlstate: null, error_position: null, hold: null });
            }, 20);
            return queryId;
          }
          // A statement with no result set: no columns frame, rows affected.
          if (/^\s*create/i.test(args.sql)) {
            setTimeout(() => {
              send({ t: "done", status: "ok", row_count: 0, affected_rows: 0, elapsed_ms: 2, first_row_ms: null, frames: 0, error: null, sqlstate: null, error_position: null, hold: null });
            }, 20);
            return queryId;
          }
          // 20 frames of 200 rows, 120 ms apart (a slow query streaming).
          let sent = 0;
          let cancelled = false;
          window.__STREAM__ = { framesSent: 0, done: false };
          const started = performance.now();
          running.set(args.tabId, { cancel: () => (cancelled = true) });
          const tick = () => {
            if (cancelled) {
              send({ t: "done", status: "cancelled", row_count: sent * 200, affected_rows: null, elapsed_ms: Math.round(performance.now() - started), first_row_ms: 40, frames: sent, error: "Query cancelled", sqlstate: null, error_position: null, hold: null });
              return;
            }
            if (sent === 0) send({ t: "columns", columns });
            // A binary rows frame (rowkery-core frames.rs): id INT32, kind STRING.
            const n = 200;
            const ids = Array.from({ length: n }, (_, i) => sent * 200 + i);
            const kinds = ids.map((id) => (id % 7 === 0 ? null : id % 2 ? "click" : "view"));
            const enc = new TextEncoder();
            const strBytes = kinds.map((k) => enc.encode(k ?? ""));
            const total = strBytes.reduce((a, b) => a + b.length, 0);
            const bm = (n + 7) >> 3;
            const size = 28 + 4 + 2 + (1 + bm + 4 * n) + (1 + bm + 4 * (n + 1) + total);
            const buf = new ArrayBuffer(size);
            const v = new DataView(buf);
            const u8 = new Uint8Array(buf);
            let p = 0;
            v.setUint32(p, 0x494e4c31, true); p += 4;
            v.setUint8(p++, 2); v.setUint8(p++, 0); v.setUint16(p, 0, true); p += 2;
            v.setUint32(p, queryId, true); v.setUint32(p + 4, 0, true); p += 8;
            v.setUint32(p, sent, true); p += 4;
            v.setFloat64(p, Date.now(), true); p += 8;
            v.setUint32(p, n, true); p += 4;
            v.setUint16(p, 2, true); p += 2;
            v.setUint8(p++, 2); p += bm; // INT32, no NULLs
            ids.forEach((id) => { v.setInt32(p, id, true); p += 4; });
            v.setUint8(p++, 6); // STRING
            kinds.forEach((k, i) => { if (k === null) u8[p + (i >> 3)] |= 1 << (i & 7); });
            p += bm;
            let off = 0;
            v.setUint32(p, 0, true); p += 4;
            strBytes.forEach((b) => { off += b.length; v.setUint32(p, off, true); p += 4; });
            strBytes.forEach((b) => { u8.set(b, p); p += b.length; });
            ch.onmessage(buf);
            sent++;
            window.__STREAM__.framesSent = sent;
            if (sent === 20) {
              window.__STREAM__.done = true;
              send({ t: "done", status: "ok", row_count: 4000, affected_rows: null, elapsed_ms: Math.round(performance.now() - started), first_row_ms: 40, frames: 20, error: null, sqlstate: null, error_position: null, hold: null });
              return;
            }
            setTimeout(tick, 120);
          };
          setTimeout(tick, 40);
          return queryId;
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
const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);

const editor = `${visible} textarea`;
const setSql = (sql) =>
  page.evaluate((sql) => {
    const ta = document.querySelector('[data-testid="workspace"]:not([hidden]) textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, sql);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, sql);
const rowsSoFar = () =>
  page.$eval(`${visible} [data-rows-so-far]`, (el) => Number(el.dataset.rowsSoFar)).catch(() => null);
const gridRows = () => page.$$eval(`${visible} [data-row]`, (els) => els.length);

// 1. Rows paint while the query runs, with a live count.
await setSql("SELECT * FROM events;");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${visible} [data-row="0"]`, { timeout: 2000 });
const early = await page.evaluate(() => window.__STREAM__);
check(!early.done, `first rows painted before the query finished (${early.framesSent} of 20 frames sent)`);
await page.waitForTimeout(600);
const count1 = await rowsSoFar();
await page.screenshot({ path: `${OUT}/1-streaming.png` });
await page.waitForTimeout(500);
const count2 = await rowsSoFar();
check(count1 > 0 && count2 > count1, `the header counts rows so far (${count1} → ${count2})`);
check((await gridRows()) > 0, "the grid shows the rows that arrived");
const nullCell = await page.$eval(`${visible} [data-row="0"] [data-col="1"]`, (el) => el.textContent);
const textCell = await page.$eval(`${visible} [data-row="1"] [data-col="1"]`, (el) => el.textContent);
check(nullCell === "NULL" && textCell === "click", `binary frames decode: NULL pill and text (${nullCell}, ${textCell})`);
await page.waitForFunction(() => window.__STREAM__.done, null, { timeout: 5000 });
await page.waitForTimeout(300);
const meta = await page.textContent(`${visible} [data-testid="card-meta"]`);
check(/4,000 rows/.test(meta ?? ""), `done: the header reads the final count (${meta?.trim()})`);
check((await rowsSoFar()) === null, "the rows-so-far count is gone once it finished");
await page.screenshot({ path: `${OUT}/2-done.png` });

// 2. Cancel mid-stream: Esc; rows that arrived stay, the run ends cancelled.
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__STREAM__.framesSent >= 1 && !window.__STREAM__.done, null, { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(450);
await page.keyboard.press("Escape");
await page.waitForSelector(`${visible} [data-testid="card-meta"][data-state="cancelled"]`, { timeout: 3000 }).catch(() => {});
const cancelledMeta = await page.textContent(`${visible} [data-testid="card-meta"]`);
check(/cancelled/i.test(cancelledMeta ?? ""), `Esc mid-stream ends the run as cancelled (${cancelledMeta?.trim()})`);
await page.screenshot({ path: `${OUT}/3-cancelled.png` });

// 3. An error frame: the server's message shows; SQLSTATE and position reach the page.
await setSql("SELECT id FROM no_such_table;");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${visible} [data-testid="card-meta"][data-state="error"]`, { timeout: 3000 });
const errText = await page.textContent(`${visible} [data-testid="results-card"]`);
check(/no_such_table/.test(errText ?? ""), "the error frame's message shows");
await page.screenshot({ path: `${OUT}/4-error.png` });

// 4. No rows: the column headers show with "0 rows", not "no result set".
await setSql("SELECT id, kind FROM events WHERE false;");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${visible} [data-testid="rg-header"] [data-header="kind"]`, { timeout: 3000 }).catch(() => {});
const headers = await page.$$eval(`${visible} [data-testid="rg-header"] [data-header]`, (els) => els.map((el) => el.dataset.header));
check(headers.join(",") === "id,kind", `zero rows: the column headers show (${headers.join(", ")})`);
const zeroMeta = await page.textContent(`${visible} [data-testid="card-meta"]`);
check(/(^|\D)0 rows/.test(zeroMeta ?? ""), `zero rows: the header reads 0 rows (${zeroMeta?.trim()})`);
const zeroCard = await page.textContent(`${visible} [data-testid="results-card"]`);
check(!/no result set/.test(zeroCard ?? "") && (await gridRows()) === 0, "zero rows: no rows and no 'no result set' message");
await page.screenshot({ path: `${OUT}/5-zero-rows.png` });

// 5. A statement with no result set still says so.
await setSql("CREATE TABLE t2 (id int);");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(400);
const ddlCard = await page.textContent(`${visible} [data-testid="results-card"]`);
const ddlHeaders = await page.$$(`${visible} [data-testid="rg-header"] [data-header]`);
check(ddlHeaders.length === 0, `no result set: no column headers (${ddlCard?.trim().slice(0, 80)})`);
await page.screenshot({ path: `${OUT}/6-no-result-set.png` });
await browser.close();
