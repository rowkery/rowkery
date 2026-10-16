#!/usr/bin/env node
// The New Connection sheet in its new order (stubbed `invoke`): identity
// (libpq defaults dim) → probe line → Advanced (closed; SSL sentence) →
// Labels and safety in words. Auto-probe fires 600 ms after Host, Database
// and User are filled, never twice for one tuple, and stops after two
// refused logins until a field changes; ⌘T always probes. A probe error
// lands under its field. Save on a failed tuple keeps the sheet ("Save
// anyway"); a good tuple saves without probing again. SQLite: Choose file…
// and a dropped file fill the path.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/connection-sheet-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/connection-sheet";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__PROBES__ = [];
  window.__SAVED__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [{ name: "kiosks", columns: [col("id", "int8")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 5432, database: "rowkery", username: "rowkery" }, ...window.__SAVED__], active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "probe_connection": {
          const { connection: c, secrets } = args;
          window.__PROBES__.push({ ...c, password: secrets.db_password ?? "" });
          await new Promise((r) => setTimeout(r, 60));
          if (c.kind === "sqlite") return { ok: true, message: "SQLite 3.45.0", elapsed_ms: 4 };
          if (secrets.db_password === "right") return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 212 };
          return { ok: false, message: `password authentication failed for user "${c.username}"`, elapsed_ms: 0 };
        }
        case "explain_connect_error":
          if (/password authentication failed/.test(args.error)) return { class: "auth", cause: `The server rejected the password for ${args.username}.`, field: "password" };
          return { class: "unknown", cause: null, field: null };
        case "choose_file":
          return args.kind === "sqlite" ? "/Users/me/dev/app/dev.sqlite" : null;
        case "save_connection":
          window.__SAVED__.push(args.connection);
          return null;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text().slice(0, 400)));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
const probes = () => page.evaluate(() => window.__PROBES__.length);
const probeState = () => page.getAttribute("[data-probe]", "data-probe");
const field = (name) => `[data-testid="nc-sheet"] [data-field="${name}"] input`;
const quiet = () => page.waitForTimeout(900); // past the 600 ms debounce and the stub's 60 ms

await page.mouse.click(700, 500);
await page.keyboard.press("Control+N");
await page.waitForSelector('[data-testid="nc-sheet"]');

// Order and defaults.
const order = await page.$$eval('[data-testid="nc-sheet"] [data-section]', (els) => els.map((e) => e.dataset.section));
check(order.join(",") === "identity,advanced,labels", `sections in order: ${order}`);
const fields = await page.$$eval('[data-testid="nc-sheet"] [data-section=identity] [data-field]', (els) => els.map((e) => e.dataset.field));
check(fields.join(",") === "name,host,port,database,username,password", `identity fields: ${fields}`);
// Class on purpose: .nc-default is the dim prefill style under test.
check((await page.$(`${field("host")}.nc-default`)) !== null && (await page.inputValue(field("host"))) === "localhost", "Host prefilled with localhost, dim");
check((await page.textContent('[data-field="database"] [data-testid="nc-label"]')).includes("*"), "Database is marked required");
check((await page.$('[data-testid="nc-advanced-body"]')) === null, "Advanced is closed by default");
const envWords = await page.$$eval("[data-env-choice]", (els) => els.map((e) => e.textContent.trim()));
// The inspector's form (Paper, 2026-10-10) names environments by their tags, the full word in the title.
const envTitles = await page.$$eval("[data-env-choice]", (els) => els.map((e) => e.title));
check(envWords.join(" · ") === "None · prd · stg · dev · local" && envTitles.join(",") === "No environment,Production,Staging,Development,Local", `environment by its tag: ${envWords.join(" · ")} (${envTitles.join(", ")})`);
check((await page.getAttribute('[data-safe-choice="off"]', "aria-checked")) === "true", "safe mode Off preselected");
// The inspector's form drops the hint paragraphs (Paper review, 2026-10-10): the MCP row's sub-line says it.
check((await page.textContent('[data-testid="nc-sheet"]')).includes("read-only · setup command after save"), "the MCP row's sub-line");
await page.screenshot({ path: `${OUT}/1-new.png` });

// Auto-probe waits for Host, Database and User.
await page.fill(field("host"), "db.internal");
await page.fill(field("database"), "wallet");
await quiet();
check((await probes()) === 0, "no probe before User is filled");
await page.fill(field("username"), "app");
await page.waitForFunction(() => window.__PROBES__.length === 1);
await page.waitForSelector('[data-probe="error"]');
check((await page.textContent('[data-field="password"]')).includes("The server rejected the password for app."), "the refused login lands under Password");
check((await page.$('[data-field="password"][data-invalid]')) !== null, "Password is marked");
await page.screenshot({ path: `${OUT}/2-auth-error.png` });

// A second refused login stops auto-probing.
await page.fill(field("password"), "wrong");
await page.waitForFunction(() => window.__PROBES__.length === 2);
await page.waitForSelector('[data-probe="locked"]');
check((await page.textContent("[data-probe]")).includes("Stopped trying after two failed logins"), "two refused logins: stopped trying");
await page.screenshot({ path: `${OUT}/3-locked.png` });

// ⌘T ignores the lockout and the dedupe.
await page.keyboard.press("Control+T");
await page.waitForFunction(() => window.__PROBES__.length === 3);
check(true, "⌘T probes the same tuple again");
await quiet();

// Changing a field lifts the lockout; a tuple already probed isn't probed again.
await page.fill(field("password"), "");
await quiet();
check((await probes()) === 3, "back to a probed tuple: no new probe");

// Save on a failed tuple keeps the sheet and offers Save anyway.
await page.keyboard.press("Control+Enter");
await page.waitForSelector("[data-save-anyway]");
check((await page.$('[data-testid="nc-sheet"]')) !== null && (await page.evaluate(() => window.__SAVED__.length)) === 0, "Save on a refused login keeps the sheet open, nothing saved");
check((await page.textContent("[data-save]")).includes("Save anyway"), "the primary reads Save anyway");

// The right password: Connected, and Save doesn't probe again.
await page.fill(field("password"), "right");
await page.waitForSelector('[data-probe="ok"]');
check((await page.textContent("[data-probe]")).includes("Connected in 212 ms · PostgreSQL 16.4"), "Connected in 212 ms · PostgreSQL 16.4");
check((await page.$('[data-field="password"][data-invalid]')) === null, "the mark is gone");
check((await page.$("[data-env-choice=none][aria-checked=true]")) !== null, "no environment guessed for db.internal");
await page.fill(field("name"), "wallet-prd");
check((await probeState()) === "ok", "renaming keeps the probe result (the name isn't probed)");
check((await page.$("[data-env-choice=prd][aria-checked=true]")) !== null && (await page.$("[data-suggested]")) !== null, "a -prd name suggests Production, marked suggested");
await page.click("[data-env-choice=stg]");
check((await page.$("[data-suggested]")) === null, "picking an environment drops 'suggested'");

// Advanced: the SSL sentence.
await page.click('[data-testid="nc-disclosure"]');
check((await page.textContent('[data-testid="nc-advanced-body"]')).includes("Prefer and Require don't check the server's certificate. Verify does."), "Advanced: SSL with its sentence");
await page.screenshot({ path: `${OUT}/4-connected-advanced.png` });
const before = await probes();
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__SAVED__.length === 1);
check((await probes()) === before, "Save on a tuple that connected saves without probing again");
const saved = await page.evaluate(() => window.__SAVED__[0]);
check(saved.name === "wallet-prd" && saved.environment === "stg" && saved.safe_mode === "off", "saved: name, picked environment, safe mode Off");
await page.waitForFunction(() => !document.querySelector('[data-testid="nc-sheet"]'));

// A URL with sslmode opens Advanced.
await page.keyboard.press("Control+N");
await page.waitForSelector('[data-testid="nc-sheet"]');
await page.fill(field("url"), "psql -h db.internal -U app -d wallet");
check((await page.inputValue(field("host"))) === "db.internal" && (await page.inputValue(field("username"))) === "app", "a psql line fills the fields");
await page.fill(field("url"), "postgres://app@db.internal/wallet?sslmode=require");
check((await page.$('[data-testid="nc-advanced-body"] [data-ssl-choice=require][aria-checked=true]')) !== null, "sslmode=require opens Advanced on Require");

// SQLite: Choose file… and a dropped file.
await page.click("[data-engine-tab=sqlite]");
check((await page.$("[data-drop-zone]")) !== null, "SQLite tab has a drop zone");
check((await page.$("[data-env-choice=none][aria-checked=true]")) !== null, "SQLite environment starts None");
await page.click("[data-choose-file]");
await page.waitForFunction(() => document.querySelector('[data-field="path"] input')?.value === "/Users/me/dev/app/dev.sqlite");
await page.waitForSelector('[data-probe="ok"]');
check((await page.textContent("[data-probe]")).includes("Opened in"), "Choose file… fills the path and it opens");
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "enter", paths: [] } })));
await page.waitForSelector("[data-drop-zone][data-dragging]");
await page.screenshot({ path: `${OUT}/5-sqlite-drag.png` });
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:file-drag", { detail: { type: "drop", paths: ["/tmp/shop.db"] } })));
await page.waitForFunction(() => document.querySelector('[data-field="path"] input')?.value === "/tmp/shop.db");
check((await page.$("[data-drop-zone][data-dragging]")) === null, "a dropped .db fills the path");
await browser.close();
