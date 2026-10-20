// Photographs the built site (out/) at a spread of window sizes and checks it: no sideways
// scroll; the nav, headline and hero buttons on screen; every image loaded; no text cut off or
// broken onto a second line where it must stay on one; the penguins that peek over cards
// standing clear of the text above them; the looping animations running. Then Reduce Motion
// (nothing moves, one line in the bubble, the typed SQL whole, every check showing), no scripts
// (every section and the first agent step showing), and the 404. Fails on any page error. Writes one contact sheet per
// size.
//
//   npm run build && node scripts/resolution-check.mjs [outDir]
//
// Env: SIZES='[[1440,900]]' to narrow the run.
// Needs Playwright (npx playwright, or the global install in cloud containers).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-web-check";
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [[360, 780], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const server = await serveOut();
const url = server.url;

// What to photograph: a selector, scrolled to sit just under the nav.
const VIEWS = [
  ["hero", "main"],
  ["stats", ".stats"],
  ["agents", "#agents"],
  ["security", "#security"],
  ["keys", "#keys"],
  ["databases", "#databases"],
  ["faq", "#faq"],
  ["get", "#get"],
  ["rookery", ".rookery"],
  ["foot", "footer"],
];
// Loops that should be playing as the page opens (the hero penguin's lines and hops, the
// ticker, the walkers, the ice slide, the wires, the igloo, the hearts, the snow).
const LOOPS = ["say", "hop", "tick", "walk", "waddle", "zoom", "travel", "igloo", "heart", "fall"];

// Helpers shared with the page (stringified into it).
const HELPERS = `
  window.R = (e) => e.getBoundingClientRect();
  // How many lines an element's text takes (tops more than 4 px apart).
  window.lines = (e) => {
    const tops = [], walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const c of r.getClientRects()) if (c.width > 0) tops.push(c.top);
    }
    return tops.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length;
  };
  // The box of an element's text, not of the element (a heading's block runs the full width).
  window.textBox = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); };
  window.overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  window.label = (e) => (e.textContent || e.className.baseVal || e.className).trim().replace(/\\s+/g, " ").slice(0, 40);
`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const open = async (opts, tag) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${tag}: page error: ${e.message}`));
  await page.addInitScript(HELPERS);
  return { ctx, page };
};

for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const { ctx, page } = await open({ viewport: { width: w, height: h } }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2600);

  (
    await page.evaluate((LOOPS) => {
      const out = [];
      for (const sel of [".nav-in", ".h1", ".hero .btn", ".connect .card"])
        for (const e of document.querySelectorAll(sel)) if (R(e).left < -0.5 || R(e).right > innerWidth + 0.5) out.push(`${sel} leaves the screen`);
      const running = new Set(document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName));
      for (const n of LOOPS) if (!running.has(n)) out.push(`the ${n} animation isn't running`);
      // Every line of the hero's bubble clears the line above the card.
      for (const b of document.querySelectorAll(".bubble"))
        if (overlap(R(b), textBox(document.querySelector(".trust")))) out.push(`the penguin's bubble covers the line under the buttons: "${label(b)}"`);
      return out;
    }, LOOPS)
  ).forEach(bad);

  const shots = [];
  for (const [name, sel] of VIEWS) {
    await page.evaluate((sel) => {
      const nav = document.querySelector(".nav").offsetHeight;
      scrollTo({ top: Math.max(0, R(document.querySelector(sel)).top + scrollY - nav - 12), behavior: "instant" });
    }, sel);
    await page.waitForTimeout(1100);
    const file = `${OUT}/${tag}-${name}.png`;
    await page.screenshot({ path: file });
    shots.push([name, file]);
  }

  (
    await page.evaluate(() => {
      const out = [];
      const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const sw = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      if (sw > 0) out.push(`page scrolls sideways by ${sw}px`);
      for (const img of document.images) if (!img.complete || !img.naturalWidth) out.push(`image didn't load: ${img.currentSrc || img.src}`);
      // Text cut off (the masked stand-ins end in an ellipsis on a phone by design).
      for (const e of document.querySelectorAll(".btn, .badge, .h1 .ln, .h2, h3, .tab, .stat, .flag, .chord, .eng, .foot a"))
        if (shown(e) && e.scrollWidth > e.clientWidth + 1) out.push(`text cut off: "${label(e)}"`);
      // Text that must stay on one line.
      for (const e of document.querySelectorAll(".btn, .badge, .tab, .flag code, .chord kbd, .now .eng, .lane span, .rec, .copy"))
        if (shown(e) && lines(e) > 1) out.push(`breaks onto two lines: "${label(e)}"`);
      // A penguin peeking over a card sits clear of the heading above it.
      for (const pg of document.querySelectorAll(".get .peek2, .follow .peek2"))
        for (const t of document.querySelectorAll("#get .h2, .get h3, .get p, .follow h3, .follow p")) if (overlap(R(pg), textBox(t))) out.push(`a penguin over a card covers "${label(t)}"`);
      return out;
    })
  ).forEach(bad);

  const sheet = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const imgs = await Promise.all(shots.map(async ([n, f]) => [n, (await readFile(f)).toString("base64")]));
  await sheet.setContent(`<body style="margin:0;background:#888;font:14px sans-serif"><h2 style="margin:8px">${tag}</h2><div style="display:grid;grid-template-columns:repeat(${w < 800 ? 5 : 4},1fr);gap:8px;padding:8px">${imgs.map(([n, b]) => `<figure style="margin:0"><img src="data:image/png;base64,${b}" style="width:100%;display:block;outline:1px solid #333"><figcaption>${n}</figcaption></figure>`).join("")}</div></body>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${tag}.png`, fullPage: true });
  await sheet.close();
  await ctx.close();
  console.log(`${tag} done`);
}

// Reduce Motion: nothing moves; the penguin says one line; the typed SQL is whole and every
// check is showing.
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const tag = `reduced motion ${w}x${h}`;
  const { ctx, page } = await open({ viewport: { width: w, height: h }, reducedMotion: "reduce" }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  (
    await page.evaluate(() => {
      const out = [];
      const moving = document.getAnimations().filter((a) => a.playState === "running");
      if (moving.length) out.push(`${moving.length} animations still run, first ${moving[0].animationName}`);
      const typing = document.querySelector(".typing");
      if (typing.scrollWidth > typing.clientWidth + 1) out.push("the agent's SQL is cut off");
      for (const ok of document.querySelectorAll(".check .ok")) if (getComputedStyle(ok).opacity !== "1") out.push("a check result is hidden");
      const lines = [...document.querySelectorAll(".bubble")].filter((b) => getComputedStyle(b).opacity === "1");
      if (lines.length !== 1) out.push(`${lines.length} of the penguin's lines show, not one`);
      for (const s of [".walker", ".slider", ".snow"]) if ([...document.querySelectorAll(s)].some((e) => e.getClientRects().length)) out.push(`${s} shows`);
      return out;
    })
  ).forEach((s) => problems.push(`${tag}: ${s}`));
  await page.screenshot({ path: `${OUT}/reduced-${w}x${h}.png`, fullPage: true });
  await ctx.close();
}

// Without scripts: every section and the first agent step show.
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false }, "no scripts");
  await page.goto(url, { waitUntil: "load" });
  const missing = await page.evaluate(() =>
    ["#agents", "#security", "#keys", "#databases", "#faq", "#get", ".rookery", "footer"].filter((s) => !document.querySelector(s)?.getClientRects().length),
  );
  if (missing.length) problems.push(`no scripts: missing ${missing.join(", ")}`);
  if ((await page.locator(".panel.on").count()) !== 1) problems.push("no scripts: the agent scene shows no step");
  await ctx.close();
}

// The 404: the tilted penguin and the way home.
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 } }, "404");
  await page.goto(`${url}404.html`, { waitUntil: "networkidle" });
  const ok = await page.evaluate(() => document.querySelector("[data-not-found] h1")?.textContent === "Nothing at this address" && R(document.querySelector("[data-not-found] svg")).width > 100);
  if (!ok) problems.push("404: the page is missing its penguin or headline");
  await page.screenshot({ path: `${OUT}/404.png` });
  await ctx.close();
}

await browser.close();
server.close();
await writeFile(`${OUT}/problems.txt`, problems.join("\n") + "\n");
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : "No problems found");
process.exitCode = problems.length ? 1 : 0;
