#!/usr/bin/env node
// Connect to start (stubbed `invoke`): a window with no connection shows the
// penguin, four actions with keys and nothing else (no tabs, editor or
// results, and no schema column, chip or ‹ ›); its window pill is
// hollow. ↵ opens the sample; ⌘O and a dropped .db become a connection
// named after the file; ⌘V outside a text field opens the sheet filled with
// the caret in the blank field; pasting a URL into the editor keeps the
// text and offers Connect ↵ (which takes it back out). On macOS, Found on
// this Mac lists Postgres answering on loopback: a refused login opens the
// sheet with Password marked, a good one connects.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/connect-to-start-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connect-to-start";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(opts) {
  localStorage.clear();
  window.__CALLS__ = [];
  if (opts.mac) Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  const sample = { kind: "sqlite", id: "sample", name: "Sample database", path: "/x/sample.sqlite", sample: true };
  window.__CONNS__ = opts.conns ?? [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }];
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "kiosks", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: window.__CONNS__, active_connection_id: null };
        case "open_window":
          return { database: "main", catalog: { databases: [{ name: "main", schemas: [{ name: "main", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "open_sample":
          if (!window.__CONNS__.some((c) => c.id === "sample")) window.__CONNS__ = [sample, ...window.__CONNS__];
          return sample;
        case "save_connection":
          window.__CONNS__ = [...window.__CONNS__.filter((c) => c.id !== args.connection.id), args.connection];
          return null;
        case "choose_file":
          return "/Users/me/data/shop.db";
        case "read_clipboard_text":
          return "postgres://app@db.internal:5433/wallet";
        case "probe_local_servers":
          return [{ port: 5432, user: "alice" }, { port: 54329, user: "alice" }];
        case "probe_connection":
          if (args.connection.port === 5432) return { ok: false, message: 'password authentication failed for user "alice"', elapsed_ms: 0 };
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 3 };
        case "explain_connect_error":
          return { class: "auth", cause: `The server rejected the password for ${args.username}.`, field: "password" };
        case "run_query":
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
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
const ws = '[data-testid="workspace"]:not([hidden])';
let page;
const fresh = async (opts = {}) => {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, opts);
  await page.goto(URL);
  await page.waitForSelector(`${ws} [data-empty-window]`);
};
const calls = (cmd) => page.evaluate((c) => window.__CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);
const visible = (sel) => page.isVisible(sel).catch(() => false);
const pasteOn = (selector, text) =>
  page.evaluate(
    ([sel, t]) => {
      const el = sel ? document.querySelector(sel) : document.body;
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [selector, text],
  );

// 1 · The screen, then ↵ opens the sample.
await fresh();
// Paper (2026-10-10): the four actions are cards, a sub-line with
// the key at its right under each title.
const actions = await page.$$eval("[data-empty-action]", (els) => els.map((e) => `${e.querySelector(".ew-label").textContent} ${e.querySelector("kbd").textContent}`)); // Class on purpose: the card's title, apart from its sub-line.
check(
  actions.join(" | ") === "New connection Ctrl+N | Open a SQLite file… Ctrl+O | Paste a postgres:// URL Ctrl+V | Open the sample database ↵",
  `four actions with keys: ${actions.join(" | ")}`,
);
check((await page.textContent('[data-testid="ew-title"]')) === "Connect to start", "titled Connect to start");
check((await page.$(`${ws} [data-empty-window] [data-pose="ready"]`)) !== null, "the penguin stands Ready");
check(!(await visible(`${ws} textarea[data-testid="sql-editor"]`)) && !(await visible(`${ws} [data-testid="results-card"]`)) && !(await visible(`${ws} [data-testid="query-tabs"]`)), "no editor, results or tabs");
// Paper (2026-10-10): no connection, no schema column and no tab
// row chrome (no chip, no ‹ ›); only ⌘K at the right.
check(!(await visible(`${ws} [data-testid="sidebar"]`)), "no schema column");
check(!(await visible('[data-testid="conn-chip"]')) && !(await visible(`${ws} [data-history-back]`)), "no connection chip or history arrows in the tab row");
check(!(await visible('[data-testid="sb-filter"]')), "no filter box");
// Class on purpose: the hollow penguin is the drawing under test (.penguin-plain).
// The empty window's title-bar pill is the plain mark and "New window".
check((await page.$('[data-testid="win-tab"][data-empty] .penguin-plain:not([data-pose])')) !== null && (await page.textContent('[data-testid="win-tab"][data-empty] [data-testid="win-name"]')) === "New window", "the empty window's pill: the plain mark and New window");
check((await page.$("[data-found-section]")) === null && (await calls("probe_local_servers")).length === 0, "no Found on this Mac off macOS");
await page.screenshot({ path: `${OUT}/1-empty.png` });
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"] [data-db-file]`);
await page.waitForFunction(() => !document.querySelector("[data-empty-window]")).catch(() => {}); // its 100 ms fade
check((await calls("open_sample")).length === 1 && (await page.$("[data-empty-window]")) === null, "↵ opened the sample in this window");

// 2 · ⌘O: the file becomes a connection named after it.
await fresh();
await page.keyboard.press("Control+O");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const savedFile = (await calls("save_connection")).at(-1)?.connection;
check(savedFile?.kind === "sqlite" && savedFile.name === "shop" && savedFile.path === "/Users/me/data/shop.db", `⌘O saved ${JSON.stringify(savedFile)}`);
check((await calls("open_window")).at(-1)?.connectionId === savedFile.id, "and connected this window to it");

// 3 · A dropped .db, with "Drop to open" while it hovers.
await fresh();
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "enter", paths: [] } })));
await page.waitForSelector("[data-empty-window][data-dragging]");
check((await page.textContent('[data-testid="ew-title"]')) === "Drop to open", "dragging over: Drop to open");
await page.screenshot({ path: `${OUT}/2-drop.png` });
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "drop", paths: ["/tmp/notes.txt", "/tmp/arcade.sqlite"] } })));
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await calls("save_connection")).at(-1)?.connection.name === "arcade", "the dropped arcade.sqlite became 'arcade'");

// 4 · ⌘V outside a text field: the sheet filled, caret in Password.
await fresh();
await pasteOn(null, "DATABASE_URL=postgres://app@db.internal:5433/wallet?sslmode=require");
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await page.inputValue('[data-field="host"] input')) === "db.internal" && (await page.inputValue('[data-field="port"] input')) === "5433", "paste opened the sheet filled");
const focused = await page.evaluate(() => document.activeElement?.closest("[data-field]")?.getAttribute("data-field"));
check(focused === "password", `caret in the blank field (${focused})`);
await page.screenshot({ path: `${OUT}/3-pasted.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));
// Not a connection string: nothing happens.
await pasteOn(null, "just some words");
await page.waitForTimeout(200);
check((await page.$('[data-testid="nc-sheet"]')) === null, "other text: nothing, no sheet");
// A webview that sends no paste event: the keydown asks core for the clipboard.
await page.evaluate(() => document.activeElement?.blur());
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true })));
await page.waitForSelector('[data-testid="nc-sheet"]');
check((await calls("read_clipboard_text")).length === 1 && (await page.inputValue('[data-field="database"] input')) === "wallet", "no paste event: ⌘V read the clipboard through core");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));

// 5 · A URL pasted into the editor stays text; the toast offers Connect ↵.
await page.keyboard.press("Enter"); // the sample, for an editor
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await page.keyboard.press("Control+End");
await page.keyboard.press("Enter");
const url = "postgres://app@db.internal/wallet";
await pasteOn(`${ws} textarea[data-testid="sql-editor"]`, url);
await page.keyboard.insertText(url);
await page.waitForSelector("[data-toast-offer]");
const toastText = await page.$$eval("[data-toast] > span, [data-toast] button", (els) => els.map((e) => e.textContent.trim()).join(" · "));
check(toastText === "Looks like a connection URL · Esc keeps the text · Connect ↵", `toast: ${toastText}`);
check((await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`)).endsWith(url), "the URL is in the editor as text");
await page.screenshot({ path: `${OUT}/4-editor-offer.png` });
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="nc-sheet"]');
check(!(await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`)).includes(url), "↵ took the URL back out of the editor");
check((await page.inputValue('[data-field="host"] input')) === "db.internal", "and opened the sheet filled");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));
await page.click(`${ws} textarea[data-testid="sql-editor"]`);
await pasteOn(`${ws} textarea[data-testid="sql-editor"]`, url);
await page.keyboard.insertText(url);
await page.waitForSelector("[data-toast-offer]");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector("[data-toast-offer]"));
check((await page.inputValue(`${ws} textarea[data-testid="sql-editor"]`)).endsWith(url) && (await page.$('[data-testid="nc-sheet"]')) === null, "Esc keeps the text");

// 6 · macOS: Found on this Mac.
await fresh({ mac: true });
await page.waitForSelector("[data-found-section]");
// Paper: every row prints "Connect ↵" at its right; the label is the row's words.
const found = await page.$$eval("[data-found]", (els) => els.map((e) => e.querySelector(".ew-label").textContent.trim())); // Class on purpose: the row's label apart from its Connect ↵.
check(found.join(" | ") === "Postgres · localhost:5432 · alice | Postgres · localhost:54329 · alice", `found: ${found.join(" | ")}`);
// Paper: the promise moved up, under the heading.
check((await page.textContent('[data-testid="ew-sub"]')) === "Nothing connects until you choose.", "the heading's line: nothing connects until you choose");
check((await calls("probe_connection")).length === 0, "nothing connected on its own");
// Past the four actions and Your connections (arcade) to the first Found row.
for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
check((await page.textContent('[data-found="5432"]')).includes("Connect ↵"), "the cursor row offers Connect ↵");
await page.screenshot({ path: `${OUT}/5-found-mac.png` });
await page.keyboard.press("Enter");
await page.waitForSelector('[data-field="password"][data-invalid]');
check((await page.textContent('[data-field="password"]')).includes("The server rejected the password for alice."), "refused login: the sheet with Password marked");
check((await page.inputValue('[data-field="database"] input')) === "alice" && (await page.inputValue('[data-field="port"] input')) === "5432", "filled with libpq's defaults");
await page.screenshot({ path: `${OUT}/6-found-refused.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));
await page.click('[data-found="54329"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const savedPg = (await calls("save_connection")).at(-1)?.connection;
check(savedPg?.port === 54329 && savedPg.username === "alice" && savedPg.database === "alice" && savedPg.environment === "local", "a good one connects and is saved as local");
await browser.close();
