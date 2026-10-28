#!/usr/bin/env node
// A changed SSH host key (stubbed `invoke`): the Couldn't-connect panel
// shows the saved and the offered fingerprint (core's `host_keys`, parsed
// and tested in rowkery-core) instead of the raw error, with Forget saved
// key first. Forget removes only the key shown; Undo puts it back; Retry is
// its own press, and a first connect that trusts the new key says which.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/ssh-host-key-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/ssh-host-key";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  window.__SAVED__ = "SHA256:old=";
  const NEW = "SHA256:new=";
  const tables = [{ name: "kiosks", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "arcade", host: "db.internal", port: 5432, database: "rowkery", username: "rowkery", ssh: { host: "bastion.internal", port: 22, username: "deploy", auth_method: "password", trust_host: true } },
            ],
            active_connection_id: null,
          };
        case "open_window":
          // Like the tunnel: a saved key that isn't the one offered is refused; none saved, the new one is trusted.
          if (window.__SAVED__ && window.__SAVED__ !== NEW)
            throw `Could not open tunnel to bastion.internal: SSH host key for bastion.internal:22 has CHANGED; nothing was sent (saved ${window.__SAVED__}, offered now ${NEW})`;
          if (!window.__SAVED__) {
            window.__SAVED__ = NEW;
            window.__TRUSTED__ = [["bastion.internal:22", NEW]];
          }
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "explain_connect_error": {
          const m = /saved (\S+), offered now (\S+)\)/.exec(args.error);
          return {
            class: "ssh_changed",
            cause: "The SSH host key for bastion.internal has CHANGED. Nothing was sent. If the server was rebuilt, check the new key with whoever runs it.",
            field: "sshHost",
            host_keys: m && { host: "bastion.internal", port: 22, saved: m[1], offered: m[2] },
          };
        }
        case "forget_ssh_host_key":
          if (window.__SAVED__ !== args.fingerprint) return false;
          window.__SAVED__ = null;
          return true;
        case "restore_ssh_host_key":
          if (window.__SAVED__) return false;
          window.__SAVED__ = args.fingerprint;
          return true;
        case "take_trusted_host_keys": {
          const t = window.__TRUSTED__ ?? [];
          window.__TRUSTED__ = [];
          return t;
        }
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
const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => {
  console.error("pageerror:", e.message);
  process.exitCode = 1;
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
const calls = (name) => page.evaluate((n) => window.__CALLS__.filter(([c]) => c === n), name);
const toast = async () => (await page.locator('[data-testid="toast-message"]').textContent())?.trim();

// 1. The panel: both fingerprints, not the raw error; Forget saved key first.
await page.waitForSelector(`${ws} [data-host-keys]`);
const keys = await page.textContent(`${ws} [data-host-keys]`);
check(keys.includes("SHA256:old=") && keys.includes("SHA256:new="), `both keys show: "${keys}"`);
check((await page.$(`${ws} [data-testid="sb-error-text"]`)) === null, "the raw error isn't repeated");
const first = await page.$eval(`${ws} .ew-error-actions button`, (b) => b.dataset.action);
check(first === "forget-key", `Forget saved key comes first (${first})`);
await page.screenshot({ path: `${OUT}/1-changed.png` });

// 2. Forget: only the key shown; it doesn't retry by itself.
const opensBefore = (await calls("open_window")).length;
await page.click(`${ws} [data-action="forget-key"]`);
await page.waitForSelector('[data-testid="toast-message"]');
const forgot = await calls("forget_ssh_host_key");
check(forgot.length === 1 && forgot[0][1].fingerprint === "SHA256:old=" && forgot[0][1].host === "bastion.internal" && forgot[0][1].port === 22, `forgot the key shown: ${JSON.stringify(forgot[0]?.[1])}`);
check((await toast()) === "Forgot the saved key for bastion.internal", `toast: "${await toast()}"`);
check((await page.textContent(".toast-detail")).includes("Retry trusts its new key"), "it says what Retry does");
await page.waitForTimeout(300);
check((await calls("open_window")).length === opensBefore, "Forget doesn't retry by itself");
await page.screenshot({ path: `${OUT}/2-forgot.png` });

// 3. Undo puts it back.
await page.click("[data-toast-undo]");
await page.waitForTimeout(200);
check((await page.evaluate(() => window.__SAVED__)) === "SHA256:old=", "Undo put the old key back");

// 4. Forget again, then Retry: the new key is trusted, and the toast names it.
await page.click(`${ws} [data-action="forget-key"]`);
await page.waitForTimeout(200);
await page.click(`${ws} [data-testid="sb-error-btn"][data-action="retry"]`);
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForFunction(() => document.querySelector('[data-testid="toast-message"]')?.textContent?.startsWith("Trusted"));
check((await toast()) === "Trusted bastion.internal's SSH key", `toast: "${await toast()}"`);
check((await page.textContent(".toast-detail")) === "SHA256:new=", "with the fingerprint it saved");
await page.screenshot({ path: `${OUT}/3-trusted.png` });
await browser.close();
