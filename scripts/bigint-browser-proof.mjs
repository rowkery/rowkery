#!/usr/bin/env node
// int8 beyond 2^53 in the grid (stubbed `invoke` answering the way the Rust
// side now serializes them, { BigInt: "<digits>" }): the cell shows the exact
// digits, right-aligned like any number, and ⌘C / Ctrl+C copies them exactly.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/bigint-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// run_query answers stream as frames (src-tauri `Frame`); the stub keeps returning results.
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/bigint";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const tables = [
    {
      name: "ledger",
      columns: [{ name: "id", type_name: "int8", nullable: false }],
      primary_key: ["id"],
      indexes: [],
      foreign_keys: [],
      row_estimate: { Approximate: 3 },
      partition_of: null,
    },
  ];
  const result = {
    columns: [
      { name: "id", type_name: "int8" },
      { name: "expr", type_name: "" },
      { name: "note", type_name: "text" },
    ],
    rows: [
      [{ BigInt: "9223372036854775807" }, { BigInt: "9007199254740993" }, { Text: "2^63 − 1" }],
      [{ BigInt: "-9223372036854775808" }, { Int: 42 }, { Text: "−2^63" }],
      [{ Int: 9007199254740991 }, "Null", { Text: "2^53 − 1, still a number" }],
    ],
    row_count: 3,
    elapsed_ms: 1,
    error: null,
    cancelled: false,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd) => {
      switch (cmd) {
        case "list_connections":
          return {
            connections: [
              { kind: "postgres", id: "pg", name: "wallet-local", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" },
            ],
            active_connection_id: null,
          };
        case "open_window":
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2 };
        case "run_query":
          return structuredClone(result);
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

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])'); // Paper (2026-10-10): an empty window shows no connection chip (no tab row without a connection); wait for the window, then ⇧⌘O as before.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="sb-scroll"]');
await page.click('[data-testid="workspace"]:not([hidden]) textarea');
await page.keyboard.press("Control+Enter");
const cell = (r, c) => `[data-testid="workspace"]:not([hidden]) [data-row="${r}"] [data-col="${c}"]`;
await page.waitForSelector(cell(0, 0));
await page.waitForTimeout(1200); // the reveal cascade

const text = (sel) => page.textContent(sel);
check((await text(cell(0, 0))) === "9223372036854775807", `2^63 − 1 shows exact (${await text(cell(0, 0))})`);
check((await text(cell(1, 0))) === "-9223372036854775808", `−2^63 shows exact (${await text(cell(1, 0))})`);
check((await text(cell(0, 1))) === "9007199254740993", `2^53 + 1 in an untyped column shows exact (${await text(cell(0, 1))})`);
const align = await page.$eval(cell(0, 1), (el) => getComputedStyle(el).textAlign);
check(align === "right", `an untyped BigInt is right-aligned like a number (${align})`);

await page.click(cell(0, 0));
await page.keyboard.press("Control+c");
await page.waitForTimeout(200);
const copied = await page.evaluate(() => navigator.clipboard.readText());
check(copied === "9223372036854775807", `Ctrl+C copies the exact digits (${copied})`);
await page.screenshot({ path: `${OUT}/1-bigint-grid.png` });
console.log(`${OUT}/1-bigint-grid.png`);
await browser.close();
