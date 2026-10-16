#!/usr/bin/env node
// Sessions tab (2026-10-15, "what's running") proof with a
// stubbed Tauri `invoke`. ⌘K Show sessions (also found by "locks") opens a
// Sessions tab on a Postgres window: sessions blocking others come first,
// then those waiting on a lock; our own tab reads "You · Query 1"; idle
// sessions hide behind a chip that can be removed. It refreshes every 2 s
// while shown and pauses while a row is picked or the pointer is over the
// list, and stops when another tab shows. Picking a row opens it in the
// inspector (who, transaction age, locks held, the query). End session asks
// first (Review SQL) even with safe mode off, then ends it; Cancel query runs
// at once; a Read-only connection's refusal is a toast. Light and dark.
// What the core reads and how safe mode gates a stop are proved by
// `cargo test -p rowkery-bridge postgres_sessions` and `sessions::tests`.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/sessions-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/sessions";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  localStorage.clear();
  window.__CALLS__ = [];
  window.__REFUSE__ = false;
  const connections = [
    {
      kind: "postgres",
      id: "pg",
      name: "Platform API",
      host: "db.prd.internal",
      port: 5432,
      database: "orders",
      username: "alice",
      environment: "prd",
    },
  ];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = ["customers", "orders", "products"].map((name) => ({
    name,
    kind: "table",
    columns: [col("id", "int8")],
    primary_key: ["id"],
    indexes: [],
    foreign_keys: [],
    row_estimate: { Approximate: 12 },
    partition_of: null,
  }));
  let windowId = null;
  const s = (pid, over) => ({
    pid,
    user: "api",
    application: "checkout",
    client: "10.0.4.12",
    state: "active",
    wait: null,
    xact_secs: 1,
    query_secs: 1,
    state_secs: 1,
    query: "SELECT 1",
    blocked_by: [],
    can_stop: true,
    rowkery_tag: null,
    tab: null,
    ...over,
  });
  let sessions = () => [
    s(48213, { user: "deploy", application: "alembic", query_secs: 252, xact_secs: 252, wait: "Lock: relation", blocked_by: [47102], query: "ALTER TABLE orders ADD COLUMN refund_id bigint" }),
    s(47102, { user: "alice", application: "Rowkery 0a1b2c3d", rowkery_tag: "0a1b2c3d", tab: { window_id: windowId, tab_id: 1 }, state: "idle in transaction", xact_secs: 400, state_secs: 380, query: "UPDATE orders\nSET price = price * 1.1\nWHERE category = 'gifts'" }),
    s(48230, { query_secs: 38.2, wait: "Lock: relation", blocked_by: [48213], query: "SELECT o.id, o.total FROM orders o WHERE o.customer_id = 4012" }),
    s(48231, { query_secs: 37.9, wait: "Lock: relation", blocked_by: [48213], query: "SELECT o.id, o.total FROM orders o WHERE o.customer_id = 4019" }),
    s(48199, { user: "bi", application: "metabase", query_secs: 65, wait: "IO: DataFileRead", query: "SELECT date_trunc('day', created_at), count(*) FROM events GROUP BY 1" }),
    s(48250, { user: "alice", application: "psql", state: "idle in transaction", xact_secs: 12, query: "SELECT * FROM products WHERE sku = 'A-1'" }),
    s(48260, { user: "postgres", application: "", can_stop: false, query: null, query_secs: 3 }),
    s(48300, { state: "idle", state_secs: 120, query: "COMMIT" }),
    s(48301, { state: "idle", state_secs: 80, query: "COMMIT" }),
  ];
  const gone = new Set();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          windowId = args.windowId;
          return { database: "orders", catalog: { databases: [{ name: "orders", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_sessions": {
          const rows = sessions().filter((r) => !gone.has(r.pid));
          for (const r of rows) r.blocked_by = r.blocked_by.filter((b) => !gone.has(b));
          for (const r of rows) if (!r.blocked_by.length && r.wait?.startsWith("Lock")) r.wait = null;
          return rows;
        }
        case "session_locks":
          return args.pid === 47102 ? [{ table: "public.orders", mode: "RowExclusiveLock" }] : [];
        case "stop_session": {
          if (window.__REFUSE__) return { status: "refused", message: "This connection is read-only, so its sessions can't be stopped from Rowkery." };
          if (args.kind === "end" && !args.confirmed) return { status: "held", sql: `SELECT pg_terminate_backend(${args.pid})` };
          gone.add(args.pid);
          return { status: "stopped", gone: false };
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
const context = await browser.newContext({ viewport: { width: 1440, height: 820 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
const grid = `${ws} [data-sessions-grid]`;
const rowSel = (pid) => `${grid} [data-session-row="${pid}"]`;
const order = () => page.$$eval(`${grid} [data-session-row]`, (els) => els.map((e) => Number(e.getAttribute("data-session-row"))));
const reads = () => page.evaluate(() => window.__CALLS__.filter(([c]) => c === "list_sessions").length);
const live = () => page.getAttribute(`${ws} [data-sessions-live]`, "data-sessions-live");
const away = () => page.mouse.move(700, 30);

await page.waitForSelector(ws);
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.keyboard.press("Enter");
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. ⌘K finds it by "locks" and opens the Sessions tab.
await page.keyboard.press("Control+K");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type("locks");
await page.waitForSelector('[data-item="cmd:show-sessions"]');
check(/Show sessions/.test(await page.textContent('[data-item="cmd:show-sessions"]')), "⌘K finds Show sessions by typing locks");
await page.keyboard.press("Enter");
await page.waitForSelector(rowSel(47102));
check(!!(await page.$(`${ws} [data-testid="query-tab"][data-title="Sessions"][data-on]`)), "a Sessions tab opens and shows");
check(!(await page.$(`${ws} [data-testid="run-btn"]`)) && !(await page.$(`${ws} textarea[data-testid="sql-editor"]`)), "no editor and no Run on the Sessions tab");

// 2. Order and labels.
const first = await order();
check(JSON.stringify(first.slice(0, 2)) === JSON.stringify([47102, 48213]), `blockers first: ${first.join(", ")}`);
check(first.indexOf(48230) < first.indexOf(48199) && first.indexOf(48231) < first.indexOf(48199), "sessions waiting on a lock before the rest");
check(!first.includes(48300), "idle sessions are hidden");
check((await page.textContent(`${rowSel(47102)} [data-session-you]`)).trim() === "You · Query 1", "our own tab reads You · Query 1");
check((await page.getAttribute(`${rowSel(47102)} [data-session-blocking]`, "data-session-blocking")) === "1", "the holder says blocking 1");
check((await page.getAttribute(`${ws} [data-sessions-count]`, "data-sessions-count")) === "7", "the count says 7 of 9");
check(/Not visible to your login/.test(await page.textContent(rowSel(48260))), "a query the login can't read says so");
await away();
check((await live()) === "live", "it says Live");
await page.screenshot({ path: `${OUT}/1-sessions-light.png` });

// 3. It refreshes every 2 s while shown, not while hovered.
let before = await reads();
await page.waitForTimeout(4300);
check((await reads()) - before >= 2, `two refreshes in 4.3 s (${(await reads()) - before})`);
await page.hover(rowSel(48199));
check((await live()) === "paused", "hovering the list pauses it");
before = await reads();
await page.waitForTimeout(2500);
check((await reads()) === before, "no refresh while the pointer is over the list");
await away();

// 4. The idle chip.
await page.click(`${ws} [data-sessions-show-idle]`);
await page.waitForSelector(rowSel(48300));
check((await order()).length === 9, "removing the chip shows idle sessions too");
await page.click(`${ws} [data-sessions-hide-idle]`);
await page.waitForFunction((sel) => !document.querySelector(sel), rowSel(48300));

// 5. Pick the holder: details in the inspector, refresh paused.
await page.click(rowSel(47102));
await page.waitForSelector(`${ws} [data-session-detail="47102"]`);
await away();
check((await live()) === "paused", "a picked row pauses refresh");
const detail = await page.textContent(`${ws} [data-session-detail="47102"]`);
check(/public\.orders, RowExclusiveLock/.test(detail), "Holds lists the table lock");
check(/your tab “Query 1”/.test(detail) && /open 6m 4\ds/.test(detail), "who and the open transaction's age");
check((await page.getAttribute(`${ws} [data-session-chain]`, "data-session-chain")) === "3", "Blocking counts the whole chain (3)");
check(!!(await page.$(`${ws} [data-session-go]`)), "Go to tab is offered for our own tab");
check(await page.isDisabled(`${ws} [data-session-stop="cancel"]`), "Cancel query is off for an idle session");
before = await reads();
await page.waitForTimeout(2300);
check((await reads()) === before, "no refresh while a row is picked");
await page.screenshot({ path: `${OUT}/2-picked.png` });

// 6. End session asks first, then ends it.
await page.click(`${ws} [data-session-stop="end"]`);
await page.waitForSelector(`${ws} [data-session-confirm="end"]`);
const confirm = await page.textContent(`${ws} [data-session-confirm="end"]`);
check(/pg_terminate_backend\(47102\)/.test(confirm) && /Rolls back/.test(confirm) && /Unblocks\s*3 sessions/.test(confirm), "Review SQL shows the exact SQL, what rolls back and what it unblocks");
await page.screenshot({ path: `${OUT}/3-end-confirm.png` });
await page.click(`${ws} [data-session-confirm-run]`);
await page.waitForSelector('[data-toast="ok"]');
check(/Ended session 47102/.test(await page.textContent('[data-toast="ok"]')), "a toast says it ended");
const stops = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "stop_session").map(([, a]) => `${a.kind}:${a.confirmed}`));
check(JSON.stringify(stops) === JSON.stringify(["end:false", "end:true"]), `asked, then confirmed (${stops})`);
await page.waitForFunction((sel) => !document.querySelector(sel), rowSel(47102));
check(!(await page.$(`${ws} [data-session-detail]`)), "the inspector closes once it's gone");

// 7. Cancel query runs at once.
await page.click(rowSel(48213));
await page.waitForSelector(`${ws} [data-session-detail="48213"]`);
await page.click(`${ws} [data-session-stop="cancel"]`);
await page.waitForFunction(() => /Cancelled the query in session 48213/.test(document.querySelector("[data-toast]")?.textContent ?? ""));
check(true, "Cancel query runs without asking, with a toast");

// 8. A session the login can't stop.
await page.click(rowSel(48260));
await page.waitForSelector(`${ws} [data-session-detail="48260"]`);
check(await page.isDisabled(`${ws} [data-session-stop="end"]`), "End session is off for a session the login can't stop");

// 9. Read-only refuses with a toast.
await page.evaluate(() => (window.__REFUSE__ = true));
await page.click(rowSel(48199));
await page.waitForSelector(`${ws} [data-session-detail="48199"]`);
await page.click(`${ws} [data-session-stop="cancel"]`);
await page.waitForSelector('[data-toast="error"]');
check(/read-only/.test(await page.textContent('[data-toast="error"]')), "a Read-only connection's refusal is a toast");
await page.keyboard.press("Escape");

// 10. Another tab: no refresh.
await page.click(`${ws} [data-testid="query-tab"][data-title="Query 1"]`);
before = await reads();
await page.waitForTimeout(2500);
check((await reads()) === before, "no refresh while another tab shows");

// 11. Dark.
await page.click(`${ws} [data-testid="query-tab"][data-title="Sessions"]`);
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.click(rowSel(48230));
await page.waitForSelector(`${ws} [data-session-detail="48230"]`);
await away();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/4-sessions-dark.png` });

await browser.close();
