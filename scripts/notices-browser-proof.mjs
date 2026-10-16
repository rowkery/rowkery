#!/usr/bin/env node
// Third-party notices proof (stubbed `invoke`, Linux keys). The app shows
// THIRD_PARTY_NOTICES.md (scripts/notices.mjs) in a Paper sheet.
//
// 1. The shortcut sheet's foot has a "Third-party notices" link; it closes
//    the shortcut sheet and opens the notices, focused, read on open from
//    its own chunk: the fonts (IBM Plex), the Rust crates
//    and npm packages as rows with their copyright lines, and each licence
//    text once (MIT, Apache-2.0, OFL-1.1 among them).
// 2. It scrolls from the keyboard at once (PageDown), and never sideways at
//    the 960 px minimum window width.
// 3. ⌘K "licenses" finds Third-party notices; Enter opens it; Esc closes.
// 4. Small text keeps 4.5:1 in light and dark (the link, a copyright line,
//    a licence text); Reduce Motion: the sheet has no animation.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/notices-browser-proof.mjs [outDir]   (ROWKERY_DEV_URL for another port)
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
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/notices";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri() {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.clear();
    localStorage.setItem("rowkery.windows", JSON.stringify({ windows: [{ connectionId: "pg", database: "wallet" }], active: 0 }));
    sessionStorage.setItem("seeded", "1");
  }
  const col = (name, type_name = "int8") => ({ name, type_name, nullable: false });
  const tables = [
    { name: "kiosks", kind: "table", columns: [col("id"), col("city", "text")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Exact: 3 }, partition_of: null },
  ];
  const conn = { kind: "postgres", id: "pg", name: "wallet-dev", host: "db.internal", port: 5432, database: "wallet", username: "app" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: [conn], active_connection_id: null };
        case "open_window":
          return { database: "wallet", catalog: { databases: [{ name: "wallet", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "list_databases":
          return [];
        case "browse_table_sql":
          return `SELECT * FROM ${args.table} LIMIT 1000`;
        default:
          return null;
      }
    },
  };
}

// Contrast of an element's text against the first opaque ground behind it
// (as paper-finish-browser-proof.mjs measures it).
function installContrast() {
  window.__contrast = (e) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [r, g, b, a];
      }
      const x = c.match(/color\(srgb ([^)]+)\)/);
      if (!x) return null;
      const [r, g, b, a = 1] = x[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [r * 255, g * 255, b * 255, a];
    };
    const layers = [];
    for (let n = e; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
    }
    let ground = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) ground = [r * a + ground[0] * (1 - a), g * a + ground[1] * (1 - a), b * a + ground[2] * (1 - a)];
    const [fr, fg, fb, fa] = parse(getComputedStyle(e).color);
    const fgc = [fr, fg, fb].map((v, i) => v * fa + ground[i] * (1 - fa));
    const lum = ([r, g, b]) => [r, g, b].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [l1, l2] = [lum(fgc), lum(ground)].sort((a, b) => b - a);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
}

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript({ path: FRAMES_SHIM });
await page.addInitScript(stubTauri);
await page.addInitScript(installContrast);
await page.goto(URL);
const ws = '[data-testid="workspace"]:not([hidden])';
await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
await page.waitForTimeout(300);

const notices = "[data-notices]";
const body = '[data-testid="tn-body"]';
const loaded = () => page.waitForSelector(`${body}[data-loaded]`);

// 1 · From the shortcut sheet's foot.
await page.keyboard.press("Control+Shift+Slash");
await page.waitForSelector("[data-shortcuts]");
check(!!(await page.$('[data-shortcuts] [data-testid="ks-notices"]')), "the shortcut sheet's foot has the notices link");
await page.screenshot({ path: `${OUT}/1-shortcuts-foot.png` });
await page.click('[data-testid="ks-notices"]');
await page.waitForSelector(notices);
await loaded();
await page.waitForSelector("[data-shortcuts]", { state: "detached" });
check(true, "the link closes the shortcut sheet and opens the notices");
check(await page.$eval(body, (e) => document.activeElement === e), "the notices' body has focus");
const text = await page.textContent(body);
check(/IBM Plex Sans/.test(text) && !/Source Serif/.test(text), "the fonts are listed (Plex only)");
check(/Reserved Font Name "Plex"/.test(text), "with its OFL copyright line");
for (const name of ["serde", "tokio", "tauri", "react", "react-dom", "@tanstack/react-virtual"]) {
  check(!!(await page.$(`${body} [data-package="${name}"]`)), `${name} has a row`);
}
const rows = await page.$$eval(`${body} [data-package]`, (els) => els.length);
check(rows > 300, `${rows} package rows`);
const heads = await page.$$eval(`${body} [data-licence]`, (els) => els.map((e) => e.dataset.licence));
check(["MIT", "Apache-2.0", "OFL-1.1"].every((h) => heads.includes(h)), `licence texts: ${heads.join(", ")}`);
check(new Set(heads).size === heads.length, "each licence text once");
check(/SIL OPEN FONT LICENSE Version 1\.1/.test(text) && /Apache License\s+Version 2\.0/.test(text), "the full texts are there");
await page.screenshot({ path: `${OUT}/2-notices-light.png` });

// 2 · Scrolls from the keyboard; never sideways.
const before = await page.$eval(body, (e) => e.scrollTop);
await page.keyboard.press("PageDown");
await page.waitForTimeout(250);
check((await page.$eval(body, (e) => e.scrollTop)) > before, "PageDown scrolls the notices");
await page.setViewportSize({ width: 960, height: 600 });
await page.waitForTimeout(100);
const fit = await page.$eval(body, (e) => ({ sw: e.scrollWidth, cw: e.clientWidth, right: e.closest("[data-notices]").getBoundingClientRect().right }));
check(fit.sw <= fit.cw && fit.right <= 960, `fits at 960 px (${fit.sw} ≤ ${fit.cw}, right ${fit.right})`);
await page.screenshot({ path: `${OUT}/3-notices-960.png` });
await page.setViewportSize({ width: 1280, height: 860 });
await page.keyboard.press("Escape");
await page.waitForSelector(notices, { state: "detached" });
check(true, "Esc closes the notices");

// 3 · ⌘K.
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.fill('[data-testid="cp-search"] input', "licenses");
await page.waitForTimeout(80);
check(!!(await page.$('[data-testid="cp-row"][data-item="cmd:third-party-notices"]')), "⌘K licenses finds Third-party notices");
await page.click('[data-testid="cp-row"][data-item="cmd:third-party-notices"]');
await page.waitForSelector(notices);
await loaded();
check(true, "picking it opens the notices");

// 4 · Contrast, both themes; Reduce Motion.
const ratios = () =>
  page.evaluate((b) => {
    const pick = (sel) => document.querySelector(sel);
    return {
      who: window.__contrast(pick(`${b} .tn-who`)),
      row: window.__contrast(pick(`${b} .tn-row > span:nth-child(2)`)),
      text: window.__contrast(pick(`${b} .tn-text`)),
      intro: window.__contrast(pick(`${b} .tn-p`)),
    };
  }, body);
// Class on purpose: the measured text runs carry no data attribute of their own.
const light = await ratios();
check(Object.values(light).every((r) => r >= 4.5), `light ≥ 4.5:1 ${JSON.stringify(light)}`);
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(250);
const dark = await ratios();
check(Object.values(dark).every((r) => r >= 4.5), `dark ≥ 4.5:1 ${JSON.stringify(dark)}`);
await page.screenshot({ path: `${OUT}/4-notices-dark.png` });
await page.keyboard.press("Escape");
await page.waitForSelector(notices, { state: "detached" });
await page.keyboard.press("Control+Shift+Slash");
await page.waitForSelector("[data-shortcuts]");
const link = await page.$eval('[data-testid="ks-notices"]', (e) => window.__contrast(e));
check(link >= 4.5, `dark: the link ${link}:1`);
await page.emulateMedia({ colorScheme: "light" });
await page.waitForTimeout(250);
const linkLight = await page.$eval('[data-testid="ks-notices"]', (e) => window.__contrast(e));
check(linkLight >= 4.5, `light: the link ${linkLight}:1`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForSelector("[data-shortcuts]", { state: "detached" });
await page.emulateMedia({ reducedMotion: "reduce" });
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.fill('[data-testid="cp-search"] input', "third-party");
await page.waitForTimeout(80);
await page.keyboard.press("Enter");
await page.waitForSelector(notices);
check((await page.$eval(notices, (e) => getComputedStyle(e).animationName)) === "none", "Reduce Motion: no sheet animation");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
await browser.close();
console.log(process.exitCode ? "some checks failed" : "all checks passed");
