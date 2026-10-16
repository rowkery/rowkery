#!/usr/bin/env node
// The penguin (stubbed `invoke`). Posture: the unmodified mark posed by a CSS
// transform. Ready (64 px, --text-muted) on Connect to start; it stays while
// the connect begun there runs, then the empty state fades out in 100 ms as
// the first schema lands, the app's one penguin motion. Tilted (64 px,
// --del, rotate(-10deg) about its feet) on Couldn't connect,
// with the cause, the raw error and Retry · Edit… keys from commands.ts; it
// stays through a Retry and is gone when the schema lands. Never beside data
// or while a query runs. Reduce Motion: the empty state leaves at once.
// Scenes at 1× and 2×.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/penguin-browser-proof.mjs [outDir]
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/penguin";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(opts) {
  localStorage.clear();
  window.__OPENS__ = 0;
  // Resolves the pending open_window when the proof says so.
  window.__RELEASE__ = null;
  const col = (name) => ({ name, type_name: "int8", nullable: false });
  const tables = [{ name: "kiosks", kind: "table", columns: [col("id")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null }];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "arcade", host: "db.internal", port: 5432, database: "rowkery", username: "rowkery" }], active_connection_id: null };
        case "open_window": {
          const n = ++window.__OPENS__;
          await new Promise((resolve) => (window.__RELEASE__ = resolve));
          window.__LANDED__ = performance.now();
          if (n <= opts.failures) throw "error connecting to server: Connection refused (os error 61)";
          return { database: "rowkery", catalog: { databases: [{ name: "rowkery", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: n };
        }
        case "explain_connect_error":
          return { class: "refused", cause: `Nothing is listening on ${args.host}:${args.port}.`, field: "host" };
        case "run_query": {
          await new Promise((resolve) => (window.__FINISH__ = resolve));
          return { columns: [{ name: "n", type_name: "int8" }], rows: [[{ Int: 1 }]], row_count: 1, elapsed_ms: 1, error: null, cancelled: false };
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
const ws = '[data-testid="workspace"]:not([hidden])';
let page;
const fresh = async ({ failures = 0, scale = 2, reducedMotion = "no-preference" } = {}) => {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale, reducedMotion });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, { failures });
  await page.goto(URL);
  await page.waitForSelector(`${ws} [data-empty-window]`);
};
const release = () => page.waitForFunction(() => window.__RELEASE__).then(() => page.evaluate(() => { const r = window.__RELEASE__; window.__RELEASE__ = null; r(); }));
const poses = () => page.$$eval("[data-pose]", (els) => els.map((e) => e.getAttribute("data-pose")));
/** The penguin's drawn width, its colour against a CSS variable, and the body's transform. */
const penguinAt = (sel, colorVar) =>
  page.$eval(
    sel,
    (svg, v) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${v})`;
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return {
        width: svg.getBoundingClientRect().width,
        color: getComputedStyle(svg).color,
        want,
        // Class on purpose: .penguin-body is the SVG group whose transform is under test.
        transform: getComputedStyle(svg.querySelector(".penguin-body")).transform,
        paths: [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")),
      };
    },
    colorVar,
  );
const pickArcade = async () => {
  await page.click('[data-saved-conn="pg"]');
  await page.waitForFunction(() => window.__RELEASE__);
};

// 1 · Connect to start: Ready, 64 px beside the serif heading (Paper,
// 2026-10-10; was 96 px above a list), --text-muted, upright. 1× and 2×.
for (const scale of [1, 2]) {
  await fresh({ scale });
  const ready = await penguinAt(`${ws} [data-empty-window] svg[data-pose="ready"]`, "--text-muted");
  check(ready.width === 64 && ready.color === ready.want, `${scale}×: Ready at 64 px in --text-muted (${ready.width}, ${ready.color})`);
  check(ready.transform === "none", `${scale}×: Ready stands upright (${ready.transform})`);
  check(ready.paths.length === 1, `${scale}×: the mark's one path, as drawn`);
  check((await poses()).join() === "ready", `${scale}×: one penguin on screen (${(await poses()).join()})`);
  await page.screenshot({ path: `${OUT}/1-ready-${scale}x.png` });
}

// 2 · A connect from the empty window: the penguin stays (inert) until the
// schema lands, then the empty state fades out within 100 ms.
await page.evaluate(() => {
  window.__GONE__ = null;
  window.__FADE__ = null;
  new MutationObserver(() => {
    const closing = document.querySelector("[data-closing] [data-empty-window]");
    if (closing && !window.__FADE__) {
      window.__FADE__ = closing.getAnimations().map((a) => ({ name: a.animationName, duration: a.effect.getTiming().duration }));
    }
    if (!document.querySelector("[data-empty-window]") && window.__GONE__ === null) window.__GONE__ = performance.now();
  }).observe(document.body, { subtree: true, childList: true, attributes: true });
});
await pickArcade();
check((await page.$(`${ws} [data-empty-window][data-connecting] svg[data-pose="ready"]`)) !== null, "connecting from it: the empty window stays, inert, Ready");
await page.screenshot({ path: `${OUT}/2-connecting.png` });
await release();
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForFunction(() => window.__GONE__ !== null);
const fade = await page.evaluate(() => ({ anims: window.__FADE__, ms: window.__GONE__ - window.__LANDED__ }));
check(fade.anims?.length === 1 && fade.anims[0].name === "fade-out" && fade.anims[0].duration === 100, `the empty state fades out over 100 ms (${JSON.stringify(fade.anims)})`);
check(fade.ms < 250, `and is gone ${Math.round(fade.ms)} ms after the schema landed (100 ms fade plus frames)`);
check((await poses()).length === 0, "with data on screen there is no penguin");

// 3 · While a query runs: no penguin.
await page.click(`${ws} [data-testid="sql-editor"]`);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => window.__FINISH__);
await page.waitForSelector(`${ws} [data-testid="query-tab-spin"]`);
check(true, "a query runs (its tab spins)");
check((await poses()).length === 0, "no penguin while the query runs");
await page.screenshot({ path: `${OUT}/3-running.png` });
await page.evaluate(() => window.__FINISH__());

// 4 · Couldn't connect: Tilted 64 px, cause, raw error, keys from commands.ts.
// Paper (2026-10-10): in Connect to start's column in place of the editor,
// the mark in --del (it was --text-dim in the schema panel).
for (const scale of [1, 2]) {
  await fresh({ failures: 2, scale });
  await pickArcade();
  await release();
  await page.waitForSelector(`${ws}[data-conn-state="error"] [data-connect-error] [data-cause]`);
  const tilted = await penguinAt(`${ws} [data-connect-error] svg[data-pose="tilted"]`, "--del");
  check(tilted.width === 64 && tilted.color === tilted.want, `${scale}×: Tilted at 64 px in --del (${tilted.width}, ${tilted.color})`);
  const deg = (() => {
    const m = /matrix\(([^)]+)\)/.exec(tilted.transform)?.[1].split(",").map(Number);
    return m ? Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI) : NaN;
  })();
  check(deg === -10, `${scale}×: leaning -10° (${tilted.transform})`);
  await page.waitForFunction(() => !document.querySelector("[data-empty-window]"));
  check((await poses()).join() === "tilted", `${scale}×: only the tilted penguin (the empty window faded out)`);
  const panel = await page.$eval(`${ws} [data-connect-error]`, (el) => ({
    text: el.textContent,
    btns: [...el.querySelectorAll('[data-testid="sb-error-btn"]')].map((b) => ({ label: b.textContent, title: b.title })),
    report: !!el.querySelector('[data-testid="sb-report"]'),
    raw: getComputedStyle(el.querySelector('[data-testid="sb-error-text"]')).fontFamily,
  }));
  check(panel.text.includes("Couldn't connect") && panel.text.includes("Nothing is listening on db.internal:5432."), "headline and one-line cause");
  check(panel.text.includes("Connection refused (os error 61)") && /mono/i.test(panel.raw), `the raw error in mono (${panel.raw})`);
  check(
    panel.btns.map((b) => b.label).join(" · ") === "Retry Ctrl+R · Edit… Ctrl+E" && panel.report,
    `Retry · Edit… · Report… (${panel.btns.map((b) => b.label).join(" · ")})`,
  );
  check(
    panel.btns.map((b) => b.title).join(" | ") === "Connect again  Ctrl+R | Open this connection's settings  Ctrl+E",
    `tooltips from the registry (${panel.btns.map((b) => b.title).join(" | ")})`,
  );
  await page.screenshot({ path: `${OUT}/4-tilted-${scale}x.png` });
}

// 5 · Retry: the penguin, cause and raw text stay until the result; a second
// failure updates them, the success removes them.
await page.click(`${ws} [data-testid="sb-error-btn"][data-action="retry"]`);
await page.waitForSelector(`${ws} [data-connect-error][data-retrying] svg[data-pose="tilted"]`);
check(true, "retrying: the tilted penguin and text stay");
await release();
await page.waitForSelector(`${ws}[data-conn-state="error"] [data-connect-error]:not([data-retrying])`);
await page.mouse.click(700, 400);
await page.keyboard.press("Control+R");
await page.waitForFunction(() => window.__RELEASE__);
await release();
await page.waitForSelector(`${ws}[data-conn-state="connected"] [data-table], ${ws}[data-conn-state="connected"] [data-table]`).catch(() => {});
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
check((await poses()).length === 0 && (await page.$(`${ws} [data-connect-error]`)) === null, "connected: no penguin, the schema shows");
await page.screenshot({ path: `${OUT}/5-retried.png` });

// 6 · Reduce Motion: the empty state leaves without a fade.
await fresh({ reducedMotion: "reduce" });
await page.screenshot({ path: `${OUT}/6-reduce-motion.png` });
await pickArcade();
await page.evaluate(() => {
  window.__CLOSING__ = false;
  new MutationObserver(() => {
    if (document.querySelector("[data-closing] [data-empty-window]")) window.__CLOSING__ = true;
  }).observe(document.body, { subtree: true, childList: true, attributes: true });
});
await release();
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForFunction(() => !document.querySelector("[data-empty-window]"));
check(!(await page.evaluate(() => window.__CLOSING__)), "Reduce Motion: gone at once, no fade frame");
await browser.close();
