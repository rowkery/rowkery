// Proves the marketing refresh (feat/web-marketing-refresh) on the built site in out/, at
// 1440x900 and 390x844, in Chromium:
//  1. the name arrives as "Rookery" and ends as "Rowkery" (frames at 0.9 s, 1.6 s and 3.5 s),
//     with the line on where the name comes from;
//  2. the agent section's heading says you keep full control, on two lines and no comma on a
//     wide screen;
//  3. the hero switch: With your AI agent is pressed first, with the agent, Rowkery and database
//     scene; it turns to On your own ("You" moments over the window) by itself after one 12 s
//     loop, and a click holds it; the page runs Agents, Security, then the keyboard;
//  4. Commit: before the press the new values are faint and the old ones whole; after it the old
//     ones are struck and the new ones lit; the pointer stays inside its card;
//  5. sensitive columns: through a whole loop the robot and its beam stay inside the card, and
//     the masked values only ever show a stand-in;
//  6. Security first, with No account, Keychain, and SSH tunnels and TLS;
//  7. the band of databases: at least 12 logos, sliding, and More databases among the ideas;
//  8. the sponsor note under Build from source, with its Sponsor link.
// Writes frames of each moment per size, and fails on any page error.
//
//   npm run build && node scripts/marketing-refresh-proof.mjs [outDir]
import { mkdir } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const { chromium } = playwright();
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/web-marketing-refresh";
const SPONSOR = "https://github.com/sponsors/rowkery";

await mkdir(OUT, { recursive: true });
const server = await serveOut();
const browser = await chromium.launch();
const problems = [];

const LINES = `window.lines = (e) => { const tops = []; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const c of r.getClientRects()) if (c.width > 0) tops.push(c.top); } return tops.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length; };`;

// Holds the named animations at t seconds into their loop.
const hold = (page, names, t) =>
  page.evaluate(({ names, t }) => {
    for (const a of document.getAnimations()) if (names.includes(a.animationName)) { a.pause(); a.currentTime = t * 1000; }
  }, { names, t });
const PACE = 2 / 3;
const opacity = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).opacity)), sel);
const scrollTo = (page, sel) =>
  page.evaluate((sel) => {
    const e = document.querySelector(sel);
    window.scrollTo({ top: e.getBoundingClientRect().top + scrollY - 90, behavior: "instant" });
    e.closest(".reveal")?.classList.add("in");
    e.querySelectorAll(".reveal").forEach((r) => r.classList.add("in"));
  }, sel);

for (const [w, h] of [[1440, 900], [390, 844]]) {
  const tag = `${w}x${h}`;
  const bad = (s) => problems.push(`${tag}: ${s}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.addInitScript(LINES);
  page.on("pageerror", (e) => bad(`page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  // 1. Rookery, mid-swap, Rowkery: the hero's one-shot animations held at each moment.
  const ONCE = ["drop-out", "make-room", "drop-in", "drop-in-lit", "unlit", "hop"];
  const seenLetter = () => page.evaluate(() => ({ o: parseFloat(getComputedStyle(document.querySelector(".swap .from")).opacity), w: parseFloat(getComputedStyle(document.querySelector(".swap .to:not(.lit)")).opacity) }));
  for (const [t, want] of [[0.9, "o"], [1.75, null], [2.2, null], [3.9, "w"]]) {
    await hold(page, ONCE, t);
    const s = await seenLetter();
    if (want === "o" && !(s.o > 0.95 && s.w < 0.05)) bad(`at ${t} s the name should read Rookery (o ${s.o}, w ${s.w})`);
    if (want === "w" && !(s.w > 0.95 && s.o < 0.05)) bad(`at ${t} s the name should read Rowkery (o ${s.o}, w ${s.w})`);
    await page.screenshot({ path: `${OUT}/${tag}-1-name-${t}s.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 520) } });
  }
  if (!(await page.locator(".origin").innerText()).includes("rookery")) bad("the line on where the name comes from is missing");
  if ((await page.locator(".h1").getAttribute("aria-label")) !== "Meet Rowkery") bad("the heading isn't read out as Meet Rowkery");
  await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });

  // 2. The agent section's heading.
  const h2 = await page.locator("#agents h2").innerText();
  if (!/keep full control/.test(h2) || h2.includes(",")) bad(`the agent heading is "${h2}"`);
  const h2lines = await page.evaluate(() => lines(document.querySelector("#agents h2")));
  if (w > 860 && h2lines !== 2) bad(`the agent heading takes ${h2lines} lines`);

  // 3. The hero switch, and you before your agent on the page.
  const pressed = () => page.evaluate(() => document.querySelector(".modes button[aria-pressed=true]").textContent);
  const who = () => page.evaluate(() => [...document.querySelectorAll(".toast .hd b")].map((b) => b.textContent));
  const sceneOn = () => page.evaluate(() => !!document.querySelector(".stage-agent .scene") && getComputedStyle(document.querySelector(".stage-agent")).opacity === "1");
  if ((await pressed()) !== "With your AI agent") bad("the hero doesn't start With your AI agent");
  if (!(await sceneOn())) bad("With your AI agent doesn't show the agent scene");
  await page.evaluate(() => scrollTo({ top: document.querySelector(".modes").getBoundingClientRect().top + scrollY - 140, behavior: "instant" }));
  // Real time: the switch turns 12 s after the page loads.
  const loaded = await page.evaluate(() => performance.now());
  const until = async (ms) => page.waitForTimeout(Math.max(0, ms - (await page.evaluate(() => performance.now())) + loaded));
  await until(4600);
  await page.screenshot({ path: `${OUT}/${tag}-3-agent.png` });
  await until(12600);
  if ((await pressed()) !== "On your own") bad("the switch didn't turn to On your own by itself after 12 s");
  await page.waitForTimeout(600);
  const under = await page.evaluate(() => { const t = document.querySelector(".modes .thumb").getBoundingClientRect(), b = document.querySelector('.modes button[aria-pressed="true"]').getBoundingClientRect(); return Math.abs(t.left + t.width / 2 - (b.left + b.width / 2)) < 4; });
  if (!under) bad("the switch's white thumb isn't under the pressed button");
  if (!(await who()).length || !(await who()).every((x) => x === "You")) bad("On your own doesn't show your own moments");
  await until(16600);
  await page.screenshot({ path: `${OUT}/${tag}-3-own.png` });
  await page.locator(".modes button", { hasText: "With your AI agent" }).click();
  await page.waitForTimeout(12500);
  if ((await pressed()) !== "With your AI agent") bad("after a click the switch kept turning by itself");
  const order = await page.evaluate(() => ["#agents", "#security", "#keys", "#tools"].map((s) => document.querySelector(s).getBoundingClientRect().top));
  if (!order.every((t, i) => i === 0 || t > order[i - 1])) bad("the page isn't Agents, Security, Keyboard, Plans from the top");
  for (const a of await page.locator(".nav .links a").all()) {
    const href = await a.getAttribute("href");
    if (!(await page.locator(href).count())) bad(`the nav's ${href} goes nowhere`);
  }

  // 4. Commit, before and after the press. Times are on the 8 s count the loops were drawn at;
  // PACE plays them 50% faster, as on the page.
  const C = ["c-pointer", "c-press", "c-wait", "c-done", "c-was", "c-strike", "c-next"];
  await scrollTo(page, '[data-card="proposals"]');
  await page.waitForTimeout(1000);
  for (const t of [1, 2.9, 3.3, 4.2]) {
    await hold(page, C, t * PACE);
    const [was, next] = [await opacity(page, ".commit .was"), await opacity(page, ".commit .next")];
    if (t < 3.3 && !(was.every((o) => o > 0.95) && next.every((o) => o < 0.5))) bad(`Commit at ${t} s: the data changed before the press`);
    if (t > 4 && !(was.every((o) => o < 0.5) && next.every((o) => o > 0.95))) bad(`Commit at ${t} s: the data didn't change after the press`);
    const inside = await page.evaluate(() => { const c = document.querySelector('[data-card="proposals"]').getBoundingClientRect(), p = document.querySelector(".commit .pointer"); const r = p.getBoundingClientRect(); return parseFloat(getComputedStyle(p).opacity) < 0.05 || (r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom); });
    if (!inside) bad(`Commit at ${t} s: the pointer leaves its card`);
    await page.locator('[data-card="proposals"]').screenshot({ path: `${OUT}/${tag}-4-commit-${t}s.png` });
  }

  // 5. Sensitive columns through a whole loop.
  const M = ["m-walk", "m-shake", "m-v0", "m-v1", "m-v2", "m-v3", "m-l1", "m-l2"];
  await scrollTo(page, '[data-card="sensitive"]');
  await page.waitForTimeout(1000);
  for (let t = 0; t < 8; t += 0.25) {
    await hold(page, M, t * PACE);
    const out = await page.evaluate(() => {
      const c = document.querySelector('[data-card="sensitive"]').getBoundingClientRect();
      const o = [];
      for (const e of document.querySelectorAll(".mask .bot, .mask .beam")) { const r = e.getBoundingClientRect(); if (r.left < c.left || r.right > c.right || r.top < c.top || r.bottom > c.bottom) o.push(e.className.baseVal ?? e.className); }
      for (const e of document.querySelectorAll(".mask .hid > span:last-child")) if (!e.textContent.startsWith("masked:")) o.push("a sensitive value shows");
      return o;
    });
    for (const s of out) bad(`sensitive at ${t} s: ${s} leaves its card`);
    if ([1, 2.5, 4.5].includes(t)) await page.locator('[data-card="sensitive"]').screenshot({ path: `${OUT}/${tag}-5-sensitive-${t}s.png` });
  }

  // 6. Security first.
  if ((await page.locator("#security h2").innerText()) !== "Security first") bad("no Security first heading");
  const sec = await page.locator("#security h3").allInnerTexts();
  for (const want of ["No account", "Keychain", "SSH tunnels and TLS"]) if (!sec.includes(want)) bad(`Security first has no ${want} card`);
  await scrollTo(page, "#security");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${tag}-6-security.png` });

  // 7. The band of databases.
  const logos = await page.locator(".marquee li:not([data-copy]) svg").count();
  if (logos < 12) bad(`the band shows only ${logos} logos`);
  const running = await page.evaluate(() => document.getAnimations().some((a) => a.animationName === "marquee" && a.playState === "running"));
  if (!running) bad("the band isn't sliding");
  if (!(await page.locator("#exploring h3", { hasText: "More databases" }).count())) bad("no More databases idea");
  await scrollTo(page, "#exploring");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${tag}-7-exploring.png` });

  // 8. The sponsor note.
  const get = await page.evaluate(() => {
    const g = document.querySelector("#get"), s = g.querySelector(".sponsor"), b = g.querySelector('a[href$="#build-from-source"]');
    return { after: s && b && s.getBoundingClientRect().top > b.getBoundingClientRect().top, link: !!s?.querySelector(`a[href="https://github.com/sponsors/rowkery"]`), text: s?.textContent ?? "" };
  });
  if (!get.after) bad("the sponsor note isn't under Build from source");
  if (!get.link) bad(`the sponsor note has no link to ${SPONSOR}`);
  if (!/open source/.test(get.text) || !/free time/.test(get.text)) bad("the sponsor note doesn't say it's open source and built in free time");
  await scrollTo(page, "#get .sponsor");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${tag}-8-sponsor.png` });

  const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sw > 0) bad(`page scrolls sideways by ${sw}px`);
  await ctx.close();
  console.log(`${tag} done`);
}

await browser.close();
server.close();
console.log(problems.length ? `Problems:\n${problems.join("\n")}` : "No problems found");
process.exitCode = problems.length ? 1 : 0;
