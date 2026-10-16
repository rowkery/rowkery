#!/usr/bin/env node
// New connections verify the server's certificate by default (stubbed
// `invoke`). In the New Connection sheet, SSL follows the host until it is
// picked: localhost, 127.x, ::1, a socket directory or a .local name keep
// Prefer; any other host gets Verify. A pasted URL's own sslmode wins, and a
// mode picked by hand stays when the host changes. A certificate that
// doesn't verify opens Advanced and says so under SSL, in one line. A saved
// connection keeps the mode it was saved with.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/tls-default-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/tls-default";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

const CAUSE = "Couldn't verify the server's certificate. Check SSL under Advanced.";

function stubTauri(cause) {
  localStorage.clear();
  // Saved before this change: a remote host on Prefer.
  const connections = [{ kind: "postgres", id: "old", name: "wallet", host: "wallet-prd.db.internal", port: 5432, database: "wallet", username: "app", ssl_mode: "prefer" }];
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      window.__CALLS__.push([cmd, args]);
      switch (cmd) {
        case "list_connections":
          return { connections: structuredClone(connections), active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables: [] }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "probe_connection": {
          const c = args.connection;
          // A private CA: Verify can't check it (core's message).
          if (c.ssl_mode === "verify" && c.host === "db.internal")
            return { ok: false, message: "Couldn't verify the server's certificate (UnknownIssuer). Check SSL under Advanced.", elapsed_ms: 9 };
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 9 };
        }
        case "explain_connect_error":
          // As core's explain_connect_error answers it.
          return /certificate/.test(args.error) ? { class: "tls", cause, field: "ssl" } : { class: "unknown", cause: null, field: null };
        case "save_connection":
          connections.push(args.connection);
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
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.addInitScript({ path: LINUX_PLATFORM });
await page.addInitScript(stubTauri, CAUSE);
await page.goto(URL);
await page.waitForSelector('[data-testid="workspace"]:not([hidden])');

const sheet = '[data-testid="nc-sheet"]';
const mode = () => page.getAttribute(`${sheet} [data-ssl-choice][aria-checked="true"]`, "data-ssl-choice");
const field = (name) => `${sheet} [data-field="${name}"] input`;
const setHost = async (host) => {
  await page.fill(field("host"), host);
  await page.waitForTimeout(50);
};
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: await page.locator(sheet).boundingBox() });
};
const openNew = async () => {
  await page.keyboard.press("Control+n");
  await page.waitForSelector(sheet);
  await page.click(`${sheet} [data-testid="nc-disclosure"]`);
  await page.waitForSelector(`${sheet} [data-ssl-choice]`);
};
const closeSheet = async () => {
  await page.keyboard.press("Escape");
  await page.waitForSelector(sheet, { state: "detached" });
};

// 1. SSL follows the host.
await openNew();
check((await mode()) === "prefer", "a new sheet on localhost starts on Prefer");
const local = [];
for (const host of ["127.0.0.1", "::1", "/var/run/postgresql", "mac-mini.local"]) {
  await setHost(host);
  local.push(`${host}:${await mode()}`);
}
check(local.every((x) => x.endsWith(":prefer")), `local hosts keep Prefer (${local.join(", ")})`);
await setHost("wallet.c9xyz.eu-west-1.rds.amazonaws.com");
check((await mode()) === "verify", "a remote host switches to Verify");
check(await page.isVisible(field("sslRootCert")), "Verify shows the CA certificate field (system trust store by default)");
await shot("1-remote-host-verify");
await setHost("localhost");
check((await mode()) === "prefer", "back to localhost: Prefer again");

// 2. Picked by hand: stays when the host changes.
await page.click(`${sheet} [data-ssl-choice="require"]`);
await setHost("db.example.com");
check((await mode()) === "require", "a mode picked by hand stays when the host changes");
await closeSheet();

// 3. A pasted URL: its sslmode wins; without one, its host decides.
await openNew();
await page.fill(field("url"), "postgres://app@db.example.com:5432/wallet?sslmode=require");
await page.waitForTimeout(50);
check((await mode()) === "require", "a URL's sslmode=require wins over the remote default");
await setHost("other.example.com");
check((await mode()) === "require", "and stays when the host is edited after");
await closeSheet();
await openNew();
await page.fill(field("url"), "postgres://app@db.example.com:5432/wallet");
await page.waitForTimeout(50);
check((await mode()) === "verify", "a URL without sslmode to a remote host: Verify");
await page.fill(field("url"), "postgres://app@localhost:5432/wallet");
await page.waitForTimeout(50);
check((await mode()) === "prefer", "a URL without sslmode to localhost: Prefer");
await closeSheet();

// 4. A certificate Verify can't check: one line under SSL.
await page.keyboard.press("Control+n");
await page.waitForSelector(sheet);
await page.fill(field("name"), "internal");
await setHost("db.internal");
await page.fill(field("database"), "wallet");
await page.fill(field("username"), "app");
await page.waitForSelector(`${sheet} [data-testid="nc-ssl-error"]`, { timeout: 5000 });
check((await page.getAttribute(`${sheet} [data-testid="nc-disclosure"]`, "aria-expanded")) === "true", "the failure opens Advanced");
// Text on purpose: the message is what's under test.
const said = (await page.textContent(`${sheet} [data-testid="nc-ssl-error"]`)).trim();
check(said === CAUSE, `under SSL: "${said}"`);
await shot("2-certificate-not-verified");
await page.click(`${sheet} [data-ssl-choice="require"]`);
await page.waitForFunction((s) => !document.querySelector(`${s} [data-testid="nc-ssl-error"]`), sheet, { timeout: 5000 });
check(true, "picking another mode clears it");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(sheet, { state: "detached" });

// 5. Saving a new remote connection on the default sends Verify.
await openNew();
await page.fill(field("name"), "orders");
await setHost("orders.example.com");
await page.fill(field("database"), "orders");
await page.fill(field("username"), "app");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(sheet, { state: "detached" });
const saved = await page.evaluate(() => window.__CALLS__.filter(([c]) => c === "save_connection").map(([, a]) => a.connection));
check(saved.find((c) => c.name === "internal")?.ssl_mode === "require", "the hand-picked Require is what's saved");
check(saved.find((c) => c.name === "orders")?.ssl_mode === "verify", "a new remote connection saves Verify");

// 6. A connection saved before keeps its own mode.
await page.keyboard.press("Control+Shift+O");
await page.waitForSelector('[data-testid="conn-popover"]');
await page.click('[data-conn-id="old"]');
await page.waitForSelector('[data-testid="workspace"]:not([hidden])[data-conn-state="connected"]');
await page.evaluate(() => window.dispatchEvent(new CustomEvent("rowkery:command", { detail: "edit-connection" })));
await page.waitForSelector(sheet);
if ((await page.getAttribute(`${sheet} [data-testid="nc-disclosure"]`, "aria-expanded")) !== "true") await page.click(`${sheet} [data-testid="nc-disclosure"]`);
check((await mode()) === "prefer", "a saved remote connection on Prefer still reads Prefer");
await browser.close();
