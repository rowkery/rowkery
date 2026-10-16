#!/usr/bin/env node
// Relaunch restores the work (stubbed `invoke`): two query tabs with their SQL
// and which one was showing come back after a reload. Saving goes to core
// (`save_ui_state`, config.json) about a second after typing pauses, once,
// not per keystroke; without a backend the localStorage mirror restores it.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/persist-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/persist";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  // A fresh install the first time only: the reload must find what was saved.
  if (!sessionStorage.getItem("proof.started")) {
    localStorage.clear();
    sessionStorage.setItem("proof.started", "1");
  }
  window.__SAVES__ = JSON.parse(sessionStorage.getItem("proof.saves") ?? "[]");
  const table = { name: "kiosks", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === "save_ui_state") {
        window.__SAVES__.push(args.ui);
        sessionStorage.setItem("proof.saves", JSON.stringify(window.__SAVES__));
        return null;
      }
      // The backend's copy: the last save, as config.json would hold it.
      if (cmd === "load_ui_state") return window.__SAVES__.at(-1) ?? null;
      if (cmd === "list_connections")
        return { connections: [{ kind: "postgres", id: "pg", name: "wallet", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
      if (cmd === "open_window") return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 2 };
      return null;
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
const visible = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);

const editor = `${visible} textarea`;
await page.click(editor);
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("SELECT * FROM kiosks WHERE id = 7;");
// A second tab with its own SQL, left showing.
await page.keyboard.press("Control+k");
await page.keyboard.type(">new query tab");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
await page.click(editor);
await page.keyboard.type("SELECT now();");
const savesBefore = await page.evaluate(() => window.__SAVES__.length);
await page.waitForTimeout(1500);
const saves = await page.evaluate(() => window.__SAVES__);
check(saves.length - savesBefore === 1, `typing saved once after the pause (${saves.length - savesBefore} saves)`);
const windows = saves.at(-1)?.keys?.["rowkery.windows"];
check(
  windows?.windows?.[0]?.tabs?.map((t) => t.sql).join(" | ") === "SELECT * FROM kiosks WHERE id = 7; | SELECT now();",
  `config.json gets both tabs' SQL (${JSON.stringify(windows?.windows?.[0]?.tabs?.map((t) => t.sql))})`,
);
await page.screenshot({ path: `${OUT}/1-before.png` });

await page.reload();
await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.waitForTimeout(300);
const titles = await page.$$eval(`${visible} [data-reorder-key]`, (els) => els.map((e) => e.textContent?.trim()));
check(titles.length === 2, `two tabs restored (${titles.join(", ")})`);
check((await page.inputValue(editor)) === "SELECT now();", "the tab that was showing shows, with its SQL");
await page.click(`${visible} [data-reorder-key="1"]`);
await page.waitForTimeout(150);
check((await page.inputValue(editor)) === "SELECT * FROM kiosks WHERE id = 7;", "the other tab kept its SQL");
await page.screenshot({ path: `${OUT}/2-restored.png` });
await browser.close();
