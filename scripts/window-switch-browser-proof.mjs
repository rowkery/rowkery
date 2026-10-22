#!/usr/bin/env node
// Window switch on a big catalog (stubbed `invoke`, 2,000 tables per window).
// A hidden window is `content-visibility: hidden` instead of `display: none`
// (styles/windows.css), so showing it again re-lays nothing out. This proves the switch
// still behaves like a hidden window:
//
// 1. The hidden window is skipped (checkVisibility false), sits under the
//    shown one and takes no clicks: the point in the middle of the screen
//    belongs to the shown window.
// 2. Focus never stays in a window that isn't shown: with the editor of
//    window 1 focused, ⌘2 lets go of it and typed keys don't reach window 1.
// 3. A hidden window keeps its state: its editor text and its schema list's
//    scroll position are there when it comes back.
// 4. The switch itself is cheap: the median `window-switch` commit_ms over
//    ten switches stays under 100 ms on the dev server's development React
//    (~55 ms; ~225 ms with display: none). latency-browser-proof.mjs holds the
//    production bundle to the 16 ms budget.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/window-switch-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/window-switch";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const table = (name, rows) => ({
    name,
    columns: [col("id", "int8"), col("name", "text")],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const tables = Array.from({ length: 2000 }, (_, i) => table(`table_${String(i).padStart(4, "0")}`, i * 100));
  const catalog = { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] };
  const connections = [
    { kind: "postgres", id: "pg-a", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
    { kind: "postgres", id: "pg-b", name: "orders-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
  ];
  const small = { columns: [{ name: "?column?", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
  localStorage.clear();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return { connections, active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "list_databases":
          return [];
        case "run_query":
          return small;
        default:
          return null;
      }
    },
  };
}

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok" : "FAIL"}: ${msg}`);
  if (!cond) failed++;
};

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);

const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(visible);
// Window 1 connects through ⇧⌘O; ⌘T opens window 2, which its list connects.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.keyboard.press("Control+t");
await page.waitForSelector(`${visible} [data-saved-conn]`);
await page.click(`${visible} [data-saved-conn] >> nth=1`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace"]').length === 2);
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.keyboard.press("Control+1");
await page.waitForTimeout(300);

/** Index of the shown window among the workspaces. */
const shownIndex = () =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="workspace"]')].findIndex((w) => !w.hidden));

// 3 (setup). Window 1: editor text and a scrolled schema list.
await page.evaluate(() => {
  const ws = document.querySelector('[data-testid="workspace"]:not([hidden])');
  const ta = ws.querySelector("textarea");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "SELECT 'window one';");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ws.querySelector('[data-testid="sb-scroll"]').scrollTop = 3000;
});
await page.waitForTimeout(200);

// 2. Focus in window 1, then ⌘2: focus leaves, keys don't land in window 1.
await page.focus(`${visible} textarea`);
await page.keyboard.press("End");
await page.keyboard.press("Control+2");
await page.waitForTimeout(200);
check((await shownIndex()) === 1, "⌘2 shows window 2");
const focusInHidden = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="workspace"][hidden]'));
check(!focusInHidden, "focus is not left in the hidden window");
await page.keyboard.type("zz");
await page.waitForTimeout(100);
const hiddenText = await page.evaluate(() => document.querySelector('[data-testid="workspace"][hidden] textarea').value);
check(hiddenText === "SELECT 'window one';", `keys didn't reach the hidden window's editor (${JSON.stringify(hiddenText)})`);

// 1. The hidden window is skipped and under the shown one.
const hidden = await page.evaluate(() => {
  const ws = document.querySelector('[data-testid="workspace"][hidden]');
  const shown = document.querySelector('[data-testid="workspace"]:not([hidden])');
  const ta = ws.querySelector("textarea");
  const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return {
    cv: getComputedStyle(ws).contentVisibility,
    taVisible: ta.checkVisibility(),
    rowVisible: ws.querySelector("[data-table]").checkVisibility(),
    hitShown: !!hit && shown.contains(hit),
    hitHidden: !!hit && ws.contains(hit),
  };
});
check(hidden.cv === "hidden", `the hidden window is content-visibility: hidden (${hidden.cv})`);
check(!hidden.taVisible && !hidden.rowVisible, "its editor and schema rows are not visible");
check(hidden.hitShown && !hidden.hitHidden, "the middle of the screen belongs to the shown window");
await page.screenshot({ path: `${OUT}/1-window-2.png` });

// 3. Back to window 1: its text and its list's scroll are as they were.
await page.keyboard.press("Control+1");
await page.waitForTimeout(200);
const back = await page.evaluate(() => {
  const ws = document.querySelector('[data-testid="workspace"]:not([hidden])');
  return { text: ws.querySelector("textarea").value, scroll: ws.querySelector('[data-testid="sb-scroll"]').scrollTop };
});
check(back.text === "SELECT 'window one';", "window 1 keeps its editor text");
check(back.scroll === 3000, `window 1 keeps its schema list's scroll (${back.scroll})`);
await page.screenshot({ path: `${OUT}/2-window-1.png` });

// 4. Ten switches: the commit stays small.
const before = await page.evaluate(() => window.__ROWKERY_TIMINGS__.ledger().length);
for (let i = 0; i < 10; i++) {
  await page.keyboard.press(i % 2 ? "Control+1" : "Control+2");
  await page.waitForTimeout(80);
}
const spans = (await page.evaluate(() => window.__ROWKERY_TIMINGS__.ledger())).slice(before).filter((l) => l.mark === "window-switch");
const commits = spans.map((s) => s.commit_ms).sort((a, b) => a - b);
const median = commits.length ? commits[commits.length >> 1] : null;
check(commits.length === 10, `ten window-switch spans (${commits.length})`);
check(median !== null && median < 100, `median window-switch commit ${median} ms (< 100)`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
