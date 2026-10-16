#!/usr/bin/env node
// First launch with no saved connections (stubbed `invoke`): the app shows
// the empty state and saves nothing. Before, it saved the Docker test
// connection (and its password to the keychain) on every empty launch; that
// now happens only in proof builds (VITE_ROWKERY_AUTO_PROOF).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/no-seed-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/no-seed";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push(cmd);
      if (cmd === "list_connections") return { connections: [], active_connection_id: null };
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

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="idle"]');
await page.waitForTimeout(800);
const calls = await page.evaluate(() => window.__ROWKERY_CALLS__);
check(calls.includes("list_connections"), "listed connections");
check(!calls.includes("save_connection"), `saved nothing (calls: ${[...new Set(calls)].join(", ")})`);
check(!calls.includes("open_window"), "opened no window");
check((await page.title()) === "Rowkery", `window title is Rowkery (${await page.title()})`);
check(
  (await page.textContent('[data-testid="workspace"]:not([hidden])'))?.includes("Pick a connection to start"),
  "shows the empty state",
);
await page.screenshot({ path: `${OUT}/1-first-launch.png` });
console.log(`${OUT}/1-first-launch.png`);
await browser.close();
