#!/usr/bin/env node
// Typing in a 5,000-line query (stubbed `invoke`). A keystroke colours only
// the blocks near the caret; far blocks whose text didn't change keep their
// colours for a moment and catch up a few per task (src/sqlLineBlocks.ts).
// This proves the overlay stays right while that happens:
//
// 1. After every keystroke the overlay's text is the textarea's, line for
//    line (only colours may lag, never text).
// 2. A quote typed on line 2 makes line 4,000 start in string colour once caught
//    up, and Backspace turns it back: the overlay ends as the full highlight.
// 3. The keystroke that opens the quote changes few overlay lines in its own
//    commit (≤ 3 blocks of 64), not 5,000.
// 4. Typing at the end keeps the overlay scrolled with the textarea.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/editor-typing-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/editor-typing";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const col = (name, type_name) => ({ name, type_name, nullable: true });
  const tables = [{ name: "orders", columns: [col("id", "int8"), col("name", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null }];
  const conn = { kind: "postgres", id: "pg", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" };
  localStorage.clear();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 3, server_version: "PostgreSQL 16.4" };
        case "list_databases":
          return [];
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
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

const text = Array.from({ length: 5000 }, (_, i) => `SELECT id, name, 'row ${i}' AS label FROM table_${i % 200} WHERE id > ${i}; -- line ${i}`).join("\n");
await page.evaluate((value) => {
  const ta = document.querySelector('[data-testid="workspace"]:not([hidden]) textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}, text);
await page.waitForTimeout(500);

/** The overlay's lines as text, the textarea's lines, and line `n`'s span classes. */
const overlay = (n) =>
  page.evaluate((n) => {
    const w = document.querySelector('[data-testid="workspace"]:not([hidden])');
    const pre = w.querySelector('[data-testid="sql-highlight"]');
    const lines = [...pre.children].map((d) => d.textContent);
    // Class on purpose: the syntax colour of a line is what's under test.
    const classes = [...(pre.children[n]?.querySelectorAll("span") ?? [])].map((s) => s.className);
    return { same: lines.join("\n") === w.querySelector("textarea").value, count: lines.length, classes };
  }, n);
/** Waits until line `n` starts in class `cls` (caught up). */
const settled = (n, cls) =>
  page
    .waitForFunction(
      ([n, cls]) => {
        const pre = document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="sql-highlight"]');
        return pre.children[n].querySelector("span")?.className === cls;
      },
      [n, cls],
      { timeout: 5000 },
    )
    .then(() => true, () => false);

const before = await overlay(3999);
check(before.same && before.count === 5000, "the overlay shows the 5,000 lines");
check(before.classes.includes("k") && before.classes.includes("c"), "line 4,000 starts as keywords and a comment");

// Count the overlay lines the opening quote's own commit changes.
await page.evaluate(() => {
  const pre = document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="sql-highlight"]');
  window.__changed = null;
  const mo = new MutationObserver((records) => {
    const lines = new Set();
    for (const r of records) {
      let el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      while (el && el.parentElement !== pre) el = el.parentElement;
      if (el) lines.add(el);
    }
    window.__changed = lines.size;
    mo.disconnect();
  });
  mo.observe(pre, { childList: true, subtree: true, characterData: true });
});
await page.focus(`${ws} textarea`);
const at = text.indexOf("\n") + 8;
await page.evaluate((at) => document.querySelector('[data-testid="workspace"]:not([hidden]) textarea').setSelectionRange(at, at), at);
await page.keyboard.type("'");
const first = await overlay(3999);
check(first.same, "right after the quote the overlay's text is the textarea's");
const changed = await page.evaluate(() => window.__changed);
check(changed !== null && changed <= 3 * 64, `the quote's own commit changes ${changed} overlay lines (≤ 192)`);
check(await settled(3999, "s"), "line 4,000 catches up: it starts inside the string");
await page.screenshot({ path: `${OUT}/1-quote-open.png` });

await page.keyboard.press("Backspace");
check((await overlay(3999)).same, "after Backspace the overlay's text is the textarea's");
check(await settled(3999, "k"), "line 4,000 goes back to keywords");
const back = await overlay(3999);
check(JSON.stringify(back.classes) === JSON.stringify(before.classes), "line 4,000 has its first colours again");

// A comment opened and closed, with keys in between.
for (const key of ["/", "*", "x", "Backspace", "Backspace", "Backspace"]) {
  if (key.length === 1) await page.keyboard.type(key);
  else await page.keyboard.press(key);
  check((await overlay(0)).same, `after ${key} the overlay's text is the textarea's`);
}
check(await settled(3999, "k"), "after the comment is gone line 4,000 is keywords again");

// 4. Typing at the end: the overlay scrolls with the textarea.
await page.keyboard.press("Control+End");
await page.keyboard.type(" AND x = 1");
await page.waitForTimeout(200);
const scroll = await page.evaluate(() => {
  const w = document.querySelector('[data-testid="workspace"]:not([hidden])');
  return [w.querySelector("textarea").scrollTop, w.querySelector('[data-testid="sql-highlight"]').scrollTop];
});
check(scroll[0] > 0 && Math.abs(scroll[0] - scroll[1]) < 1, `the overlay is scrolled with the textarea (${scroll.join(" / ")})`);
check((await overlay(4999)).same, "the last line is in the overlay");
await page.screenshot({ path: `${OUT}/2-end.png` });

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
