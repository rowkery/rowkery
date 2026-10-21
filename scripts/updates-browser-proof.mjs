#!/usr/bin/env node
// In-app updates proof without a Tauri webview (stubbed `invoke`): ⌘K "Check
// for updates…" answers "up to date" or "couldn't check"; a ready update shows
// "Rowkery 0.1.1 is ready · Restart", and Restart asks Rust to install and
// relaunch, unless a query is running, when it says so and doesn't; ↵ never
// takes it. ⌘K lists the command, and the quiet check after launch offers a
// ready update on its own. The real install path is scripts/update-rehearsal.sh.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/updates-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/updates";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    { kind: "postgres", id: "local", name: "Docker Postgres", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery", environment: "local" },
  ];
  const catalog = {
    databases: [
      {
        name: "rowkery",
        schemas: [
          {
            name: "public",
            tables: [{ name: "orders", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], row_estimate: { Approximate: 10 }, partition_of: null }],
          },
        ],
      },
    ],
  };
  // What check_for_update answers next: the proof sets it.
  window.__UPDATE__ = { status: "up-to-date", version: "0.1.0" };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "rowkery", catalog, elapsed_ms: 20 };
        case "check_for_update": {
          await new Promise((r) => setTimeout(r, 120));
          const u = window.__UPDATE__;
          if (u.error) throw u.error;
          return u;
        }
        case "run_query": {
          const secs = Number(/pg_sleep\((\d+(?:\.\d+)?)\)/.exec(args.sql)?.[1] ?? 0);
          const cancelled = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), secs * 1000);
            (window.__ROWKERY_PENDING__ ??= {})[`${args.windowId}:${args.tabId}`] = () => {
              clearTimeout(t);
              resolve(true);
            };
          });
          return {
            columns: [{ name: "n", type_name: "int8" }],
            rows: cancelled ? [] : [[{ Int: 1 }]],
            row_count: cancelled ? 0 : 1,
            elapsed_ms: 5,
            error: null,
            cancelled,
          };
        }
        case "cancel_query":
        case "close_query_tab":
          window.__ROWKERY_PENDING__?.[`${args.windowId}:${args.tabId}`]?.();
          return null;
        default:
          return null;
      }
    },
  };
}

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const visible = '[data-testid="workspace"]:not([hidden])';
const openPage = async ({ quiet }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    console.error("pageerror:", e.message);
    process.exitCode = 1;
  });
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "local", database: "rowkery" }], active: 0 }));
  });
  // The menu-pick page holds off the quiet check (15 s after launch) so it can't interleave.
  if (!quiet)
    await page.addInitScript(() => {
      const st = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...a) => st(fn, ms === 15_000 ? 1e9 : ms, ...a);
    });
  await page.goto(URL);
  await page.waitForSelector(visible + '[data-conn-state="connected"]');
  return page;
};

// 1. The quiet check after launch offers a ready update without a pick.
let page = await openPage({ quiet: true });
await page.evaluate(() => (window.__UPDATE__ = { status: "ready", version: "0.1.1", notes: null }));
check((await page.evaluate(() => window.__ROWKERY_CALLS__.filter(([c]) => c === "check_for_update").length)) === 0, "no check before the first query has had its turn");
await page.waitForSelector("[data-toast-offer]", { timeout: 20_000 });
check(
  (await page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent).join(" · "))).startsWith("Rowkery 0.1.1 is ready"),
  "the quiet check offers the ready update about 15 s after launch",
);
await page.context().close();

page = await openPage({ quiet: false });
const toastText = () => page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent).join(" · ")).catch(() => null);
const calls = (cmd) => page.evaluate((c) => window.__ROWKERY_CALLS__.filter(([name]) => name === c).length, cmd);
const pick = async () => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(">check for updates");
  await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:check-updates"]');
  await page.keyboard.press("Enter");
};
const shot = async (name) => {
  const box = await page.locator("[data-toast]").boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
  console.log(`${OUT}/${name}.png`);
};
// 2. Up to date.
await pick();
await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("up to date"));
check((await toastText()) === "Rowkery is up to date · 0.1.0", `up to date: ${await toastText()}`);
await shot("1-up-to-date");

// 3. The feed can't be reached.
await page.evaluate(() => (window.__UPDATE__ = { error: "error sending request: connection refused" }));
await page.waitForTimeout(1800);
await pick();
await page.waitForFunction(() => document.querySelector("[data-toast]")?.textContent.includes("Couldn't"));
check((await toastText()).startsWith("Couldn't check for updates"), `error: ${await toastText()}`);
check((await page.locator('[data-toast="error"]').count()) === 1, "the error toast has the error tone");

// 4. Ready, with a query running: Restart waits.
await page.evaluate(() => (window.__UPDATE__ = { status: "ready", version: "0.1.1", notes: "Faster paging" }));
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.type("SELECT pg_sleep(6);");
await page.click(visible + ' [data-testid="run-btn"]');
await page.waitForSelector(visible + ' [data-testid="card-meta"][data-state="running"]');
await page.waitForTimeout(1800);
await pick();
await page.waitForSelector("[data-toast-offer]");
check((await toastText()) === "Rowkery 0.1.1 is ready · or it installs when you quit", `ready: ${await toastText()}`);
check((await page.locator("[data-toast-offer]").textContent()).startsWith("Restart"), "the toast offers Restart");
await shot("2-ready");
await page.click("[data-toast-offer]");
await page.waitForTimeout(150);
check((await toastText()).startsWith("A query is running"), `Restart waits for the running query: ${await toastText()}`);
check((await calls("restart_to_update")) === 0, "nothing restarted while the query ran");
await shot("3-waits-for-query");

// 5. Nothing running: Restart asks Rust to install and relaunch.
await page.keyboard.press("Control+.");
await page.waitForSelector(visible + ' [data-testid="card-meta"]:not([data-state="running"])');
await page.waitForTimeout(1800);
await pick();
await page.waitForSelector("[data-toast-offer]");
// ↵ while you type is the editor's, never the toast's Restart.
await page.click(visible + ' [data-testid="sql-editor"]');
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
check((await calls("restart_to_update")) === 0, "↵ in the editor didn't restart");
check((await page.locator("[data-toast-offer]").count()) === 1, "the ready toast stays after ↵");
await page.click("[data-toast-offer]");
await page.waitForTimeout(150);
check((await calls("restart_to_update")) === 1, "Restart called restart_to_update");

// 6. ⌘K lists it.
await page.keyboard.press("Control+k");
await page.keyboard.type("check for updates");
const helpRow = await page.waitForSelector('[data-testid="cp-row"][data-item="cmd:check-updates"]', { timeout: 2000 }).then(() => 1, () => 0);
check(helpRow >= 1, "⌘K has Check for updates…");
await page.keyboard.press("Escape");

await browser.close();
