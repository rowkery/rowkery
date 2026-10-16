// Checks the coming-soon build (out/ after `ROWKERY_COMING_SOON=1 npm run build`): nothing
// of the real site in it (no screens, no section copy, no site stylesheet), the page served
// at / and as the 404; at each window size no sideways scroll, the mark, name, headline and
// line all on screen, the headline on one line, the copy clear of the table's horizon, the
// table rolling (and still under Reduce Motion). Photographs each size at three moments.
// Built with ROWKERY_PREVIEW_KEY too (pass the same key), it also checks that the real site
// is at /<key>/ and nowhere else, that the key is nowhere outside that folder, that `?key=`
// opens it and a wrong key lands on the coming-soon page. Fails on any page error.
//
//   ROWKERY_COMING_SOON=1 npm run build && node scripts/coming-soon-check.mjs [outDir]
//   ROWKERY_COMING_SOON=1 ROWKERY_PREVIEW_KEY=k npm run build && ROWKERY_PREVIEW_KEY=k node scripts/coming-soon-check.mjs
//
// Env: SIZES='[[1440,900]]' to narrow the run. Needs Playwright (local or the global install).
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-soon-check";
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [[360, 780], [390, 844], [768, 1024], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const ROOT = new URL("../out/", import.meta.url).pathname;
const KEY = process.env.ROWKERY_PREVIEW_KEY ?? "";
// Words that are only in the real page's copy (not its class names: with a key, its
// stylesheet and scripts sit under _next/ by hash like its pictures).
const SITE_WORDS = ["Query it yourself", "Meet", "Postgres", "SQLite", "your agent", "Download"];

const problems = [];
const bad = (s) => problems.push(s);
await mkdir(OUT, { recursive: true });

// 1. The build itself.
async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) out.push(...(e.isDirectory() ? await files(join(dir, e.name)) : [join(dir, e.name)]));
  return out;
}
// With a key, the real site's own files sit under out/<key>/ (its pictures under _next, by hash).
const all = (await files(ROOT)).filter((f) => !KEY || !f.startsWith(join(ROOT, KEY)));
if (!KEY) for (const f of all) if (/\.(webp|png|jpe?g|avif)$/.test(f)) bad(`a picture in the build: ${f.slice(ROOT.length)}`);
for (const f of all.filter((f) => /\.(html|txt|js|css)$/.test(f))) {
  const text = await readFile(f, "utf8");
  for (const w of SITE_WORDS) if (text.includes(w)) bad(`"${w}" in ${f.slice(ROOT.length)}`);
  if (KEY && text.includes(KEY)) bad(`the key is in ${f.slice(ROOT.length)}`);
}
if (KEY) {
  const site = await readFile(join(ROOT, KEY, "index.html"), "utf8").catch(() => "");
  if (!site.includes("Query it yourself")) bad(`the real site is not at /${KEY}/`);
}
for (const f of ["index.html", "404.html"]) {
  const text = await readFile(join(ROOT, f), "utf8");
  if (!text.includes("Coming soon") || !text.includes("data-coming-soon")) bad(`${f} is not the coming-soon page`);
}

// 2. The page in a browser.
const server = await serveOut();
const browser = await chromium.launch();
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(server.url, { waitUntil: "networkidle" });
  for (const [i, t] of [600, 4000, 9000].entries()) {
    await page.waitForTimeout(i === 0 ? t : t - [600, 4000, 9000][i - 1]);
    await page.screenshot({ path: join(OUT, `${w}x${h}-${t / 1000}s.png`) });
  }
  const r = await page.evaluate(() => {
    const R = (s) => document.querySelector(s).getBoundingClientRect();
    const h1 = document.querySelector(".soon h1");
    const range = document.createRange();
    range.selectNodeContents(h1);
    const lines = [...range.getClientRects()].map((c) => Math.round(c.top)).filter((t, i, a) => i === 0 || t - a[i - 1] > 4).length;
    const roll = document.getAnimations().find((a) => a.animationName === "roll");
    return {
      scrollW: document.documentElement.scrollWidth,
      brand: R(".soon-brand"), h1: R(".soon h1"), p: R(".soon p"), floor: R(".floor"),
      lines, rolling: !!roll && roll.playState === "running",
      rows: document.querySelectorAll(".row").length,
    };
  });
  const on = (b, name) => (b.top < 0 || b.bottom > h || b.left < 0 || b.right > w) && bad(`${w}x${h}: ${name} is off screen (${Math.round(b.top)}..${Math.round(b.bottom)})`);
  if (r.scrollW > w) bad(`${w}x${h}: sideways scroll (${r.scrollW} > ${w})`);
  on(r.brand, "the mark and name");
  on(r.h1, "the headline");
  on(r.p, "the line");
  if (r.lines !== 1) bad(`${w}x${h}: the headline takes ${r.lines} lines`);
  if (r.p.bottom > r.floor.top + r.floor.height * 0.22) bad(`${w}x${h}: the line sits over the table's horizon (${Math.round(r.p.bottom)} > ${Math.round(r.floor.top + r.floor.height * 0.22)})`);
  if (!r.rolling) bad(`${w}x${h}: the table is not rolling`);
  if (r.rows !== 40) bad(`${w}x${h}: ${r.rows} rows, not 40`);
  for (const e of errors) bad(`${w}x${h}: page error: ${e}`);
  await ctx.close();
  console.log(`${w}x${h} done`);
}

// 3. Reduce Motion, and the 404.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(server.url, { waitUntil: "networkidle" });
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName));
  if (anims.length) bad(`Reduce Motion: still animating: ${anims.join(", ")}`);
  const seen = await page.evaluate(() => [".soon-brand", ".soon h1", ".soon p"].map((s) => getComputedStyle(document.querySelector(s)).opacity));
  if (seen.some((o) => o !== "1")) bad(`Reduce Motion: copy not shown (${seen.join(", ")})`);
  await page.screenshot({ path: join(OUT, "reduce-motion.png") });
  const res = await page.goto(`${server.url}anything/else/`, { waitUntil: "networkidle" });
  if (res.status() !== 200 && res.status() !== 404) bad(`unknown address: status ${res.status()}`);
  if (!(await page.$("[data-coming-soon]"))) bad("an unknown address does not show the page");
  await ctx.close();
}

// 4. The key.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${server.url}?key=${"x".repeat(24)}`, { waitUntil: "networkidle" });
  if (!(await page.$("[data-coming-soon]"))) bad("a wrong key does not land on the page");
  await page.goto(`${server.url}?key=..%2F..%2Fevil`, { waitUntil: "networkidle" });
  if (!page.url().startsWith(server.url) || !(await page.$("[data-coming-soon]"))) bad(`a key that isn't one went to ${page.url()}`);
  if (KEY) {
    await page.goto(`${server.url}?key=${KEY}`, { waitUntil: "networkidle" });
    if (page.url() !== `${server.url}${KEY}/`) bad(`?key= went to ${page.url()}`);
    if (!(await page.$(".hero"))) bad("the key does not open the real site");
    await page.screenshot({ path: join(OUT, "with-key.png") });
  }
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log("No problems found");
