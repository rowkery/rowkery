#!/usr/bin/env node
// Startup (stubbed `invoke`): the window is created hidden and core shows it
// when the page calls `app_ready`, once, after React's first commit — with
// the restored window already in the DOM. Before the bundle runs, the inline
// script in index.html has set the window colour (or the macOS class), so
// the first frame is never white.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/startup-browser-proof.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";

function stubTauri() {
  localStorage.clear();
  window.__READY__ = [];
  // What the inline script did before any module ran.
  document.addEventListener("readystatechange", () => {
    if (window.__EARLY__) return;
    window.__EARLY__ = {
      background: document.documentElement.style.background,
      // Class on purpose: the root platform class drives the mac styling under test.
      mac: document.documentElement.classList.contains("platform-mac"),
      root: document.getElementById("root")?.childElementCount ?? null,
    };
  });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      if (cmd === "app_ready")
        window.__READY__.push({ at: performance.now(), chrome: !!document.querySelector('[data-testid="conn-chip"], [data-testid="workspace"]') });
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
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]');
await page.waitForTimeout(300);
const ready = await page.evaluate(() => window.__READY__);
check(ready.length === 1, `app_ready called once (${ready.length})`);
check(ready[0]?.chrome === true, "after the first commit: the window's chrome is in the DOM");
const early = await page.evaluate(() => window.__EARLY__);
// The pre-bundle sheet is the theme's --bg, #ffffff light or #1a1a1a dark,
// on every platform, macOS included (never transparent).
check(early && early.root === 0 && /255, 255, 255|#ffffff|26, 26, 26|#1a1a1a/.test(early.background), `the window colour is set before the bundle (${JSON.stringify(early)})`);
await browser.close();
