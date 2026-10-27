#!/usr/bin/env node
// Agent-proposed changes proof with a stubbed Tauri `invoke` (2026-10-15:
// one screen for one or many statements; 2026-10-16: nothing runs until
// Dry run). A waiting proposal puts a count on the Agents
// button, which opens the review page; a new one arriving toasts with Review.
// Opening a proposal reads its plan (`proposal_plan`) and never calls
// `proposal_dry_run`: each statement's SQL shows under its verb and table,
// the triggers it fires are listed above Dry run with "Triggers fire during
// the dry run", and Commit is disabled. Dry run puts the rows under each
// statement (changed cells old over new, inserts and deletes marked), says
// "N rows · rolled back" and enables Commit; a lock timeout shows as a plain
// error with Dry run again. A list of cards on the left (2026-10-17, shown for
// one waiting too) opens any of them in any order (click or ↑↓); each keeps
// its dry run while another shows, its card saying "N rows · dry run" or "No
// WHERE". SQL the lexer can't read shows whole
// with "Couldn't read the target table". The review is the Agents page's
// "Waiting for you" (2026-10-17), so deciding the last one leaves the page up.
// Commit ⇧⌘↵ sends the dry run's counts (rows and each table's); a "moved" answer swaps in the fresh
// dry run and saves nothing; Discard sends the note; the page shows the log when
// nothing waits. The plan, checks, dry run and commit themselves are proved
// by `cargo test -p rowkery-mcp` (`--features postgres-integration` for
// Postgres).
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/proposals-browser-proof.mjs [outDir]
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

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/proposals";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  const connections = [
    {
      kind: "postgres",
      id: "api",
      name: "Platform API",
      host: "api-db.c9x.rds.amazonaws.com",
      port: 5432,
      database: "orders",
      username: "app",
      environment: "stg",
      allow_mcp: true,
      mcp_access: { orders: { mode: "picked", tables: ["public.customers", "public.orders"] } },
    },
  ];
  const catalog = {
    databases: [
      {
        name: "orders",
        schemas: [
          {
            name: "public",
            tables: ["customers", "orders"].map((name) => ({
              name,
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              row_estimate: { Approximate: 4100 },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  };
  const now = Date.now();
  const P1 = {
    id: "p_000000000001",
    ts: now - 4 * 60_000,
    connection: "api",
    database: "orders",
    sql: "UPDATE customers SET plan = 'pro', seats = 10 WHERE id IN (12, 31, 47)",
    reason: "These three paid for Pro yesterday (Stripe invoices 8812, 8820, 8833) but their plan still says free.",
    expect_rows: 3,
    client: "claude-ai",
  };
  const P2 = {
    id: "p_000000000002",
    ts: now,
    connection: "api",
    database: "orders",
    sql: "INSERT INTO orders (id, customer_id, total) VALUES (9001, 12, 49.00);\nDELETE FROM orders",
    reason: "Re-create the missing order, then clear the test orders.",
    client: "claude-code",
  };
  const cols = ["id", "full_name", "plan", "seats", "country"];
  const upd = (rows) => ({
    verb: "UPDATE",
    target: "customers",
    sql: P1.sql,
    destructive: false,
    rows: rows.length,
    columns: cols,
    key: ["id"],
    changed: ["plan", "seats"],
    shown: rows.map(([id, name, seats, cc]) => ({
      before: [id, name, "free", seats, cc],
      after: [id, name, "pro", 10, cc],
    })),
    triggers: [],
    reach: { tables: [{ schema: "public", table: "customers", inserted: 0, updated: rows.length, deleted: 0 }], unnamed: 0 },
    table: ["public", "customers"],
  });
  const dry1 = { proposal: P1, connection_name: "Platform API", statements: [upd([[12, "Ada Park", 1, "SG"], [31, "Ravi Iyer", 3, "IN"], [47, "Mia Chen", 2, "NZ"]])], at_commit: null, unshared: [] };
  const moved1 = { proposal: P1, connection_name: "Platform API", statements: [upd([[12, "Ada Park", 1, "SG"], [47, "Mia Chen", 2, "NZ"]])], at_commit: null, unshared: [] };
  const ocols = ["id", "customer_id", "total"];
  const dry2 = {
    proposal: P2,
    connection_name: "Platform API",
    statements: [
      { verb: "INSERT", target: "orders", sql: "INSERT INTO orders (id, customer_id, total) VALUES (9001, 12, 49.00)", destructive: false, rows: 1, columns: ocols, key: ["id"], changed: [], shown: [{ before: null, after: [9001, 12, "49.00"] }], triggers: ["orders_audit"], reach: null, table: null },
      { verb: "DELETE", target: "orders", sql: "DELETE FROM orders", destructive: true, rows: 412, columns: ocols, key: ["id"], changed: [], shown: [{ before: [1, 12, "18.00"], after: null }, { before: [2, 31, "240.50"], after: null }, { before: [3, 47, "9.99"], after: null }], triggers: ["orders_audit"], reach: null, table: null },
    ],
    at_commit: null,
    unshared: [],
  };
  // SQL the lexer can't read: the plan has no verb or table for it.
  const P3 = {
    id: "p_000000000003",
    ts: now,
    connection: "api",
    database: "orders",
    sql: "WITH stale AS (SELECT id FROM orders WHERE total = 0) DELETE FROM orders WHERE id IN (SELECT id FROM stale)",
    reason: "Clear the zero-total orders.",
    client: "claude-code",
  };
  const plans = {
    [P1.id]: { connection_name: "Platform API", statements: [{ verb: "UPDATE", target: "customers", sql: P1.sql, destructive: false, triggers: [{ name: "customers_audit", event: "UPDATE" }] }] },
    [P2.id]: {
      connection_name: "Platform API",
      statements: [
        { verb: "INSERT", target: "orders", sql: dry2.statements[0].sql, destructive: false, triggers: [{ name: "orders_audit", event: "INSERT" }] },
        { verb: "DELETE", target: "orders", sql: dry2.statements[1].sql, destructive: true, triggers: [{ name: "orders_audit", event: "DELETE" }] },
      ],
    },
    [P3.id]: { connection_name: "Platform API", statements: [{ verb: null, target: null, sql: P3.sql, destructive: false, triggers: [] }] },
  };
  let queue = [P1];
  let commits = 0;
  let dryRuns = 0;
  window.__addProposal = () => queue.push(P2);
  window.__addOdd = () => queue.push(P3);
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "mcp_activity":
          return { entries: [], offset: 0, reset: true };
        case "open_window":
          return { database: "orders", catalog, elapsed_ms: 40 };
        case "run_query":
          return { columns: [], rows: [], row_count: 0, elapsed_ms: 1, error: null, cancelled: false };
        case "proposals_waiting":
          return structuredClone(queue);
        case "proposal_plan":
          return structuredClone(plans[args.id]);
        case "proposal_dry_run":
          await new Promise((r) => setTimeout(r, 40));
          // The first dry run meets a row another session holds.
          if (dryRuns++ === 0)
            throw "Another session is holding these rows, so the dry run stopped after 2 s. Nothing was changed.";
          return structuredClone(args.id === P1.id ? dry1 : dry2);
        case "proposal_commit":
          // The first commit finds a row moved; the second goes through.
          if (commits++ === 0) return { outcome: "moved", dry_run: structuredClone(moved1) };
          queue = queue.filter((p) => p.id !== args.id);
          return { outcome: "committed", rows: args.seen.rows };
        case "proposal_reject":
          queue = queue.filter((p) => p.id !== args.id);
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
const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const calls = (cmd) => page.evaluate((c) => window.__ROWKERY_CALLS__.filter(([x]) => x === c).map(([, a]) => a), cmd);

// Connect, so the page sits over a real window with its schema column.
const ws = '[data-testid="workspace"]:not([hidden])';
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="api"]');
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);

// 1. One waiting at launch: a count on the Agents button, and no toast (it was already there).
await page.waitForSelector('[data-testid="sb-proposals"]');
check((await page.textContent('[data-testid="sb-proposals"]')) === "1", "the Agents button counts 1 waiting");
check(!(await page.$("[data-toast-offer]")), "a proposal already waiting at launch doesn't toast");

// 2. A new one arrives: a toast with Review, and the count goes to 2.
await page.evaluate(() => window.__addProposal());
await page.waitForSelector("[data-toast-offer]", { timeout: 6000 });
// Text on purpose: the toast's wording is under test.
const toast = await page.textContent('[data-testid="toast-message"]');
check(/Claude Code proposed a change to orders/.test(toast), `arrival toast: "${toast}"`);
check((await page.textContent('[data-testid="sb-proposals"]')) === "2", "the count reads 2");

// 3. The button opens the review page on the oldest. Nothing runs: the SQL
// under its verb and table, the trigger above Dry run, Commit disabled.
await page.click('[data-testid="sb-agents"]');
await page.waitForSelector('[data-testid="agents-page"] [data-testid="pp-trigger"]');
const dryCalls = async () => (await calls("proposal_dry_run")).length;
check((await dryCalls()) === 0, "opening the review calls no dry run");
check((await calls("proposal_plan"))[0]?.id === "p_000000000001", "it reads the shown one's plan first");
check((await calls("proposal_plan")).map((a) => a.id).sort().join() === "p_000000000001,p_000000000002", "and every waiting one's, once, for its card");
check((await page.getAttribute('[data-testid="agents-page"]', "data-proposal")) === "p_000000000001", "the oldest proposal shows first");
check((await page.$$('[data-testid="pp-list"] [data-testid="pp-card"]')).length === 2, "two waiting: a card each in the list");
check((await page.getAttribute('[data-testid="pp-card"][aria-current="true"]', "data-proposal-id")) === "p_000000000001", "the oldest card is the one shown");
check((await page.textContent('[data-testid="pp-list-count"]')) === "2", "Waiting for you counts 2");
// Text on purpose: the cards' heads are under test.
check((await page.$$eval('[data-testid="pp-card-head"]', (h) => h.map((x) => x.textContent))).join(" | ") === "UPDATE customers | INSERT, DELETE orders", "cards name their verbs and tables");
check(await page.$('[data-proposal-id="p_000000000002"] [data-testid="pp-card-warn"]'), "the DELETE with no WHERE warns on its card");
// Text on purpose: the heading, the SQL and the lines are what's under test.
check((await page.textContent('[data-testid="pp-stmt-head"]')) === "UPDATE customers", "the statement's heading: UPDATE customers");
check((await page.textContent('[data-testid="pp-sql"]')).includes("WHERE id IN (12, 31, 47)"), "its exact SQL shows");
check((await page.getAttribute('[data-testid="pp-trigger"]', "data-trigger")) === "customers_audit", "the trigger is listed");
check(/customers_audit\s*runs on UPDATE\s*customers/.test(await page.textContent('[data-testid="pp-trigger"]')), "with its event and table");
check((await page.textContent('[data-testid="pp-dry-line"]')) === "Triggers fire during the dry run", "the line beside Dry run says triggers fire");
check((await page.getAttribute('[data-testid="pp-dry"]', "data-state")) === "idle", "the dry run waits for the user");
check(await page.$eval('[data-testid="pp-commit"]', (b) => b.disabled), "Commit is disabled before a dry run");
check(!(await page.$('[data-testid="pp-preview"]')), "no rows before the dry run");
check(!(await page.$('[data-testid="pp-count"]')), "no counts before the dry run");
// Class on purpose: Dry run is the orange Run button.
check(await page.$eval('[data-testid="pp-dry-run"]', (b) => b.classList.contains("run-btn")), "Dry run is the orange Run button");
await shot("1-opened");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("2-opened-dark");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

// 4. Dry run: another session holds a row, so it stops with a plain error.
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-testid="pp-dry"][data-state="error"]');
check(/^Another session is holding these rows/.test(await page.textContent('[data-testid="pp-dry-line"]')), "a lock timeout shows as a plain error");
check((await page.textContent('[data-testid="pp-dry-run"]')) === "Dry run again", "with Dry run again");
check(await page.$eval('[data-testid="pp-commit"]', (b) => b.disabled), "Commit stays disabled after a failed dry run");

// 5. Dry run again: the rows under the SQL, old over new; Commit enabled, ink.
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
check((await dryCalls()) === 2 && (await calls("proposal_dry_run")).every((a) => a.id === "p_000000000001"), "Dry run ran the proposal shown");
check((await page.$$('[data-cell="changed"]')).length === 6, "two changed cells in each of three rows");
check((await page.$$('[data-row="update"]')).length === 3, "three updated rows");
check((await page.$$eval('[data-testid="pp-cols"] code', (c) => c.map((x) => x.textContent))).join(",") === "plan,seats", "changed columns: plan, seats");
check(await page.$('[data-testid="pp-count"] [data-match]'), "the agent's expected 3 matches");
check((await page.textContent('[data-testid="pp-dry-line"]')) === "3 rows · rolled back", "the line says 3 rows · rolled back");
check(await page.$eval('[data-testid="pp-commit"]', (b) => !b.disabled), "Commit is enabled after the dry run");
// Class on purpose: the button that writes is ink.
check(await page.$eval('[data-testid="pp-commit"]', (b) => b.classList.contains("ink")), "Commit is the ink button");
check((await page.textContent('[data-testid="pp-reject"]')) === "Discard", "Reject is labelled Discard");
check(!(await page.$('[data-testid="pp-destructive"]')), "no warning for an UPDATE with a WHERE");
check(!(await page.$('[data-testid="pp-reach"]')) && !(await page.$('[data-testid="pp-stmt-other"]')), "one table only: no table list, no + in other tables");
await shot("3-after-dry-run");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("4-after-dry-run-dark");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

check((await page.textContent('[data-proposal-id="p_000000000001"] [data-testid="pp-card-rows"]')) === "3 rows · dry run", "its card says 3 rows · dry run");

// 6. Its card opens the second: two statements, an insert and a DELETE with no
// WHERE. Nothing runs until Dry run; the no-WHERE warning shows from the plan.
await page.click('[data-proposal-id="p_000000000002"]');
await page.waitForSelector('[data-proposal="p_000000000002"] [data-testid="pp-stmt"][data-verb="delete"]');
check((await dryCalls()) === 2, "switching proposals runs nothing");
check((await page.$$('[data-testid="pp-stmt"]')).length === 2, "one section per statement");
check((await page.$$('[data-testid="pp-trigger"]')).length === 2, "the trigger listed for each event it fires on");
check(await page.$('[data-testid="pp-destructive"]'), "DELETE with no WHERE warns before the dry run");
check(await page.$eval('[data-testid="pp-commit"]', (b) => b.disabled), "Commit is disabled on the new proposal");
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-proposal="p_000000000002"] [data-testid="pp-preview"][data-verb="delete"]');
check((await page.$$('[data-testid="pp-preview"]')).length === 2, "one preview per statement");
check((await page.$$('[data-row="insert"]')).length === 1 && (await page.$$('[data-row="delete"]')).length === 3, "the inserted row and the deleted rows are marked");
await shot("5-two-statements");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("5b-two-statements-dark");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

// 7. Discard with a note: it is sent, and the first comes back with its dry run kept.
await page.click('[data-testid="pp-reject"]');
await page.fill('[data-testid="pp-note"]', "Keep the test orders for now.");
await page.click('[data-testid="pp-reject-send"]');
await page.waitForSelector('[data-proposal="p_000000000001"] [data-testid="pp-dry"][data-state="done"]');
const rejected = (await calls("proposal_reject")).at(-1);
check(rejected?.id === "p_000000000002" && rejected?.note === "Keep the test orders for now.", "Discard sends the note");
check(await page.$eval('[data-testid="pp-commit"]', (b) => !b.disabled), "back on the first, its dry run is kept and Commit is ready");
check((await dryCalls()) === 3, "coming back ran no new dry run");
check((await page.$$('[data-testid="pp-list"] [data-testid="pp-card"]')).length === 1 && (await page.textContent('[data-testid="pp-list-count"]')) === "1", "with one left, the list stays with its one card");

// 8. SQL the lexer can't read: shown whole, no trigger list, one line says so.
await page.evaluate(() => window.__addOdd());
await page.waitForSelector('[data-testid="pp-list"] [data-proposal-id="p_000000000003"]', { timeout: 6000 });
await page.focus('[data-testid="agents-page"]');
await page.keyboard.press("ArrowDown");
await page.waitForSelector('[data-proposal="p_000000000003"] [data-testid="pp-dry-line"]');
check(!(await page.$('[data-testid="pp-stmt-head"]')) && !(await page.$('[data-testid="pp-trigger"]')), "no heading and no triggers for it");
check((await page.textContent('[data-testid="pp-sql"]')).startsWith("WITH stale AS"), "the whole SQL shows");
check((await page.textContent('[data-testid="pp-dry-line"]')) === "Couldn't read the target table", "the line says it couldn't read the target table");
check((await page.getAttribute('[data-testid="pp-card"][aria-current="true"]', "data-proposal-id")) === "p_000000000003", "↓ moved to its card");
// Text on purpose: a card for SQL the lexer can't read shows the SQL itself.
check((await page.textContent('[data-proposal-id="p_000000000003"] [data-testid="pp-card-head"]')).startsWith("WITH stale AS"), "its card shows the SQL's start");
await shot("6-unread");
await page.keyboard.press("ArrowUp");
await page.waitForSelector('[data-proposal="p_000000000001"] [data-testid="pp-dry-run"]');

// 9. Dry run, then Commit ⇧⌘↵: the rows moved, so nothing is saved and the fresh dry run shows.
await page.click('[data-testid="pp-dry-run"]');
await page.waitForSelector('[data-testid="pp-dry"][data-state="done"]');
await page.keyboard.press("Control+Shift+Enter"); // straight after the click: focus stayed on the page
await page.waitForFunction(() => document.querySelectorAll('[data-row="update"]').length === 2);
check(JSON.stringify((await calls("proposal_commit"))[0]?.seen.rows) === "[3]", "Commit sends the dry run's counts [3]");
check((await calls("proposal_commit"))[0]?.seen.reach[0]?.tables[0]?.updated === 3, "and each table's");
check(!(await page.$('[data-testid="pp-count"] [data-match]')), "2 rows no longer match the agent's 3");
check((await page.textContent('[data-testid="pp-dry-line"]')) === "2 rows · rolled back", "the fresh dry run's count");
await shot("7-moved");

// 10. Commit again: committed. Discard the last: with nothing left the page
// stays (it is the Agents page, 2026-10-17) and shows the log, empty here.
await page.click('[data-testid="pp-commit"]');
await page.waitForSelector('[data-proposal="p_000000000003"]');
check(JSON.stringify((await calls("proposal_commit"))[1]?.seen.rows) === "[2]", "the second commit sends [2]");
await page.click('[data-testid="pp-reject"]');
await page.click('[data-testid="pp-reject-send"]');
await page.waitForSelector('[data-testid="agents-page"] [data-testid="mcp-empty"]');
check(!(await page.$('[data-testid="pp-list-count"]')), "Waiting for you goes once nothing waits");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="agents-page"]', { state: "detached" });
check(!(await page.$('[data-testid="sb-proposals"]')), "back in the window, the count is gone");

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
