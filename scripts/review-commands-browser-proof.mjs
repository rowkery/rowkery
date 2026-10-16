#!/usr/bin/env node
// Commands, keys and ⌘K after the review (stubbed `invoke`, Linux keys).
//
// 1. Under TablePlus, holding Ctrl+T opens one query tab: the auto-repeats
//    never open a window. The window pill's menu and the
//    Data | Structure tip print TablePlus's chords.
// 2. ⌘K "Hide tips" leaves ⌘K once it ran.
// 3. Ctrl+N inside ⌘K moves the cursor and opens no New connection sheet.
// 4. Quick Look's footer prints the platform's copy key (Ctrl+C), and the
//    Timings sheet's palette row reads Ctrl+K; no ⌘ off macOS.
// 5. A SQLite path typed into ⌘K: a missing file toasts "No SQLite file at
//    <path>" and saves nothing; a real one saves one connection, and the
//    same path again reuses it.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/review-commands-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/review-commands";
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
  const conns = [{ kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: conns, active_connection_id: null };
        case "save_connection":
          conns.push(args.connection);
          return null;
        case "sqlite_file_exists":
          return args.path === "/tmp/real.sqlite";
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.table} LIMIT 1000`;
        case "run_query":
        case "browse_table":
          return {
            columns: [{ name: "id", type_name: "int8" }, { name: "city", type_name: "text" }],
            rows: [[{ Int: 1 }, { Text: "KL" }], [{ Int: 2 }, { Text: "Penang" }]],
            row_count: 2,
            elapsed_ms: 1,
            error: null,
            cancelled: false,
          };
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
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([n]) => n === c).map(([, a]) => a), cmd);
const tabCount = () => page.$$eval(`${ws} [data-testid="query-tab"][data-reorder-key]`, (els) => els.length);
const tileCount = () => page.$$eval('[data-testid="win-tab"]', (els) => els.length);
const palette = '[data-testid="cp-panel"]';
const openPalette = async (text = "") => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(palette);
  if (text) await page.keyboard.type(text);
  await page.waitForTimeout(150);
};
const closePalette = async () => {
  for (let i = 0; i < 3 && (await page.$(palette)); i++) await page.keyboard.press("Escape");
  await page.waitForSelector(palette, { state: "detached" });
};

// 1 · TablePlus: a held Ctrl+T is one query tab, never a window.
await page.keyboard.press("Control+Shift+Slash");
await page.waitForSelector("[data-shortcuts]");
await page.click("[data-keymap-picker]");
await page.click('[data-keymap-option="tableplus"]');
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-shortcuts]", { state: "detached" });
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
const tabs0 = await tabCount();
const tiles0 = await tileCount();
await page.keyboard.down("Control");
for (let i = 0; i < 6; i++) await page.keyboard.down("t"); // the second down on is a repeat
await page.keyboard.up("t");
await page.keyboard.up("Control");
await page.waitForTimeout(400);
check((await tabCount()) === tabs0 + 1, `held Ctrl+T opened one query tab (${tabs0} → ${await tabCount()})`);
check((await tileCount()) === tiles0, `and no window (${tiles0} → ${await tileCount()} tiles)`);
await page.click('[data-testid="win-tab"]', { button: "right" });
await page.waitForSelector('[data-menu] [data-item="new-window"]');
const newWindowRow = await page.textContent('[data-menu] [data-item="new-window"]');
check(newWindowRow.includes("Ctrl+Alt+T"), `the rail tile's menu prints TablePlus's New window key (${newWindowRow.trim()})`);
await page.keyboard.press("Escape");
await page.screenshot({ path: `${OUT}/1-held-ctrl-t.png` });

// 2 · Hide tips leaves ⌘K once it ran.
await openPalette(">hide tips");
check(!!(await page.$('[data-item="cmd:hide-tips"]')), "⌘K offers Hide tips");
await page.keyboard.press("Enter");
await page.waitForSelector(palette, { state: "detached" });
await openPalette(">hide tips");
check(!(await page.$('[data-item="cmd:hide-tips"]')), "after it ran, ⌘K no longer lists Hide tips");
await closePalette();

// 3 · Ctrl+N in ⌘K moves the cursor and nothing else.
await openPalette(">tab");
const cursorOf = () => page.$eval(`${palette} [data-testid="cp-row"][aria-selected="true"]`, (e) => e.dataset.item).catch(() => null);
const before = await cursorOf();
await page.keyboard.press("Control+n");
await page.waitForTimeout(250);
const after = await cursorOf();
check(before !== after && !!after, `Ctrl+N moved the cursor (${before} → ${after})`);
check(!(await page.$('[data-testid="nc-sheet"]')), "and opened no New connection sheet");
await page.screenshot({ path: `${OUT}/3-ctrl-n.png` });
await closePalette();

// 4 · Quick Look's footer and the Timings row: the platform's keys.
await page.click(`${ws} [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="results-grid-wrap"] [data-row="0"]`);
await page.waitForTimeout(300);
await page.click(`${ws} [data-testid="results-grid-wrap"] [data-row="0"] [data-col="1"]`);
await page.keyboard.press("Space");
await page.waitForSelector(`${ws} [data-testid="ql-foot"]`);
const foot = await page.$eval(`${ws} [data-testid="ql-foot"]`, (e) => e.innerText.replace(/\s+/g, " ").trim());
check(foot.includes("Ctrl+C") && !/[⌘⌥⌃⇧]/.test(foot), `Quick Look's footer: ${foot}`);
await page.screenshot({ path: `${OUT}/4-quick-look.png` });
await page.keyboard.press("Escape");
await openPalette(">timings");
await page.keyboard.press("Enter");
await page.waitForSelector("[data-timings]");
const timings = await page.$eval("[data-timings]", (e) => e.innerText);
check(timings.includes("Ctrl+K open (last)") && !timings.includes("⌘"), "the Timings sheet's palette row reads Ctrl+K");
await page.screenshot({ path: `${OUT}/4-timings.png` });
await page.keyboard.press("Escape");
await page.waitForSelector("[data-timings]", { state: "detached" });

// 5 · A SQLite path typed into ⌘K.
await openPalette("/tmp/missing.sqlite");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-toast="error"]');
const toast = await page.textContent('[data-toast="error"] [data-testid="toast-message"]');
check(toast === "No SQLite file at /tmp/missing.sqlite", `a missing file toasts (${toast})`);
check((await calls("save_connection")).length === 0, "and saves no connection");
await page.screenshot({ path: `${OUT}/5-missing.png` });
await openPalette("/tmp/real.sqlite");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__CALLS__.some(([n]) => n === "save_connection"));
await page.waitForTimeout(400);
check((await calls("save_connection")).length === 1, "a real file saves one connection");
await openPalette("/tmp/real.sqlite");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check((await calls("save_connection")).length === 1, "the same path again reuses it (no second save)");
check((await calls("sqlite_file_exists")).length === 3, "each typed path was checked first");

await browser.close();
