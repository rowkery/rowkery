#!/usr/bin/env node
// Connection errors that teach (stubbed `invoke`): a refused connect shows
// the tilted penguin, core's cause sentence (`explain_connect_error`, stubbed
// here; its classes are unit-tested in rowkery-core) and the raw error. Retry
// and ⌘R connect again; ⌘E opens the connection's settings with the field
// that failed (Host) marked, carrying the cause, and focused.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/connect-error-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connect-error";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__OPENS__ = 0;
  window.__EXPLAINS__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [{ name: "kiosks", columns: [col("id", "int8")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "db.internal", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          window.__OPENS__ += 1;
          // The first two connects fail like a server that isn't listening.
          if (window.__OPENS__ <= 2) throw "error connecting to server: Connection refused (os error 61)";
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "explain_connect_error":
          window.__EXPLAINS__.push(args);
          return { class: "refused", cause: `Nothing is listening on ${args.host}:${args.port}. Is the server running, and is the port right?`, field: "host" };
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
await page.waitForSelector(`${ws}[data-conn-state="error"]`);

// The failed panel: tilted penguin, core's cause sentence, the raw error.
await page.waitForSelector(`${ws} [data-connect-error] [data-cause]`);
const cause = await page.textContent(`${ws} [data-cause]`);
check(cause.includes("Nothing is listening on db.internal:5432"), `cause sentence from core: "${cause}"`);
check((await page.$(`${ws} [data-connect-error] [data-pose="tilted"]`)) !== null, "the penguin is tilted");
check((await page.textContent(`${ws} [data-connect-error]`)).includes("Connection refused (os error 61)"), "the raw error stays under it");
const ex = await page.evaluate(() => window.__EXPLAINS__.at(-1));
check(ex?.host === "db.internal" && ex?.port === 5432 && ex?.username === "rowkery", "explain_connect_error got the connection's host, port and user");
await page.screenshot({ path: `${OUT}/1-failed.png` });

// Retry button: connects again (and fails again).
await page.click(`${ws} [data-testid="sb-error-btn"][data-action="retry"]`);
await page.waitForFunction(() => window.__OPENS__ === 2);
await page.waitForSelector(`${ws}[data-conn-state="error"] [data-connect-error]`);
check(true, "Retry connected again");

// ⌘E (Ctrl+E): the connection's settings with Host marked and focused.
await page.mouse.click(700, 400);
await page.keyboard.press("Control+E");
await page.waitForSelector('[data-field="host"][data-invalid]');
const focused = await page.evaluate(() => document.activeElement?.closest("[data-field]")?.getAttribute("data-field"));
check(focused === "host", `Edit… opens the sheet with host focused (${focused})`);
check((await page.textContent('[data-field="host"]')).includes("Nothing is listening"), "the host field carries the cause");
await page.screenshot({ path: `${OUT}/2-edit-marked.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-field="host"]'));

// ⌘R (Ctrl+R) while failed: connect again; this time it works.
await page.mouse.click(700, 400);
await page.keyboard.press("Control+R");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await page.evaluate(() => window.__OPENS__)) === 3 && (await page.$(`${ws} [data-connect-error]`)) === null, "⌘R reconnected and the panel shows the schema");
await page.screenshot({ path: `${OUT}/3-connected.png` });
await browser.close();
