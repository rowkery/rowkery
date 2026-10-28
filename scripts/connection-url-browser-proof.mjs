#!/usr/bin/env node
// Pasted connection URLs (stubbed `invoke`, rowkery/reports#48 and #57): a
// password holding `#`, `?` or `@` fills the sheet as libpq reads it; the URL
// field shows the password hidden, and editing the URL keeps it; one that
// can't be read (a `/` in the password) opens the sheet and says why.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/connection-url-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connection-url";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [], active_connection_id: null };
        case "probe_local_servers":
          return [];
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
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForTimeout(500);
const sheet = '[data-testid="nc-sheet"]';
const field = (name) => `${sheet} [data-field="${name}"] input`;
/** A paste of `text` on `selector` (the document when null), as ⌘V gives it. */
const paste = (selector, text) =>
  page.evaluate(
    ([selector, text]) => {
      const target = selector ? document.querySelector(selector) : document.body;
      target.focus?.();
      const data = new DataTransfer();
      data.setData("text/plain", text);
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [selector, text],
  );

// 1. ⌘V outside a field: a password with # and ? fills the sheet, hidden in the URL.
await paste(null, "postgres://app:Sup3r#Se?cret@db2.internal/wallet2");
await page.waitForSelector(sheet);
await page.waitForTimeout(150);
const url = await page.inputValue(field("url"));
check(
  (await page.inputValue(field("host"))) === "db2.internal" && (await page.inputValue(field("password"))) === "Sup3r#Se?cret",
  "host and the whole password filled in",
);
check(!url.includes("Sup3r") && url.includes("•••"), `the URL shows the password hidden (${url})`);
await page.screenshot({ path: `${OUT}/1-filled.png` });
console.log(`${OUT}/1-filled.png`);

// 2. Editing the hidden URL keeps the real password.
await page.fill(field("url"), url.replace("db2.internal", "db3.internal"));
await page.waitForTimeout(100);
check(
  (await page.inputValue(field("host"))) === "db3.internal" && (await page.inputValue(field("password"))) === "Sup3r#Se?cret",
  "a changed host in the hidden URL keeps the password",
);

// 3. Pasted into the URL field: hidden at once.
await page.fill(field("url"), "");
await paste(field("url"), "postgres://ops:t0p@db4/ledger");
await page.waitForTimeout(100);
check(
  (await page.inputValue(field("url"))) === "postgres://ops:•••@db4/ledger" && (await page.inputValue(field("password"))) === "t0p",
  "pasted into the field, the password is hidden at once",
);
await page.keyboard.press("Escape");
await page.waitForSelector(sheet, { state: "detached" });

// 4. One that can't be read opens the sheet and says why.
await paste(null, "postgres://app:pa/ss@db5/wallet");
await page.waitForSelector(sheet);
await page.waitForTimeout(150);
const said = (await page.textContent(`${sheet} [data-field="url"]`)) ?? "";
check(/%2F/.test(said), `a / in the password: the URL field says why (${said.trim()})`);
await page.screenshot({ path: `${OUT}/2-unreadable.png` });
console.log(`${OUT}/2-unreadable.png`);

await browser.close();
