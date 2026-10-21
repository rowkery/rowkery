// Proves every penguin on the built site (out/) is drawn whole, in Chromium, at nine window
// sizes: at each of the story's named moments (scripts/story.mjs: the hero, every scene's rest
// moments, the close, the sections under it and the page end), it samples a grid of points
// inside each visible penguin's fill (the mark's own path, so the props and the box around it
// don't count) and hit-tests them with every layer made hittable, decorative ones included
// (`* { pointer-events: auto !important }`). A point is fine when the topmost element there that
// shows (not faded to nothing) is the penguin itself or something it holds (its own [data-pg]
// box). Anything else on top is a covered penguin and fails. A penguin cut by the edge of the screen fails too, unless it sits in
// the page's normal flow while the moment is about something else (it is scrolling past): a
// pinned scene, the hero and the close's own penguin must be whole on screen. Then the colony,
// scrolled in, halfway and out: every bird on the ground line, none touching its neighbour.
//
//   npm run build && node scripts/penguin-proof.mjs [w h]
//
// With no size it runs all nine and prints "all penguins whole" when every one passes.
import { playwright, serveOut } from "./serve-out.mjs";
import { MOMENTS, goTo } from "./story.mjs";

const { chromium } = playwright();
const SIZES = process.argv[3] ? [[Number(process.argv[2]), Number(process.argv[3])]] : [[1440, 900], [1280, 800], [1024, 768], [1920, 1080], [820, 1180], [390, 844], [430, 932], [375, 667], [360, 740]];
const server = await serveOut();
const browser = await chromium.launch();
let failed = 0;

for (const [w, h] of SIZES) {
  const phone = w < 600;
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2200);
  await page.addStyleTag({ content: "* { pointer-events: auto !important; }" });
  let bad = 0, checked = 0;
  for (const m of MOMENTS) {
    await goTo(page, m, 1400);
    const res = await page.evaluate((m) => {
      const out = [];
      const pinned = !!m.scene || m.at === "top";
      // Whether an element shows at all: no box faded to nothing or hidden on the way up.
      const seen = (el) => {
        let op = 1;
        for (let e = el instanceof SVGElement && el.ownerSVGElement ? el.ownerSVGElement : el; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          op *= Number(cs.opacity);
          if (cs.visibility === "hidden" || op < 0.02) return false;
        }
        return true;
      };
      for (const path of document.querySelectorAll("svg.pg path")) {
        if ((path.getAttribute("d") || "").length < 5000) continue;
        const svg = path.ownerSVGElement;
        let op = 1;
        for (let e = svg; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          op *= Number(cs.opacity);
          if (cs.visibility === "hidden" || cs.display === "none") op = 0;
        }
        if (op < 0.5) continue;
        const r = path.getBoundingClientRect();
        if (r.width < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const own = svg.closest("[data-pg]") ?? svg.closest(".mk") ?? svg;
        const name = own.dataset?.pg ?? (svg.closest(".nav") ? "nav brand" : svg.closest(".dock") ? "dock brand" : svg.closest("footer") ? "foot brand" : String(own.getAttribute("class")));
        const inv = path.getScreenCTM().inverse();
        let inside = 0, hidden = 0, off = 0;
        const misses = [];
        for (let i = 1; i < 24; i++)
          for (let j = 1; j < 24; j++) {
            const x = r.left + (r.width * i) / 24, y = r.top + (r.height * j) / 24;
            if (!path.isPointInFill(new DOMPoint(x, y).matrixTransform(inv))) continue;
            inside++;
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
              off++;
              continue;
            }
            const top = document.elementsFromPoint(x, y).find(seen);
            if (top && own.contains(top)) continue;
            hidden++;
            if (misses.length < 3) misses.push(`${Math.round(x)},${Math.round(y)} ${top ? top.tagName.toLowerCase() + "." + String(top.className.baseVal ?? top.className).split(" ")[0] : "nothing"}`);
          }
        // Off the edge only counts as scrolling past for a penguin in the page's flow at a moment about something else.
        const atRest = pinned || name === "close" || name.startsWith("nav") || name.startsWith("dock");
        out.push({ name, rect: [r.left, r.top, r.width, r.height].map(Math.round), inside, hidden, off, bad: hidden > 0 || (off > 0 && atRest), misses });
      }
      return out;
    }, m);
    for (const r of res) {
      checked++;
      if (r.bad) bad++;
      if (r.bad || process.env.VERBOSE) console.log(`  ${r.bad ? "BAD " : r.off ? "edge" : "ok  "} ${m.name.padEnd(18)} ${r.name.padEnd(12)} ${JSON.stringify(r.rect)} covered ${r.hidden}/${r.inside} off ${r.off}${r.misses.length ? " under " + r.misses.join("; ") : ""}`);
    }
  }
  // The colony: as it scrolls in and out (its drift at either end), every bird stands on the
  // ground line and none touches its neighbour.
  for (const p of [0, 0.5, 1]) {
    await page.evaluate((p) => {
      const r = document.querySelector("[data-colony]").getBoundingClientRect();
      scrollTo({ top: r.top + scrollY - innerHeight + p * (innerHeight + r.height), behavior: "instant" });
    }, p);
    await page.waitForTimeout(400);
    const flock = await page.evaluate(() => {
      const out = [], ground = document.querySelector("[data-colony]").getBoundingClientRect().bottom - 2;
      const birds = [...document.querySelectorAll("[data-colony] .bird")].filter((b) => b.offsetWidth > 0).map((b) => [b.dataset.pg, b.querySelector("path").getBoundingClientRect()]);
      for (const [name, r] of birds) if (Math.abs(r.bottom - ground) > 1.5) out.push(`${name} stands ${(r.bottom - ground).toFixed(1)}px off the ground line`);
      for (let i = 1; i < birds.length; i++) if (birds[i][1].left <= birds[i - 1][1].right) out.push(`${birds[i - 1][0]} and ${birds[i][0]} touch`);
      return out;
    });
    for (const f of flock) {
      console.log(`  BAD  colony at ${p}: ${f}`);
      bad++;
    }
  }
  for (const e of errors) {
    console.log(`  page error: ${e}`);
    bad++;
  }
  console.log(`${w}x${h}: ${checked} penguins at ${MOMENTS.length} moments, ${bad ? `${bad} not whole` : "all penguins whole"}`);
  failed += bad;
  await page.close();
}

await browser.close();
server.close();
console.log(failed ? `${failed} penguin(s) not whole` : "all penguins whole");
process.exitCode = failed ? 1 : 0;
