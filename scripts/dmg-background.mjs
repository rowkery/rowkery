#!/usr/bin/env node
// Renders apps/rowkery-tauri/brand/dmg-background.svg to the PNG scripts/dmg.sh
// hands the bundler: dmg-background.png, 660 × 400 (Finder draws a DMG
// background one pixel per point, and the bundler takes png/jpg/gif only, so
// there is no @2x). Re-run after editing the SVG and commit the PNG.
//
//   node scripts/dmg-background.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const brand = new URL("../apps/rowkery-tauri/brand/", import.meta.url).pathname;
const svg = readFileSync(`${brand}dmg-background.svg`, "utf8");
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 660, height: 400 }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style>${svg}`);
await page.screenshot({ path: `${brand}dmg-background.png` });
console.log(`wrote ${brand}dmg-background.png`);
await browser.close();
