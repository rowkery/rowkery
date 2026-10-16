#!/usr/bin/env node
// A query stuck on a dead connection (stubbed `invoke`: the "server" ignores
// a cancel, as a dead socket does). Cancel turns into Force stop, which (or
// Esc again) stops it; ⌘K "Stop all queries" stops every tab; the run's
// sweep stays in the main column, in Run's orange; scrollbars are thin.
// Core's side (a run stopped 3 s after an unanswered cancel, at once on the
// second, a frozen proxy) is `postgres_cancel_stops_a_run_on_a_dead_connection`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/stuck-query-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/stuck-query";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const pending = (window.__PENDING__ = {});
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = Array.from({ length: 60 }, (_, i) => ({ name: `table_${String(i).padStart(2, "0")}`, kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 1000 + i }, partition_of: null }));
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "Midway PRD", host: "db", port: 5432, database: "midway", username: "app", environment: "prd" }], active_connection_id: null };
        case "open_window":
          return { database: "midway", catalog: { databases: [{ name: "midway", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          // Never answers on its own: only a stop ends it.
          const started = performance.now();
          await new Promise((resolve) => {
            pending[args.tabId] = resolve;
          });
          return { columns: [], rows: [], row_count: 0, elapsed_ms: Math.round(performance.now() - started), error: "Query cancelled", cancelled: true };
        }
        case "cancel_query": {
          // The first cancel goes unanswered (dead socket); the second stops it.
          const n = (window.__CANCELS__ = (window.__CANCELS__ ?? 0) + 1);
          if (n % 2 === 0) pending[args.tabId]?.();
          return null;
        }
        case "stop_all_queries":
          for (const k of Object.keys(pending)) pending[k]();
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
const colorOf = (v) =>
  page.evaluate((v) => {
    const p = document.createElement("i");
    p.style.color = `var(${v})`;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, v);
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).length, cmd);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// Run: it hangs.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-cancel="cancel"]`);
await page.waitForTimeout(400);
// The sweep: clipped to the main column, in Run's orange.
const sweep = await page.evaluate((sel) => {
  // Class on purpose: .sweeping is the hairline animation under test.
  const el = document.querySelector(`${sel} [data-testid="pane-splitter"].sweeping`);
  const after = getComputedStyle(el, "::after");
  return { overflow: getComputedStyle(el).overflow, bg: after.backgroundImage, left: el.getBoundingClientRect().left, panelRight: document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().right };
}, ws);
check(sweep.overflow === "hidden" && sweep.left >= sweep.panelRight, `the sweep stays right of the panel (${sweep.left} ≥ ${sweep.panelRight})`);
// The sweep reads the theme's --acc through computed styles (as the
// paper-* proofs do), never a hard-coded orange. A
// color-mix() serialises as color(srgb r g b / a) with 0–1 channels.
const acc = await colorOf("--acc");
const [ar, ag, ab] = acc.match(/\d+/g).map(Number);
const accFloats = [ar, ag, ab].map((v) => (v / 255).toFixed(3));
const sweepFloats = [...sweep.bg.matchAll(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/g)].map((m) => m.slice(1, 4).map((v) => Number(v).toFixed(3)));
check(
  (sweep.bg.includes(`${ar}, ${ag}, ${ab}`) || sweepFloats.some((f) => f.join() === accFloats.join())) && !/255, 255, 255/.test(sweep.bg),
  `the sweep is Run's orange (--acc ${acc}), not white`,
);
await page.screenshot({ path: `${OUT}/1-running.png` });

// Cancel goes unanswered: the button becomes Force stop, still enabled.
await page.click(`${ws} [data-cancel="cancel"]`);
await page.waitForSelector(`${ws} [data-cancel="force"]:not([disabled])`);
await page.waitForTimeout(300);
check((await page.$(`${ws} [data-cancel="force"]`)) !== null && (await calls("cancel_query")) === 1, "first Cancel: still running, button reads Force stop");
await page.screenshot({ path: `${OUT}/2-force-stop.png` });
await page.click(`${ws} [data-cancel="force"]`);
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`);
check((await calls("cancel_query")) === 2, "Force stop asked core again, and the run ended");

// Esc twice does the same.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-cancel="cancel"]`);
await page.keyboard.press("Escape");
await page.waitForSelector(`${ws} [data-cancel="force"]`);
await page.keyboard.press("Escape");
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`);
check((await calls("cancel_query")) === 4, "Esc, then Esc again, stopped it");

// ⌘K Stop all queries: every running tab at once.
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${ws} [data-cancel="cancel"]`);
await page.keyboard.press("Control+k");
await page.keyboard.type("stop all");
await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:stop-all-queries"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws} [data-testid="card-meta"][data-state="cancelled"]`);
check((await calls("stop_all_queries")) === 1, "⌘K Stop all queries stopped the run");

// Scrollbars: a thin, dim thumb on no track.
const bar = await page.evaluate(() => {
  const rules = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]);
  const find = (sel) => rules.find((r) => r.selectorText === sel)?.style;
  return { width: find("::-webkit-scrollbar")?.width, thumb: find("::-webkit-scrollbar-thumb")?.backgroundColor };
});
// The thumb is the --line2 rule colour, read through a computed style
// (a scrollbar pseudo-element has none of its own).
const thumb = await page.evaluate((v) => {
  const p = document.createElement("i");
  p.style.color = v;
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  return c;
}, bar.thumb ?? "");
check(bar.width === "10px" && thumb === (await colorOf("--line2")), `scrollbars: ${bar.width} with a dim thumb (${bar.thumb} = ${thumb})`);
await page.screenshot({ path: `${OUT}/3-stopped.png` });
await browser.close();
