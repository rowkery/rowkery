// Photographs the built site (out/) at a spread of window sizes and checks it: no sideways
// scroll; the floating bar on screen and inside the window; the title on at most two lines (three
// on a phone) and no button or agent name broken onto a second line; every block shown once
// scrolled to; How it works playing its steps (the chat lines in, the pager filling, the next
// step's clip playing, its bar following); the looping clips playing on screen and stopping off
// it. Then Reduce Motion (nothing hidden or moving by itself: the chat whole, every bar full, the
// clips on their posters with controls), no scripts (every block and chat line showing) and the
// 404. Fails on any page error. Writes one full-page photo per size.
//
//   npm run build && node scripts/resolution-check.mjs [outDir]
//
// Env: SIZES='[[1440,900]]' to narrow the run.
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-web-check";
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [[360, 780], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const server = await serveOut();
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

/** How many lines an element's text takes (text tops more than 4 px apart). */
const lines = (page, sel) =>
  page.$$eval(sel, (els) =>
    els.map((e) => {
      const tops = [];
      const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) if (b.width && !tops.some((t) => Math.abs(t - b.top) < 4)) tops.push(b.top);
      }
      return { text: e.textContent.trim().slice(0, 40), lines: tops.length };
    }),
  );

async function open(w, h, opts = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ...opts });
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(`${w}x${h}`, `page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return { context, page };
}

/** Scrolls through the page so every block rises in, then back to the top. */
async function scrollThrough(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 400) {
    await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), y);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(900);
}

for (const [w, h] of SIZES) {
  const where = `${w}x${h}`;
  const { context, page } = await open(w, h);

  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (wide > 0) fail(where, `the page scrolls sideways by ${wide} px`);
  const bar = await page.$eval(".nav .bar", (e) => e.getBoundingClientRect().toJSON());
  if (bar.left < 0 || bar.right > w || bar.top < 0) fail(where, "the floating bar runs off the window");
  const [title] = await lines(page, "h1");
  if (title.lines > (w < 600 ? 3 : 2)) fail(where, `the title takes ${title.lines} lines`);
  for (const l of await lines(page, ".btn, .chip, .pill, .cap b")) if (l.lines > 1) fail(where, `"${l.text}" breaks onto ${l.lines} lines`);

  // How it works: the chat plays, then the next step's clip plays with its bar following.
  await page.evaluate(() => document.querySelector("[data-stage]").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(3600);
  const chat = await page.$$eval("[data-at]", (els) => els.filter((e) => getComputedStyle(e).display !== "none" && !e.classList.contains("in")).length);
  if (chat) fail(where, `${chat} chat lines still hidden 3.6 s into the first step`);
  await page.click("[data-dot]:nth-child(2)");
  await page.waitForTimeout(2500);
  const step = await page.evaluate(() => {
    const v = document.querySelectorAll("[data-slide]")[1].querySelector("video");
    const bar = document.querySelectorAll("[data-dot] i")[1];
    const fill = new DOMMatrix(getComputedStyle(bar).transform).a;
    return { on: document.querySelectorAll("[data-slide]")[1].classList.contains("on"), playing: !v.paused && v.currentTime > 0.5, fill, t: v.currentTime / v.duration };
  });
  if (!step.on) fail(where, "picking the second step doesn't show it");
  if (!step.playing) fail(where, "the second step's clip isn't playing");
  else if (Math.abs(step.fill - step.t) > 0.15) fail(where, `the pager bar (${step.fill.toFixed(2)}) doesn't follow the clip (${step.t.toFixed(2)})`);

  // The looping clips play on screen and stop off it.
  await page.evaluate(() => document.querySelector(".duo").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(1500);
  const looping = await page.$$eval(".duo video", (vs) => vs.map((v) => !v.paused && v.currentTime > 0));
  if (looping.some((p) => !p)) fail(where, "a keyboard clip isn't playing on screen");
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);
  const stopped = await page.$$eval(".duo video", (vs) => vs.every((v) => v.paused));
  if (!stopped) fail(where, "a keyboard clip keeps playing off screen");

  await scrollThrough(page);
  const hidden = await page.$$eval(".rv", (els) => els.filter((e) => getComputedStyle(e).opacity !== "1").length);
  if (hidden) fail(where, `${hidden} blocks still hidden after scrolling past them`);
  await page.screenshot({ path: `${OUT}/${where}.png`, fullPage: true });
  await context.close();
}

// Reduce Motion: nothing hidden, nothing playing by itself.
{
  const { context, page } = await open(1440, 900, { reducedMotion: "reduce" });
  await page.evaluate(() => document.querySelector("[data-stage]").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    js: document.documentElement.hasAttribute("data-js"),
    hidden: [...document.querySelectorAll(".rv, [data-at]")].filter((e) => getComputedStyle(e).opacity !== "1").length,
    playing: [...document.querySelectorAll("video")].filter((v) => !v.paused).length,
    controls: [...document.querySelectorAll("video")].every((v) => v.controls),
    bars: [...document.querySelectorAll("[data-dot] i")].every((b) => new DOMMatrix(getComputedStyle(b).transform).a === 1),
  }));
  if (r.js || r.hidden) fail("reduce motion", `${r.hidden} blocks or chat lines hidden`);
  if (r.playing) fail("reduce motion", `${r.playing} clips play by themselves`);
  if (!r.controls) fail("reduce motion", "a clip has no controls");
  if (!r.bars) fail("reduce motion", "the pager bars aren't full");
  await context.close();
}

// No scripts: every block and chat line shows.
{
  const { context, page } = await open(1440, 900, { javaScriptEnabled: false });
  const hidden = await page.$$eval(".rv, [data-at], .slide.on", (els) => els.filter((e) => getComputedStyle(e).opacity !== "1").length);
  if (hidden) fail("no scripts", `${hidden} blocks or chat lines hidden`);
  await context.close();
}

// The 404.
{
  const { context, page } = await open(1440, 900);
  await page.goto(`${server.url}no-such-page/`);
  if (!(await page.$("[data-not-found] h1"))) fail("404", "no 404 page");
  await context.close();
}

await browser.close();
server.close();
for (const p of problems) console.error(p);
console.log(problems.length ? `${problems.length} problems` : `All ${SIZES.length} sizes, Reduce Motion, no scripts and the 404 look right. Photos in ${OUT}`);
process.exit(problems.length ? 1 : 0);
