#!/usr/bin/env node
// A config.json core couldn't read (stubbed `invoke`): the launch says so
// once, in an error toast that names the copy kept aside and offers to copy
// its path (a button only: nobody asked for it), and holds long enough to
// read. Copy path puts the full path on the clipboard. A reload, where core
// has no notice left (`take_config_notice` answers once), shows none.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/config-notice-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/config-notice";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const KEPT = "/home/me/.config/rowkery/config.json.bad-1761200000";
mkdirSync(OUT, { recursive: true });

function stubTauri(kept) {
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      // Core hands the notice over once per launch; the reload is the same launch.
      if (cmd === "take_config_notice") {
        if (sessionStorage.getItem("proof.taken")) return null;
        sessionStorage.setItem("proof.taken", "1");
        return { message: "Couldn't read config.json, so Rowkery started fresh", kept };
      }
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri, KEPT);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

const toast = await page.waitForSelector('[data-toast="error"]', { timeout: 5000 }).catch(() => null);
check(!!toast, "the launch shows an error toast");
// Text on purpose: the notice is what's under test.
const message = await page.textContent('[data-toast="error"] [data-testid="toast-message"]');
check(message?.includes("config.json") ?? false, `it says config.json couldn't be read (${message})`);
const detail = await page.textContent('[data-toast="error"]');
check(detail?.includes("config.json.bad-1761200000") ?? false, "it names the copy kept aside");
check((await page.$('[data-toast="error"][data-held] [data-toast-offer]')) !== null, "it offers Copy path and holds");
await page.screenshot({ path: `${OUT}/1-notice.png` });
await page.waitForTimeout(3500);
check((await page.$('[data-toast="error"]')) !== null, "still there after a plain toast would have gone");
await page.click("[data-toast-offer]");
await page.waitForSelector('[data-toast="ok"]');
check((await page.evaluate(() => navigator.clipboard.readText())) === KEPT, "Copy path copies the full path");
await page.screenshot({ path: `${OUT}/2-copied.png` });

await page.reload();
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
await page.waitForTimeout(800);
check((await page.$('[data-toast="error"]')) === null, "a reload says nothing more");
await browser.close();
