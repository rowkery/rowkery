// Photographs the built site (out/) at a spread of window sizes and checks it: no sideways
// scroll; the nav, headline and hero buttons on screen; every image loaded; no text cut off
// or broken onto a second line; the checkpoint's stations, calls and stamps inside their card
// through a whole loop; the masked host whole; the looping animations running; blocks held
// back below the fold and rising in as they arrive; the speed bars waiting at zero, then
// growing to their timings. Then Reduce Motion (everything shown and still), no scripts
// (everything shown), a bundle that never loads (everything shown after 2.5 s), and the 404.
// Fails on any page error. Writes one contact sheet per size.
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
  ["agents", "#agents"],
  ["checkpoint", ".stage"],
  ["proposals", '[data-card="proposals"]'],
  ["tables", '[data-card="tables"]'],
  ["host", ".hm"],
  ["tools", "#tools"],
  ["sessions", '[data-card="sessions"]'],
  ["keys", "#keys"],
  ["speed", "#speed"],
  ["security", "#security"],
  ["exploring", "#exploring"],
  ["get", "#get"],
  ["foot", ".foot"],
];
// The CSS loops: the hero's toasts, the checkpoint's calls, stamps, returns, rings and rail.
const LOOPS = ["sc-out", "pass", "refuse", "vshow", "back", "pulse-ok", "pulse-no", "flow", "edge-ok", "edge-no"];

// Helpers shared with the page (stringified into it).
const HELPERS = `
  window.R = (e) => e.getBoundingClientRect();
  // The box of an element's text, not of the element (a label's block can be wider than its words).
  window.textBox = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); };
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
  // How visible an element is: its opacity times every ancestor's (a call fades with its lane).
  window.seen = (e) => { let o = 1; for (; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  // How much of a speed bar shows: it slides out of its track, which clips it.
  window.barWidth = (i) => { const t = R(i.parentElement), b = R(i); return Math.max(0, Math.min(b.right, t.right) - Math.max(b.left, t.left)); };
  window.within = (r, b, pad = 0.5) => r.left >= b.left - pad && r.right <= b.right + pad && r.top >= b.top - pad && r.bottom <= b.bottom + pad;
  window.label = (e) => (e.textContent || e.className).trim().replace(/\\s+/g, " ").slice(0, 40);
  // Holds every loop at one moment (in seconds since it began; past 12 every delay has run out).
  window.at = (t, loops) => { for (const a of document.getAnimations()) if (loops.includes(a.animationName)) { a.pause(); a.currentTime = t * 1000; } };
`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const problems = [];
const open = async (opts, tag) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${tag}: page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${tag}: console error: ${m.text()}`));
  await page.addInitScript(HELPERS);
  return { ctx, page };
};

for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const { ctx, page } = await open({ viewport: { width: w, height: h } }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1600);

  // Before any scrolling: the hero on screen, the loops running, what's below the fold held back.
  (
    await page.evaluate((LOOPS) => {
      const out = [];
      for (const sel of [".nav-in", ".h1", ".hero .btn.big"])
        for (const e of document.querySelectorAll(sel)) if (R(e).left < -0.5 || R(e).right > innerWidth + 0.5) out.push(`${sel} leaves the screen`);
      // A card off screen holds its loops (Reveal.tsx marks it data-off); those count as playing.
      const live = (a) => a.playState === "running" || !!a.effect?.target?.closest?.("[data-off]");
      const running = new Set(document.getAnimations().filter(live).map((a) => a.animationName));
      for (const n of LOOPS) if (!running.has(n)) out.push(`the ${n} animation isn't running`);
      if (!document.documentElement.classList.contains("js")) out.push("the page was never marked .js");
      const below = [...document.querySelectorAll(".reveal")].filter((e) => R(e).top > innerHeight);
      for (const e of below) if (getComputedStyle(e).opacity !== "0") out.push(`not held back below the fold: "${label(e)}"`);
      if (![...document.querySelectorAll(".trk i")].every((i) => barWidth(i) === 0)) out.push("the plan's bars grew before their card was in view");
      return out;
    }, LOOPS)
  ).forEach(bad);

  // The checkpoint through one whole loop, a frame every 0.2 s: the stations' labels and every
  // call, stamp and return that is showing stay inside the card. (Calls may pass behind the gate
  // and over each other; that is the drawing.)
  (
    await page.evaluate((LOOPS) => {
      const out = new Set();
      const card = document.querySelector(".stage").closest(".card");
      for (let t = 12; t < 24; t += 0.2) {
        at(t, LOOPS);
        const box = R(card);
        for (const b of document.querySelectorAll(".st b")) if (!within(textBox(b), box)) out.add(`checkpoint: "${label(b)}" is cut by its card`);
        for (const e of document.querySelectorAll(".pk, .vd, .rt"))
          if (seen(e) > 0.6 && !within(R(e), box)) out.add(`checkpoint: "${label(e)}" leaves its card at ${(t % 12).toFixed(1)} s`);
      }
      for (const a of document.getAnimations()) if (LOOPS.includes(a.animationName)) a.play();
      return [...out];
    }, LOOPS)
  ).forEach(bad);

  // Read down the page as a person would, so every block arrives in view.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += h / 3) {
    await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), y);
    await page.waitForTimeout(120);
  }

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
      const shown = (e) => e.getClientRects().length > 0;
      const sw = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      if (sw > 0) out.push(`page scrolls sideways by ${sw}px`);
      for (const img of document.images) if (!img.complete || !img.naturalWidth) out.push(`image didn't load: ${img.currentSrc || img.src}`);
      for (const e of document.querySelectorAll(".reveal")) if (!e.classList.contains("in")) out.push(`never rose in: "${label(e)}"`);
      // Text cut off (code samples in the toasts and calls end in an ellipsis by design).
      for (const e of document.querySelectorAll(".btn, .pill, .h1, .h2, .card h3, .meta, .st b, .keys li, .rr > span, .toast .hd, .foot-in > span, .row > span, .rows-hd > span, .timed li"))
        if (shown(e) && e.scrollWidth > e.clientWidth + 1) out.push(`text cut off: "${label(e)}"`);
      // Text that must stay on one line.
      for (const e of document.querySelectorAll(".btn, .pill, .st b, .hm-host em, .toast .res, .rv, .meta, .keys kbd, .row > span, .rows-hd > span"))
        if (shown(e) && lines(e) > 1) out.push(`breaks onto two lines: "${label(e)}"`);
      // Things that must sit whole inside their card.
      for (const e of document.querySelectorAll(".frag, .hm-host, .keys li, .speed, .st .box, .rows, .row > span, .timed"))
        if (!within(R(e), R(e.closest(".card")))) out.push(`leaves its card: "${label(e)}"`);
      // The command and its copy button sit whole inside their box.
      for (const e of document.querySelectorAll(".cmd .copy")) if (!within(R(e), R(e.closest(".cmd")))) out.push("the copy button leaves the command");
      const host = document.querySelector(".hm-host");
      if (host.scrollWidth > host.clientWidth + 1) out.push("the masked host is cut off");
      // Each bar (the plan's steps) grew to its length (held mid-loop: they grow again every 8 s).
      for (const a of document.getAnimations()) if (a.animationName === "grow-loop") { a.pause(); a.currentTime = 4000; }
      for (const i of document.querySelectorAll(".trk i")) {
        const want = (R(i.parentElement).width * parseFloat(i.style.width)) / 100;
        if (Math.abs(barWidth(i) - want) > 1) out.push(`a speed bar is ${Math.round(barWidth(i))}px, not ${Math.round(want)}px`);
      }
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

// Reduce Motion: nothing moves, every block shows before any scrolling, one toast, two calls
// held either side of the gate, the bars at their timings.
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const tag = `reduced motion ${w}x${h}`;
  const { ctx, page } = await open({ viewport: { width: w, height: h }, reducedMotion: "reduce" }, tag);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  (
    await page.evaluate(() => {
      const out = [];
      const moving = document.getAnimations().filter((a) => a.playState === "running");
      if (moving.length) out.push(`${moving.length} animations still run`);
      const op = (s) => String(seen(document.querySelector(s)));
      for (const e of document.querySelectorAll(".reveal")) if (getComputedStyle(e).opacity !== "1") out.push(`hidden: "${label(e)}"`);
      if (op(".toast") !== "1") out.push("the first toast is hidden");
      for (const s of [".lane.a .pk", ".lane.b .pk", ".lane.a .vd", ".lane.b .vd"]) if (op(s) !== "1") out.push(`${s} is hidden`);
      for (const s of [".lane.c", ".lane.d", ".lane.back"]) if (getComputedStyle(document.querySelector(s)).display !== "none") out.push(`${s} shows`);
      for (const i of document.querySelectorAll(".trk i")) if (Math.abs(barWidth(i) - (R(i.parentElement).width * parseFloat(i.style.width)) / 100) > 1) out.push("a speed bar isn't at its timing");
      return out;
    })
  ).forEach((s) => problems.push(`${tag}: ${s}`));
  await page.screenshot({ path: `${OUT}/reduced-${w}x${h}.png`, fullPage: true });
  await ctx.close();
}

// Without scripts, and with a bundle that never arrives: every block simply shows.
for (const [tag, opts, block] of [["no scripts", { javaScriptEnabled: false }, false], ["no bundle", {}, true]]) {
  const { ctx, page } = await open({ viewport: { width: 1280, height: 800 }, ...opts }, tag);
  if (block) await page.route((u) => u.pathname.startsWith("/_next/") && u.pathname.endsWith(".js"), (r) => r.abort());
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(block ? 3800 : 500);
  const hidden = await page.evaluate(() => [...document.querySelectorAll(".reveal")].filter((e) => getComputedStyle(e).opacity !== "1").map((e) => e.textContent.trim().slice(0, 40)));
  if (hidden.length) problems.push(`${tag}: ${hidden.length} blocks hidden, first "${hidden[0]}"`);
  await ctx.close();
}
// The bundle's own requests fail on purpose in that run; only page errors count there.
for (let i = problems.length - 1; i >= 0; i--) if (problems[i].startsWith("no bundle: console error")) problems.splice(i, 1);

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
