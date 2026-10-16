#!/usr/bin/env node
// Report an Issue proof without a Tauri webview (stubbed `invoke`, relay
// answered by Playwright): ⌘K "Report an issue…" and the Help menu's event
// open the sheet; Send waits for a description; only toggled-on parts reach
// the relay; a failed connection's "Report…" includes its error with the
// host masked; a relay failure offers Copy report; nothing asks for an email;
// Esc closes.
//
//   cd apps/rowkery-tauri
//   VITE_ROWKERY_REPORT_URL=https://relay.test/report npx vite --port 1420 &
//   node ../../scripts/report-browser-proof.mjs [outDir]
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
  const root = execSync("npm root -g").toString().trim();
  playwright = require(`${root}/playwright`);
}

const OUT = process.argv[2] ?? "/tmp/rowkery-proof/report";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const RELAY = "https://relay.test/report";
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  const pg = (id, name, host, environment, extra = {}) => ({
    kind: "postgres",
    id,
    name,
    host,
    port: 5432,
    database: "wallet",
    username: "app",
    environment,
    ...extra,
  });
  const connections = [
    pg("prd", "wallet", "wallet-prd.db.internal", "prd", {
      ssh: { host: "bastion.internal", port: 22, username: "alice", auth_method: "keyfile" },
    }),
    pg("replica", "billing-replica", "billing-ro.db.internal", "dev"),
  ];
  const catalog = {
    databases: [
      {
        name: "wallet",
        schemas: [
          {
            name: "public",
            tables: ["wallet_tx", "wallets"].map((name) => ({
              name,
              kind: "table",
              columns: [{ name: "id", type_name: "int8", nullable: false }],
              primary_key: ["id"],
              indexes: [],
              foreign_keys: [],
              row_estimate: { Approximate: 4100 },
              partition_of: null,
            })),
          },
        ],
      },
    ],
  };
  window.__ROWKERY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__ROWKERY_CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window": {
          await new Promise((r) => setTimeout(r, 40));
          if (args.connectionId === "replica") {
            throw "error connecting to billing-ro.db.internal:5432 (10.0.3.12): Connection refused (os error 61)";
          }
          return { database: "wallet", catalog, server_version: "16.4", elapsed_ms: 61 };
        }
        case "app_info":
          return { version: "0.1.0", os: "macos", os_version: "26.0", arch: "aarch64" };
        case "run_query":
          return {
            columns: [{ name: "id", type_name: "int8" }],
            rows: [[{ Int: 1 }]],
            row_count: 1,
            elapsed_ms: 12,
            error: null,
            cancelled: false,
          };
        case "browse_table_sql":
          return `SELECT * FROM ${args.schema}.${args.table} LIMIT 100;`;
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
const MARGIN = 40;
const context = await browser.newContext({
  viewport: { width: 1280 + MARGIN * 2, height: 800 + MARGIN * 2 },
  deviceScaleFactor: 2,
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

// The relay: records each report; `relayStatus` 502 makes it fail.
const posts = [];
let relayStatus = 200;
await page.route(RELAY, async (route) => {
  const req = route.request();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  posts.push(JSON.parse(req.postData()));
  const ok = relayStatus === 200;
  return route.fulfill({
    status: relayStatus,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(ok ? { ok: true, number: 52 } : { ok: false, error: "Couldn't file the report" }),
  });
});
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(() => {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem(
    "rowkery.windows",
    JSON.stringify({ windows: [{ connectionId: "prd", database: "wallet" }, { connectionId: "replica", database: "wallet" }], active: 0 }),
  );
});
await page.goto(URL);
// A desktop and the traffic lights, drawn behind the page (Chromium has none).
await page.addStyleTag({
  content: `
    html.platform-mac { background: radial-gradient(80% 110% at 12% 0%, #2d2629 0%, transparent 62%), linear-gradient(160deg, #1a1619, #131115) !important; }
    html.platform-mac body { padding: ${MARGIN}px !important; }
    html.platform-mac #root { border-radius: 12px; background: rgba(30, 30, 34, 0.5) !important; backdrop-filter: blur(46px) saturate(1.7);
      box-shadow: inset 0 0 0 0.5px rgba(255,255,255,.13), 0 0 0 0.5px rgba(0,0,0,.7), 0 34px 80px rgba(0,0,0,.55); }
    .proof-lights { position: fixed; z-index: 99; top: ${MARGIN + 18.5}px; left: ${MARGIN + 18}px; display: flex; gap: 9px; pointer-events: none; }
    .proof-lights i { width: 14px; height: 14px; border-radius: 50%; }`,
});
await page.evaluate(() => {
  const l = document.createElement("div");
  l.className = "proof-lights";
  for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
    const i = document.createElement("i");
    i.style.background = c;
    l.append(i);
  }
  document.body.append(l);
});

const visible = '[data-testid="workspace"]:not([hidden])';
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const rows = () => page.$$eval('[data-testid="rp-row"]', (els) => els.map((e) => [e.querySelector('[data-testid="rp-k"]').textContent, e.querySelector('[data-testid="rp-v"]').textContent]));
const toast = async () => {
  await page.waitForSelector("[data-toast]", { timeout: 2000 }).catch(() => {});
  return page.$$eval("[data-toast] > span", (els) => els.map((e) => e.textContent).join("")).catch(() => null);
};
const closed = () => page.waitForSelector('[data-testid="rp-sheet"]', { state: "detached" });

await page.waitForSelector(`${visible}[data-conn-state="connected"]`);
await page.fill(`${visible} [data-testid="sql-editor"]`, "SELECT count(*) FROM wallet_tx WHERE settled;");

// 1. ⌘K → Report an issue…
await page.keyboard.press("Meta+k");
await page.keyboard.type("report");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="rp-sheet"]');
// Without a relay URL baked in, Send only copies and the sheet never closes:
// say so instead of timing out on the first ⌘↵.
if ((await page.getAttribute('[data-testid="rp-sheet"]', "data-relay")) !== "on") {
  console.error("FAIL: this build has no VITE_ROWKERY_REPORT_URL; start Vite with VITE_ROWKERY_REPORT_URL=https://relay.test/report (see the header)");
  await browser.close();
  process.exit(1);
}
check(await page.evaluate(() => document.activeElement?.matches('[data-testid="rp-text"]')), "the description box has focus");
const r1 = await rows();
check(JSON.stringify(r1[0]) === JSON.stringify(["App", "Rowkery 0.1.0 · macOS 26.0 · Apple Silicon"]), `app row: ${r1[0]?.[1]}`);
check(JSON.stringify(r1[1]) === JSON.stringify(["Database", "PostgreSQL 16.4 · over SSH"]), `database row: ${r1[1]?.[1]}`);
check(r1.length === 3 && r1[2][0] === "Query", "no error row without an error; the tab's query is offered");
check(await page.locator('[data-testid="rp-switch"]').first().getAttribute("aria-checked") === "false", "the query starts off");
check(await page.locator('[data-testid="rp-send"]').isDisabled(), "Send waits for a description");
// Text on purpose: the head says where a report goes (a private repo, 2026-10-16).
check((await page.textContent('[data-testid="rp-sub"]'))?.trim() === "Sent privately to the Rowkery team", "the head says the report is sent privately");
{
  const head = await page.evaluate(() => {
    const r = (s) => document.querySelector(`[data-testid="rp-sheet"] ${s}`).getBoundingClientRect();
    const sub = r('[data-testid="rp-sub"]');
    const esc = r(".sheet-esc"); // Class on purpose: the head's esc keycap has no test id of its own.
    const sheet = r("");
    return { gap: esc.left - sub.right, escRight: sheet.right - esc.right, oneLine: sub.height < 20 };
  });
  check(head.gap > 0 && head.gap < 20 && head.escRight < 24 && head.oneLine, `the line sits on one line beside esc at the head's right (${JSON.stringify(head)})`);
}
await page.keyboard.type("Structure shows no indexes for wallet_tx.");
await shot("built-1-sheet");

await page.keyboard.press("Meta+Enter");
await closed();
check(posts.length === 1, "⌘↵ sends one report to the relay");
check(
  posts[0].description === "Structure shows no indexes for wallet_tx." &&
    posts[0].app === "Rowkery 0.1.0 · macOS 26.0 · Apple Silicon" &&
    posts[0].database === "PostgreSQL 16.4 · over SSH" &&
    !("query" in posts[0]) && !("error" in posts[0]),
  `the query stays out while its toggle is off: ${JSON.stringify(posts[0])}`,
);
check(posts[0].kind === "bug", "the type defaults to Bug");
check((await toast()) === "Report sentthank you", "toast: Report sent");

// 2. Help > Report an Issue… (the menu's event), query toggled on.
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "report-issue" })));
await page.waitForSelector('[data-testid="rp-sheet"]');
await page.keyboard.type("Second report");
check((await page.locator('[data-testid="rp-kind"][aria-checked="true"]').getAttribute("data-kind")) === "bug", "Bug starts selected");
await page.click('[data-testid="rp-kind"][data-kind="feature"]');
await shot("built-5-type-feature");
await page.click('[data-testid="rp-switch"]');
await page.click('[data-testid="rp-send"]');
await closed();
check(posts[1]?.query === "SELECT count(*) FROM wallet_tx WHERE settled;", "the Help menu opens it too; a toggled query goes along");
check(posts[1]?.kind === "feature", "the picked type (Feature) goes along");

// 3. A failed connection: Report… includes the error, host and IP masked.
await page.keyboard.press("Meta+2");
await page.waitForSelector(`${visible}[data-conn-state="error"]`);
check((await page.textContent(`${visible} [data-testid="sb-report"]`)).trim() === "Report…", "the failed connection offers Report…");
await shot("built-2-error-entry");
await page.click(`${visible} [data-testid="sb-report"]`);
await page.waitForSelector('[data-testid="rp-sheet"]');
const r3 = await rows();
const err = r3.find((r) => r[0] === "Error")?.[1];
check(err === "error connecting to host:5432 (host): Connection refused (os error 61)", `error row masks host and IP: ${err}`);
check(await page.locator('[data-testid="rp-row"][data-part="error"]').locator('[data-testid="rp-switch"]').getAttribute("aria-checked") === "true", "the error starts included");
check(!r3.some((r) => r[0] === "Database" && r[1].includes("16.4")), "no server version for a connection that never connected");
await page.keyboard.type("Can't connect to the replica");
await shot("built-3-sheet-from-error");

// 4. Relay down: say so, offer Copy report.
relayStatus = 502;
await page.keyboard.press("Meta+Enter");
await page.waitForSelector('[data-testid="rp-failure"]');
check((await page.textContent('[data-testid="rp-failure"]')) === "Not sent: Couldn't file the report", "the relay's refusal shows under the list");
check(posts[2]?.error === "error connecting to ‹host›:5432 (‹host›): Connection refused (os error 61)", "the masked error is what was sent");
check((await page.textContent('[data-testid="rp-send"]')).startsWith("Try again"), "Send becomes Try again");
await shot("built-4-relay-failed");
await page.click('[data-testid="rp-copy"]');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip.startsWith("Can't connect to the replica\n\nType: Bug\nRowkery 0.1.0") && clip.includes("‹host›"), "Copy report puts the masked report on the clipboard");
// Text on purpose: the check is that no "email" wording shows anywhere.
check((await page.locator('[data-testid="rp-sheet"] input, [data-testid="rp-sheet"] button', { hasText: /mail/i }).count()) === 0 && (await page.locator('[data-testid="rp-sheet"] input').count()) === 0, "no email field or Email instead anywhere");
await page.keyboard.press("Escape");
await closed();

// 5. Esc closes without sending.
relayStatus = 200;
const before = posts.length;
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "report-issue" })));
await page.waitForSelector('[data-testid="rp-sheet"]');
await page.keyboard.type("never mind");
await page.keyboard.press("Escape");
await closed();
check(posts.length === before, "Esc closes without sending");

check(pageErrors.length === 0, `no page errors ${pageErrors.join(" | ")}`);
await browser.close();
