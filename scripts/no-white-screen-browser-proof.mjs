#!/usr/bin/env node
// Nothing a user pastes or a run sends takes the window down (stubbed
// `invoke`): a postgres:// URL with a stray `%` in its password leads ⌘K and
// fills the sheet as typed, with no fatal screen; a rows frame the webview
// can't read fails its run with an error instead of Running forever; a run
// whose done frame never comes is let go by Force stop; a promise nobody
// waited on that fails toasts once. Core's side (a worker that dies still
// sends a failed finish) is `finish_guard_ends_a_run_whose_worker_vanished`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/no-white-screen-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/no-white-screen";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  const col = (name) => ({ name, type_name: "TEXT", nullable: false });
  const tables = [{ name: "orders", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null }];
  let queryId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "Midway", host: "db", port: 5432, database: "midway", username: "app", environment: "dev" }], active_connection_id: null };
        case "open_window":
          return { database: "midway", catalog: { databases: [{ name: "midway", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "run_query": {
          // Answers with a query id (so the frames shim leaves it alone) and
          // plays the frames by hand: a garbled rows frame, or none at all.
          const id = ++queryId;
          const channel = args.onFrame;
          setTimeout(() => {
            channel.onmessage({ t: "columns", query_id: id, columns: [col("id")] });
            if (/garbled/.test(args.sql)) channel.onmessage(new Uint8Array(64).fill(7).buffer);
          }, 0);
          return id;
        }
        case "probe_connection":
          return { ok: false, message: "no server here", elapsed_ms: 0 };
        // Core never hears back from the worker: cancel and Force stop change nothing.
        case "cancel_query":
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (e) => {
  pageErrors.push(e.message);
  console.error("pageerror:", e.message);
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const shot = async (name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
await page.waitForSelector(ws);

// 1. A pasted URL whose password holds a stray `%`: ⌘K leads with it, no fatal screen.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.fill('[data-testid="cp-search"] input', "postgres://u:p%zz@db/app");
await page.waitForTimeout(100);
check((await page.$("[data-fatal-error]")) === null, "a stray % in a pasted URL leaves the window up");
const lead = await page.$(`[data-testid="cp-row"][data-row='0']`);
check((await lead?.getAttribute("data-pasted")) === "connection-url", "it still leads ⌘K as New connection from URL");
await shot("1-pasted-url");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="nc-sheet"]');
const field = (name) => `[data-testid="nc-sheet"] [data-field="${name}"] input`;
const filled = { host: await page.inputValue(field("host")), password: await page.inputValue(field("password")) };
check(filled.host === "db" && filled.password === "p%zz", `the sheet opens filled, the password as typed (${JSON.stringify(filled)})`);
check((await page.$("[data-fatal-error]")) === null, "New connection opens with no fatal screen");
await shot("2-sheet-filled");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached" });

// Connect for the runs.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
const runSql = async (sql) => {
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(sql);
  await page.keyboard.press("Control+Enter");
};

// 2. A rows frame the webview can't read: the run fails with an error, it doesn't hang.
await runSql("select 'garbled' as id");
await page.waitForSelector(`${ws} [data-cancel]`, { state: "detached", timeout: 5000 });
const errText = await page.textContent(`${ws} [data-testid="results-card"]`);
check(/Couldn't read the results/.test(errText ?? ""), "a garbled frame fails the run with what went wrong");
await shot("3-garbled-frame");

// 3. A run whose done frame never comes: Cancel, then Force stop, lets it go.
await runSql("select 'stuck' as id");
await page.waitForSelector(`${ws} [data-cancel="cancel"]`);
await page.click(`${ws} [data-cancel="cancel"]`);
await page.waitForSelector(`${ws} [data-cancel="force"]`);
await page.waitForTimeout(500);
check((await page.$(`${ws} [data-cancel="force"]`)) !== null, "an unanswered Cancel leaves it running, offering Force stop");
await page.click(`${ws} [data-cancel="force"]`);
await page.waitForSelector(`${ws} [data-cancel]`, { state: "detached", timeout: 5000 });
check(/let it go/.test((await page.textContent(`${ws} [data-testid="results-card"]`)) ?? ""), "Force stop clears a run core never reports back on, and says so");
await shot("4-force-stopped");

// The editor still runs after both.
await runSql("select 'garbled' as id");
await page.waitForSelector(`${ws} [data-cancel]`, { state: "detached", timeout: 5000 });
check(/Couldn't read the results/.test((await page.textContent(`${ws} [data-testid="results-card"]`)) ?? ""), "the tab runs again afterwards");

// 4. A promise nobody waited on fails: one toast, not one per failure.
await page.evaluate(() => {
  for (let i = 0; i < 5; i++) void Promise.reject(new Error(`stray ${i}`));
});
await page.waitForSelector('[data-toast="error"]', { timeout: 3000 });
const toasts = await page.$$eval('[data-toast="error"]', (els) => els.map((e) => e.textContent));
check(toasts.length === 1 && /stray 0/.test(toasts[0] ?? ""), `five stray rejections, one toast (${JSON.stringify(toasts)})`);
await shot("5-stray-toast");

// Playwright reports the stray rejections themselves as page errors; nothing else may be one.
const others = pageErrors.filter((m) => !/^stray \d$/.test(m));
check((await page.$("[data-fatal-error]")) === null && others.length === 0, `no fatal screen and no other page errors (${others.join("; ")})`);
await browser.close();
