#!/usr/bin/env node
// The title bar's indicators and the centred ⌘K (2026-10-17), stubbed `invoke`:
// nothing sits at the title bar's right any more (no Safe mode or MCP button,
// no search box). The shown window's pill carries its safe mode shield while
// connected (the mode in its glyph and tooltip; a click opens the three-mode
// menu under it) and an agent mark while its connection is shared (a click
// opens the Agents page); a pill that isn't shown carries neither unless an
// agent just read it. ⌘K opens a 640 px card centred in the window, over a
// blurred, dimmed scrim that fades out with it.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/titlebar-indicators-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/titlebar-indicators";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  const conn = { kind: "postgres", id: "pg", name: "wallet-prd", host: "db.example", port: 5432, database: "wallet", username: "rowkery", environment: "prd", safe_mode: "confirm", allow_mcp: true };
  const table = { name: "wallets", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 10 }, partition_of: null };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ ...conn }], active_connection_id: null };
        case "save_connection":
          conn.safe_mode = args.connection.safe_mode;
          return null;
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: [table] }] }] }, elapsed_ms: 3, cached: false, open_seq: 1 };
        case "run_query":
          return { columns: [{ name: "n", type_name: "int4" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
        case "mcp_activity":
          return { entries: [], offset: 0 };
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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const shown = '[data-testid="win-tab"][data-on]';
const box = (sel) => page.locator(sel).first().boundingBox();
await page.waitForSelector(ws);

// 1. An empty window: no shield, no agent mark, nothing at the bar's right.
const right = () =>
  page.evaluate(() => {
    const tb = document.querySelector('[data-testid="titlebar"]');
    const add = tb.querySelector('[data-testid="win-add"]').getBoundingClientRect().right;
    return [...tb.querySelectorAll("button, [role=tab]")].filter((e) => e.getBoundingClientRect().left > add && e.getBoundingClientRect().width > 0).length;
  });
check(!(await page.$('[data-testid="titlebar"] [data-shield], [data-testid="win-mcp"], [data-testid="search-cap"]')), "an empty window's pill has no shield or agent mark, and there is no search box");

await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(200);

// 2. Connected: the shown pill carries the shield and the agent mark; the bar's right is empty.
const shield = `${shown} [data-shield]`;
check((await page.getAttribute(shield, "data-shield")) === "confirm", "the shown pill carries the shield, Confirm writes");
check((await page.getAttribute(shield, "title")) === "Safe mode: Confirm writes · Change…", "its tooltip names the mode");
const mark = `${shown} [data-testid="win-mcp"]`;
check(!!(await page.$(mark)) && (await page.getAttribute(mark, "data-recent")) === null, "a shared connection's shown pill carries the agent mark, no dot without a recent read");
check((await right()) === 0, "nothing sits right of + in the title bar");
const pill = await box(shown);
const sh = await box(shield);
check(sh.x > pill.x && sh.x + sh.width < pill.x + pill.width && pill.height === 28, "the shield sits inside the 28 px pill");
await page.mouse.move(640, 400);
await page.screenshot({ path: `${OUT}/1-pill.png`, clip: { x: 0, y: 0, width: 640, height: 48 } });

// 3. The shield opens the safe mode menu under it; picking changes the glyph.
await page.click(shield);
await page.waitForSelector('[data-menu="safe-mode"]');
const menu = await box('[data-menu="safe-mode"]');
check(menu.y >= sh.y + sh.height && Math.abs(menu.x - sh.x) < 2, `the menu opens under the shield (${Math.round(menu.x)}, ${Math.round(menu.y)})`);
check((await page.getAttribute(shield, "aria-expanded")) === "true", "the shield reads expanded while its menu is open");
await page.screenshot({ path: `${OUT}/2-safe-menu.png`, clip: { x: 0, y: 0, width: 640, height: Math.ceil(menu.y + menu.height + 16) } });
await page.click('[data-menu="safe-mode"] [data-item="read_only"]');
await page.waitForFunction((s) => document.querySelector(s)?.dataset.shield === "read_only", shield);
check(true, "picking Read-only changes the shield");

// 4. The agent mark opens the Agents page.
await page.click(mark);
await page.waitForSelector('[data-testid="agents-page"]');
check(true, "the agent mark opens the Agents page");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="agents-page"]', { state: "detached" });

// 5. A new window: the shield and the mark leave the pill that isn't shown.
await page.click('[data-testid="win-add"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="win-tab"]').length === 2);
await page.waitForTimeout(150);
check((await page.$$('[data-testid="titlebar"] [data-shield]')).length === 0 && (await page.$$('[data-testid="win-mcp"]')).length === 0, "a pill that isn't shown carries no shield or agent mark");
await page.keyboard.press("Control+1");
await page.waitForSelector(shield);
check((await page.$$('[data-testid="titlebar"] [data-shield]')).length === 1, "showing the window again brings its shield back to its pill");

// 6. ⌘K: centred, 640 px, over a blurred and dimmed scrim.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.waitForTimeout(250);
const cp = await box('[data-testid="cp-panel"]');
check(Math.round(cp.width) === 640 && Math.abs(cp.x + cp.width / 2 - 640) < 2 && cp.y > 48 && cp.y < 800 * 0.25, `a 640 px card centred in the window, near the top (${JSON.stringify(cp)})`);
const scrim = await page.$eval('[data-testid="cp-scrim"]', (e) => ({ filter: getComputedStyle(e).backdropFilter, bg: getComputedStyle(e).backgroundColor }));
check(/blur\(8px\)/.test(scrim.filter) && scrim.bg !== "rgba(0, 0, 0, 0)", `the window behind it is blurred and dimmed (${JSON.stringify(scrim)})`);
await page.screenshot({ path: `${OUT}/3-cmdk.png` });
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="cp-scrim"]', { state: "detached" });
check(true, "Esc closes it, scrim and all");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
