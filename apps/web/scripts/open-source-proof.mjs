// Proves the open-source page (feat/web-open-source) on the built site in out/, at 1440x900
// and 390x844: the USP cards in the chosen order (local read-only, Commit and sensitive
// columns with an agent, then plans, safe mode and sessions; 2026-10-16: agent first); no millisecond figures left on the page; the Exploring
// section with its Discussions link; GitHub in the nav and footer; and in the closing section,
// Download first, then the unquarantine command with a working copy button, Build from source,
// and the sponsor note with its Sponsor link. Writes a full-page PNG and one of the closing
// section per size.
//
//   npm run build && node scripts/open-source-proof.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-open-source";
const REPO = "https://github.com/rowkery/rowkery";
const ORDER = ["#agents .mascot", '[data-card="proposals"]', '[data-card="sensitive"]', '[data-card="plan"]', '[data-card="safe"]', '[data-card="sessions"]'];

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${tag}: page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  const out = await page.evaluate(
    ({ ORDER, REPO }) => {
      const bad = [];
      const tops = ORDER.map((s) => document.querySelector(s)?.getBoundingClientRect().top ?? NaN);
      if (tops.some(Number.isNaN)) bad.push(`a USP card is missing: ${ORDER.filter((_, i) => Number.isNaN(tops[i])).join(", ")}`);
      // Cards in one row share a top; the next USP is never above the one before it.
      for (let i = 1; i < tops.length; i++) if (tops[i] < tops[i - 1] - 0.5) bad.push(`${ORDER[i]} comes before ${ORDER[i - 1]}`);
      const text = document.querySelector("main").innerText;
      if (/\b\d+\s?ms\b/.test(text)) bad.push(`a millisecond figure is still on the page: "${text.match(/.{0,30}\b\d+\s?ms\b/)[0]}"`);
      const links = [...document.querySelectorAll("a")].map((a) => a.href);
      for (const want of [REPO + "/discussions", REPO + "#build-from-source", "https://github.com/sponsors/rowkery"])
        if (!links.includes(want)) bad.push(`no link to ${want}`);
      if (!document.querySelector(`.nav a[href="${REPO}"]`)) bad.push("no GitHub link in the nav");
      if (!document.querySelector(`.foot a[href="${REPO}"]`)) bad.push("no GitHub link in the footer");
      if (!document.querySelector('.foot a[href="https://github.com/sponsors/rowkery"]')) bad.push("no Sponsor link in the footer");
      // The closing section, top to bottom: Download, the command, Build from source, the sponsor note.
      const get = document.querySelector("#get");
      const seq = [".btn.white", ".cmd", 'a[href$="#build-from-source"]', ".sponsor"].map((s) => get.querySelector(s)?.getBoundingClientRect().top ?? NaN);
      for (let i = 1; i < seq.length; i++) if (!(seq[i] > seq[i - 1])) bad.push("the closing section isn't Download, command, Build from source, sponsor note");
      // Headings: no full stops.
      for (const e of document.querySelectorAll("h1, h2, h3")) if (/\.\s*$/.test(e.textContent)) bad.push(`heading ends in a full stop: "${e.textContent}"`);
      // Nothing cut off sideways.
      const sw = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      if (sw > 0) bad.push(`page scrolls sideways by ${sw}px`);
      for (const e of document.querySelectorAll(".row, .row > span, .rows-hd > span, .timed li, .sponsor p, .cmd pre, .mini h3, .card h3"))
        if (e.scrollWidth > e.clientWidth + 1) bad.push(`text cut off: "${e.textContent.trim().slice(0, 40)}"`);
      return bad;
    },
    { ORDER, REPO },
  );
  out.forEach((s) => problems.push(`${tag}: ${s}`));

  // The copy button puts the command on the clipboard and turns to a tick.
  await page.locator("#get .copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== "xattr -dr com.apple.quarantine /Applications/Rowkery.app") problems.push(`${tag}: the copy button copied "${copied}"`);
  if (!(await page.locator("#get .copy[data-copied]").count())) problems.push(`${tag}: the copy button didn't show it copied`);

  await page.screenshot({ path: `${OUT}/${tag}-full.png`, fullPage: true });
  await page.locator("#get").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo({ top: document.querySelector("#get h2").getBoundingClientRect().top + scrollY - 90, behavior: "instant" }));
  await page.screenshot({ path: `${OUT}/${tag}-get.png` });
  await page.evaluate(() => scrollTo({ top: document.querySelector("#tools").getBoundingClientRect().top + scrollY - 70, behavior: "instant" }));
  await page.screenshot({ path: `${OUT}/${tag}-tools.png` });
  await page.evaluate(() => scrollTo({ top: document.querySelector("#exploring").getBoundingClientRect().top + scrollY - 70, behavior: "instant" }));
  await page.screenshot({ path: `${OUT}/${tag}-exploring.png` });
  await ctx.close();
  console.log(`${tag} done`);
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : "No problems found");
process.exitCode = problems.length ? 1 : 0;
