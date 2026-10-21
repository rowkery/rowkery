// Photographs the built site (out/) at a spread of window sizes and checks it: no sideways
// scroll; the nav, the hero's title and buttons on screen; no text cut off or broken onto a
// second line where it must stay on one; the hero's job cycle running. Then Reduce Motion
// (nothing moves or pins, every scene a plain stack with each step's result showing: the typed
// SQL whole, every check, the stand-ins, every caption), no scripts (every section and caption
// in reading order) and the 404. Fails on any page error. Writes one contact sheet per size.
// The story's own moments are scripts/story-proof.mjs; the penguins, scripts/penguin-proof.mjs.
//
//   npm run build && node scripts/resolution-check.mjs [outDir]
//
// Env: SIZES='[[1440,900]]' to narrow the run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";
import { MOMENTS, goTo } from "./story.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-web-check";
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [[360, 780], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const VIEWS = ["hero", "agent-asks", "agent-checks", "agent-hidden", "security-stand-in", "keys-review", "open-source", "get", "end"].map((n) => MOMENTS.find((m) => m.name === n));
const server = await serveOut();
const url = server.url;

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
  window.shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  window.label = (e) => (e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
`;
// What the page's own chrome must never cut, and never wrap (the little app windows are drawings and may clip).
const CUT = ".btn, .tabs .tab, .copy, .brand, .fcard b, .discs button";
const ONE_LINE = `${CUT}, .h-title .ht, .job`;

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
  const phone = w < 600;
  const { ctx, page } = await open({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2600);

  (
    await page.evaluate(() => {
      const out = [];
      for (const sel of [".nav", "#hero .h-title", ".hero .btn"])
        for (const e of document.querySelectorAll(sel)) if (R(e).left < -0.5 || R(e).right > innerWidth + 0.5 || R(e).bottom > innerHeight) out.push(`${sel} leaves the screen`);
      const running = new Set(document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName));
      for (const n of ["job", "hopc", "cue"]) if (!running.has(n) && !(n === "cue" && innerWidth <= 860)) out.push(`the ${n} animation isn't running`);
      return out;
    })
  ).forEach(bad);

  const shots = [];
  for (const m of VIEWS) {
    await goTo(page, m, 1300);
    const file = `${OUT}/${tag}-${m.name}.png`;
    await page.screenshot({ path: file });
    shots.push([m.name, file]);
    (
      await page.evaluate(([CUT, ONE_LINE]) => {
        const out = [];
        const sw = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        if (sw > 0) out.push(`page scrolls sideways by ${sw}px`);
        for (const e of document.querySelectorAll(CUT)) if (shown(e) && e.scrollWidth > e.clientWidth + 1) out.push(`text cut off: "${label(e)}"`);
        for (const e of document.querySelectorAll(ONE_LINE)) if (shown(e) && lines(e) > 1) out.push(`breaks onto two lines: "${label(e)}"`);
        // Every piece a scene shows is on screen: the window, the cards lifting out of it, the keys.
        for (const e of document.querySelectorAll(".stage .lift, .stage .key")) {
          if (!shown(e) || Number(getComputedStyle(e).opacity) < 0.9 || getComputedStyle(e.closest(".lift")).opacity < 0.9) continue;
          const r = R(e);
          if (r.bottom < 0 || r.top > innerHeight) continue;
          if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(`"${label(e) || e.className}" runs off the side of the screen`);
        }
        return out;
      }, [CUT, ONE_LINE])
    ).forEach((s) => bad(`${m.name}: ${s}`));
  }

  const sheet = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const imgs = await Promise.all(shots.map(async ([n, f]) => [n, (await readFile(f)).toString("base64")]));
  await sheet.setContent(`<body style="margin:0;background:#888;font:14px sans-serif"><h2 style="margin:8px">${tag}</h2><div style="display:grid;grid-template-columns:repeat(${w < 800 ? 7 : 4},1fr);gap:8px;padding:8px">${imgs.map(([n, b]) => `<figure style="margin:0"><img src="data:image/png;base64,${b}" style="width:100%;display:block;outline:1px solid #333"><figcaption>${n}</figcaption></figure>`).join("")}</div></body>`);
  await sheet.screenshot({ path: `${OUT}/sheet-${tag}.png`, fullPage: true });
  await sheet.close();
  await ctx.close();
  console.log(`${tag} done`);
}

// Each scene as a plain stack with every step's result: what Reduce Motion and no scripts both show.
const STACK = () => {
  const out = [];
  if (document.documentElement.hasAttribute("data-motion")) out.push("the page still asked for motion");
  for (const s of document.querySelectorAll(".scene")) {
    if (getComputedStyle(s.querySelector(".stage")).position === "sticky") out.push(`#${s.id} still pins`);
    for (const c of s.querySelectorAll(".cap, .title, .big, .fcard")) if (!shown(c) || Number(getComputedStyle(c).opacity) < 1) out.push(`#${s.id}: "${label(c)}" is hidden`);
  }
  const sql = document.querySelector(".a-sql").textContent;
  if (!sql.endsWith("interval '7 days';")) out.push(`the agent's SQL isn't whole: ${sql.slice(-30)}`);
  for (const ok of document.querySelectorAll(".check .ok")) if (getComputedStyle(ok).opacity !== "1") out.push("a check result is hidden");
  for (const v of document.querySelectorAll(".cc, [data-sec]")) if (!/^masked:|\*\*\*|not shared/.test(v.textContent)) out.push(`a stand-in shows its real value: ${v.textContent}`);
  for (const p of document.querySelectorAll(".a-review, .k-win .panel")) if (!shown(p)) out.push("a step's panel is hidden");
  // The words in reading order: each scene's title before its captions, the scenes in story order.
  const order = ["#hero h1", "#agent .title", "#agent .caps", "#security .title", "#keys .title", "#free .big", "#get h2", "#connect", "[data-follow]", "footer"].map((s) => R(document.querySelector(s)).top);
  if (order.some((t, i) => i && t <= order[i - 1])) out.push("the sections don't read in order");
  return out;
};

// Reduce Motion: nothing moves, nothing pins; the penguin keeps one job.
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const tag = `reduced motion ${w}x${h}`;
  const { ctx, page } = await open({ viewport: { width: w, height: h }, reducedMotion: "reduce" }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running");
    if (moving.length) out.push(`${moving.length} animations still run, first ${moving[0].animationName}`);
    const jobs = [...document.querySelectorAll(".job")].filter((j) => getComputedStyle(j).opacity === "1");
    if (jobs.length !== 1) out.push(`${jobs.length} of the penguin's jobs show, not one`);
    if (getComputedStyle(document.querySelector(".hpg")).transform !== "none") out.push("the hero penguin flew");
    return out;
  });
  [...(await page.evaluate(STACK)), ...still].forEach((s) => problems.push(`${tag}: ${s}`));
  await page.screenshot({ path: `${OUT}/reduced-${w}x${h}.png`, fullPage: true });
  await ctx.close();
}

// Without scripts: the same stack, every word there.
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const tag = `no scripts ${w}x${h}`;
  const { ctx, page } = await open({ viewport: { width: w, height: h }, javaScriptEnabled: false }, tag);
  await page.goto(url, { waitUntil: "load" });
  (await page.evaluate(STACK)).forEach((s) => problems.push(`${tag}: ${s}`));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sw > 0) problems.push(`${tag}: page scrolls sideways by ${sw}px`);
  await page.screenshot({ path: `${OUT}/no-scripts-${w}x${h}.png`, fullPage: true });
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
