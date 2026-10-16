#!/usr/bin/env node
// UI-thread latency in Chromium with a stubbed Tauri `invoke` (no webview, no
// IPC, no database) on a 2,000-table catalog: ⌘K open, window switch, an
// editor keystroke on 5,000 lines and scrolling a 40-column, 5,000-row
// result. These are the costs a browser can see honestly; process start,
// IPC and the database are latency-proof.sh's. Checks scripts/budgets.json and writes
// scripts/baselines/<date>-<platform>-browser.json. From phase 2 a
// regression against the platform's reference exits 1 (see
// scripts/lib/latency-judge.mjs); LATENCY_ENFORCE=0 records only.
//
// Measure the production bundle: the dev server runs development React,
// several times slower and not what ships.
//
//   cd apps/rowkery-tauri && npx vite build && npx vite preview --port 1420 &
//   node scripts/latency-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { envBudgetOptions, finish, judge, loadReference } from "./lib/latency-judge.mjs";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/latency-browser";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });
const { budgets } = JSON.parse(readFileSync(join(here, "budgets.json"), "utf8"));

function stubTauri() {
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const table = (name, rows, cols) => ({
    name,
    columns: cols.map(([n, t]) => col(n, t)),
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const wideCols = Array.from({ length: 40 }, (_, i) =>
    i === 0 ? ["id", "int8"] : [`metric_${i}`, i % 3 ? "numeric" : "text"],
  );
  const tables = [
    table("wide_metrics", 5000, wideCols),
    ...Array.from({ length: 2000 }, (_, i) => table(`table_${String(i).padStart(4, "0")}`, i * 100, [["id", "int8"], ["name", "text"]])),
  ];
  const catalog = { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] };
  const connections = [
    { kind: "postgres", id: "pg-a", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
    { kind: "postgres", id: "pg-b", name: "orders-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
  ];
  const wide = {
    columns: wideCols.map(([name, type_name]) => ({ name, type_name })),
    rows: Array.from({ length: 5000 }, (_, r) =>
      wideCols.map(([, t], c) => (c === 0 ? { Int: r } : t === "text" ? { Text: `value ${r}·${c}` } : { Text: String((r * c) % 9973) })),
    ),
    row_count: 5000,
    elapsed_ms: 20,
    error: null,
    cancelled: false,
  };
  const small = { columns: [{ name: "?column?", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
  localStorage.clear();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "list_databases":
          return [];
        case "run_query":
          return /wide_metrics/.test(args.sql) ? wide : small;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
// Builds that stream results get the stub's whole results replayed as frames.
const FRAMES_SHIM = join(here, "lib", "frames-shim.js");
if (existsSync(FRAMES_SHIM)) await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(400);

const ledger = () => page.evaluate(() => window.__ROWKERY_TIMINGS__.ledger());
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const results = {};

// 1. ⌘K open: ten opens; the commit's cost and the painted frame.
for (let i = 0; i < 10; i++) {
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-panel"]');
  await page.waitForTimeout(80);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="cp-panel"]', { state: "detached" });
}
let spans = (await ledger()).filter((l) => l.mark === "palette-open");
results.palette_open = r1(median(spans.map((s) => s.commit_ms)));
results.palette_open_painted = r1(median(spans.map((s) => s.dur)));
await page.screenshot({ path: `${OUT}/1-connected.png` });

// 2. Window switch: a second window, then ten switches.
// ⌘T opens an empty window; its Your connections list connects it.
await page.keyboard.press("Control+t");
await page.waitForSelector(`${visible} [data-saved-conn]`);
await page.click(`${visible} [data-saved-conn] >> nth=1`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace"]').length === 2);
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const before = (await ledger()).length;
for (let i = 0; i < 10; i++) {
  await page.keyboard.press(i % 2 ? "Control+2" : "Control+1");
  await page.waitForTimeout(80);
}
spans = (await ledger()).slice(before).filter((l) => l.mark === "window-switch");
results.window_switch = r1(median(spans.map((s) => s.commit_ms)));
results.window_switch_painted = r1(median(spans.map((s) => s.dur)));
await page.keyboard.press("Control+1");
await page.waitForTimeout(200);

// 3. Keystroke on a 5,000-line text: keydown → the highlight layer's DOM changes.
// At the end (the budgeted median), mid-text and near the top; `_app` is
// input → commit, without the browser's own textarea edit.
const text = Array.from({ length: 5000 }, (_, i) => `SELECT id, name, 'row ${i}' AS label FROM table_${String(i % 200).padStart(3, "0")} WHERE id > ${i}; -- line ${i}`).join("\n");
const editor = `${visible} textarea`;
/** Playwright's fill types huge text slowly; set it the way a paste lands. */
const setEditor = (value) =>
  page.evaluate((value) => {
    const ta = document.querySelector('[data-testid="workspace"]:not([hidden]) textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
await setEditor(text);
await page.waitForTimeout(500);
await page.focus(editor);
await page.keyboard.press("Control+End");
await page.evaluate(() => {
  window.__keys = [];
  const pre = document.querySelector('[data-testid="workspace"]:not([hidden]) pre');
  let t0 = 0;
  let t1 = 0;
  document.addEventListener("keydown", () => (t0 = performance.now()), true);
  // The textarea's own edit (keydown → input) is the browser's, before any
  // of our code runs; input → commit is the app's share.
  document.addEventListener("input", () => (t1 = performance.now()), true);
  new MutationObserver(() => {
    if (t0) {
      const now = performance.now();
      window.__keys.push(now - t0);
      window.__app.push(now - (t1 || t0));
      t0 = t1 = 0;
    }
  }).observe(pre, { childList: true, subtree: true, characterData: true });
});
const appMs = () => page.evaluate(() => window.__app);
/** Types `keys` with the caret at `offset` (-1: where it is); each keystroke's ms. */
const typeAt = async (offset, keys) => {
  await page.evaluate((offset) => {
    const ta = document.querySelector(".workspace:not([hidden]) textarea");
    if (offset >= 0) ta.setSelectionRange(offset, offset);
    window.__keys = [];
    window.__app = [];
  }, offset);
  await page.waitForTimeout(100);
  for (const key of keys) {
    if (key.length === 1) await page.keyboard.type(key);
    else await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
  return page.evaluate(() => window.__keys);
};
const keys = await typeAt(-1, [..." AND x = 1"]);
results.keystroke_5000 = r1(median(keys));
results.keystroke_5000_max = r1(Math.max(...keys));
results.keystroke_5000_app = r1(median(await appMs()));
// In the middle (line 2,500), and a quote / comment opened and closed near
// the top, which re-colours every line after it (the tokenizer's worst case).
const lineStart = (n) => text.split("\n").slice(0, n).join("\n").length + 1;
const mid = await typeAt(lineStart(2500) + 10, [..."abc_xyz_10"]);
results.keystroke_5000_mid = r1(median(mid));
results.keystroke_5000_mid_max = r1(Math.max(...mid));
results.keystroke_5000_mid_app = r1(median(await appMs()));
const top = await typeAt(lineStart(2) + 7, ["'", "Backspace", "'", "Backspace", "/", "*", "Backspace", "Backspace", "$", "$", "Backspace", "Backspace"]);
results.keystroke_5000_quote_top = r1(median(top));
results.keystroke_5000_quote_top_max = r1(Math.max(...top));
results.keystroke_5000_quote_top_app = r1(median(await appMs()));
// The floor: a bare textarea holding the same text, no app code at all
// (keydown → input). keystroke_5000 can't go below it.
results.keystroke_5000_bare_textarea = r1(
  median(
    await (async () => {
      await page.evaluate((value) => {
        const ta = document.createElement("textarea");
        ta.id = "bare-textarea";
        ta.spellcheck = false;
        ta.style.cssText = "position:fixed;left:0;top:0;width:900px;height:400px;z-index:9999;font:12.5px monospace";
        document.body.append(ta);
        ta.value = value;
        ta.focus();
        ta.setSelectionRange(value.length, value.length);
        window.__bare = [];
        let t0 = 0;
        ta.addEventListener("keydown", () => (t0 = performance.now()));
        ta.addEventListener("input", () => window.__bare.push(performance.now() - t0));
      }, text);
      for (const ch of " AND x = 1") {
        await page.keyboard.type(ch);
        await page.waitForTimeout(60);
      }
      const out = await page.evaluate(() => window.__bare);
      await page.evaluate(() => document.getElementById("bare-textarea").remove());
      return out;
    })(),
  ),
);
await page.screenshot({ path: `${OUT}/2-editor-5000-lines.png` });

// 4. 40 columns × 5,000 rows: each scroll step → commit + layout.
await setEditor("SELECT * FROM wide_metrics;");
await page.focus(editor);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace"]:not([hidden]) [data-row], [data-testid="workspace"]:not([hidden]) [data-row]').length > 10, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800);
const steps = await page.evaluate(async () => {
  const el = document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="results-grid-wrap"]');
  if (!el) return [];
  const out = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    const committed = new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        mo.disconnect();
        resolve();
      });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      setTimeout(() => {
        mo.disconnect();
        resolve();
      }, 100);
    });
    el.scrollTop += 280;
    el.scrollLeft = (i % 4) * 600;
    el.dispatchEvent(new Event("scroll"));
    await committed;
    el.getBoundingClientRect();
    void el.offsetHeight;
    out.push(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  return out;
});
results.scroll_frame_40col = steps.length ? r1(Math.max(...steps)) : null;
results.scroll_frame_40col_median = steps.length ? r1(median(steps)) : null;
await page.screenshot({ path: `${OUT}/3-wide-scrolled.png` });
await browser.close();

const reference = loadReference(here, "browser", (r) => r.results ?? null);
const rows = judge(budgets, "browser", results, reference, envBudgetOptions());
console.log(`\n${"metric".padEnd(28)} ${"value".padStart(8)} ${"budget".padStart(8)} ${"ref".padStart(8)}`);
for (const r of rows) {
  const mark = r.verdict === "regressed" ? "  REGRESSED" : r.verdict === "miss" ? "  miss" : "";
  console.log(`${r.key.padEnd(28)} ${String(r.value ?? "—").padStart(8)} ${String(r.budget).padStart(8)} ${String(r.reference ?? "—").padStart(8)}${mark}`);
}
console.log("extra:", JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => !budgets[k]))));
const date = new Date().toISOString().slice(0, 10);
const file = join(here, "baselines", `${date}-${os.platform()}-${os.arch()}-browser.json`);
mkdirSync(dirname(file), { recursive: true });
const record = { date, platform: `${os.platform()}-${os.arch()}`, host: os.cpus()[0]?.model ?? "", source: "latency-browser-proof.mjs (Chromium, stubbed invoke)", results };
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`baseline: ${file}`);
finish(rows, { dir: here, kind: "browser", record, hasReference: reference != null });
