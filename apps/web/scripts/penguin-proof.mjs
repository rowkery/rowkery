// Proves every penguin on the built site (out/) is drawn whole, in Chromium, at nine window
// sizes. A penguin is checked by sampling a grid of points inside its fill (the mark's own path,
// so the props and the box around it don't count) and hit-testing them with every layer made
// hittable, decorative ones included (`* { pointer-events: auto !important }`). A point is fine
// when the topmost element there that shows (not faded to nothing, and painting something at
// that point rather than a see-through box) is the penguin itself or something it holds (its own
// [data-pg] box). Anything else on top is a covered penguin.
//
// 1. The story's named moments (scripts/story.mjs: the hero, every scene's rest moments, the
//    close and the page end): no penguin covered, and none cut by the edge of the screen unless
//    it sits in the page's flow while the moment is about something else (it is scrolling past);
//    a pinned scene's, the hero's, the close's and the nav's penguins must be whole on screen.
// 2. A sweep through the hero's flight and every pinned scene in 0.1-unit steps, since a reader
//    can stop anywhere: no penguin that shows at all is ever covered, and one held on screen is cut
//    by the screen's edge only while it is entering or leaving (moving or fading between steps).
// 3. The colony, scrolled in, halfway and out: every bird on the ground line, none touching its
//    neighbour.
//
//   npm run build && node scripts/penguin-proof.mjs [w h]
//
// With no size it runs all nine side by side and prints "all penguins whole" when every one
// passes. It doesn't wait for the story to glide to rest: the engine's test hook jumps it there
// and the entrances still playing skip to their ends (scripts/story.mjs, jump), which is the same
// resting state a reader stopping there sees.
import { playwright, serveOut } from "./serve-out.mjs";
import { MOMENTS, SNAP, jump, momentY } from "./story.mjs";

const { chromium } = playwright();
const SIZES = process.argv[3] ? [[Number(process.argv[2]), Number(process.argv[3])]] : [[1440, 900], [1280, 800], [1024, 768], [1920, 1080], [820, 1180], [390, 844], [430, 932], [375, 667], [360, 740]];
const STEP = 0.1;

// In the page: measures every penguin showing at least `min` opacity.
const HELPERS = `
  window.__penguins = (min) => {
    const out = [];
    const seen = (el) => {
      let op = 1;
      for (let e = el instanceof SVGElement && el.ownerSVGElement ? el.ownerSVGElement : el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        op *= Number(cs.opacity);
        if (cs.visibility === "hidden" || op < 0.02) return false;
      }
      return true;
    };
    // Whether an element paints anything at a point: a drawing, a fill, a border, an image, or
    // its own text there. A see-through box (the hero's held screen over the nav, an SVG's empty
    // canvas) hides nothing.
    const paints = (el, x, y) => {
      if ((el instanceof SVGElement && el.tagName !== "svg") || /^(IMG|VIDEO|CANVAS|INPUT|TEXTAREA|SELECT|IFRAME)$/.test(el.tagName)) return true;
      const cs = getComputedStyle(el);
      if (!/^rgba\\(.*,\\s*0\\)$|^transparent$/.test(cs.backgroundColor) || cs.backgroundImage !== "none") return true;
      if (["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs["border" + s + "Width"]) > 0 && !/^rgba\\(.*,\\s*0\\)$/.test(cs["border" + s + "Color"]))) return true;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
      }
      return false;
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
      if (op < min) continue;
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
          if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) {
            off++;
            continue;
          }
          const top = document.elementsFromPoint(x, y).find((e) => seen(e) && (own.contains(e) || paints(e, x, y)));
          if (top && own.contains(top)) continue;
          // The hero's logo lands on the brand: the same mark, laid exactly over it, by design.
          if (name === "nav brand" && top?.closest("[data-pg=hero]")) continue;
          hidden++;
          if (misses.length < 3) misses.push(Math.round(x) + "," + Math.round(y) + " " + (top ? top.tagName.toLowerCase() + "." + String(top.className.baseVal ?? top.className).split(" ")[0] : "nothing"));
        }
      out.push({ name, inScene: !!svg.closest("[data-scene], .h-pin"), op: Number(op.toFixed(2)), rect: [r.left, r.top, r.width, r.height].map(Math.round), inside, hidden, off, misses });
    }
    return out;
  };
`;

const line = (bad, where, r) => `  ${bad ? "BAD " : r.off ? "edge" : "ok  "} ${where.padEnd(18)} ${r.name.padEnd(12)} op ${String(r.op).padEnd(4)} ${JSON.stringify(r.rect)} covered ${r.hidden}/${r.inside} off ${r.off}${r.misses.length ? " under " + r.misses.join("; ") : ""}`;

const server = await serveOut();
const browser = await chromium.launch();

/** Checks one window size; resolves to what it found, printed once every size is done. */
async function check(w, h) {
  const phone = w < 600;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [], out = [];
  const log = (t) => out.push(t);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(SNAP);
  await page.addInitScript(HELPERS);
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__story);
  await page.addStyleTag({ content: "* { pointer-events: auto !important; }" });
  let bad = 0, checked = 0, steps = 0;

  // 1. The named moments.
  for (const m of MOMENTS) {
    await jump(page, await momentY(page, m));
    const pinned = !!m.scene || m.at === "top";
    for (const r of await page.evaluate(() => window.__penguins(0.5))) {
      // Off the edge only counts as scrolling past for a penguin in the page's flow at a moment about something else.
      const atRest = pinned || r.name === "close" || r.name.startsWith("nav") || r.name.startsWith("dock");
      const no = r.hidden > 0 || (r.off > 0 && atRest);
      checked++;
      if (no) bad++;
      if (no || process.env.VERBOSE) log(line(no, m.name, r));
    }
  }

  // 2. The hero's flight and every pinned scene, a tenth of a unit at a time.
  const scenes = await page.evaluate(() => [
    { name: "hero", n: 1, top: 0, unit: document.querySelector("[data-hero]").offsetHeight - document.querySelector(".h-pin").offsetHeight },
    ...[...document.querySelectorAll("[data-scene]")].map((el) => {
      const n = parseFloat(el.style.getPropertyValue("--n"));
      return { name: el.dataset.scene, n, top: el.offsetTop, unit: (el.offsetHeight - el.querySelector(".stage").offsetHeight) / n };
    }),
  ]);
  for (const sc of scenes) {
    const seq = [];
    for (let i = 0; i * STEP <= sc.n + 1e-6; i++) {
      const s = i * STEP;
      await jump(page, Math.round(sc.top + s * sc.unit));
      seq.push([s, await page.evaluate(() => window.__penguins(0.1))]);
      steps++;
    }
    const at = (i, name) => seq[i]?.[1].find((r) => r.name === name);
    // Entering or leaving: fading, or moved since the step before or by the step after.
    const moving = (i, r) => {
      if (r.op < 0.98) return true;
      return [i - 1, i + 1].some((k) => {
        const o = at(k, r.name);
        return k >= 0 && k < seq.length && (!o || o.rect.some((v, j) => Math.abs(v - r.rect[j]) > 1));
      });
    };
    seq.forEach(([s, res], i) => {
      for (const r of res) {
        const no = r.hidden > 0 || (r.off > 0 && r.inScene && !moving(i, r));
        checked++;
        if (no) bad++;
        if (no || process.env.VERBOSE) log(line(no, `${sc.name} ${s.toFixed(1)}`, r));
      }
    });
  }

  // 3. The colony: as it scrolls in and out (its drift at either end), every bird stands on the
  // ground line and none touches its neighbour.
  for (const p of [0, 0.5, 1]) {
    const y = await page.evaluate((p) => {
      const r = document.querySelector("[data-colony]").getBoundingClientRect();
      return Math.round(r.top + scrollY - innerHeight + p * (innerHeight + r.height));
    }, p);
    await jump(page, y);
    const flock = await page.evaluate(() => {
      const out = [], ground = document.querySelector("[data-colony]").getBoundingClientRect().bottom - 2;
      const birds = [...document.querySelectorAll("[data-colony] .bird")].filter((b) => b.offsetWidth > 0).map((b) => [b.dataset.pg, b.querySelector("path").getBoundingClientRect()]);
      for (const [name, r] of birds) if (Math.abs(r.bottom - ground) > 1.5) out.push(`${name} stands ${(r.bottom - ground).toFixed(1)}px off the ground line`);
      for (let i = 1; i < birds.length; i++) if (birds[i][1].left <= birds[i - 1][1].right) out.push(`${birds[i - 1][0]} and ${birds[i][0]} touch`);
      return out;
    });
    for (const f of flock) {
      log(`  BAD  colony at ${p}: ${f}`);
      bad++;
    }
  }
  for (const e of errors) {
    log(`  page error: ${e}`);
    bad++;
  }
  log(`${w}x${h}: ${checked} penguin checks at ${MOMENTS.length} moments and ${steps} scene steps, ${bad ? `${bad} not whole` : "all penguins whole"}`);
  await ctx.close();
  return { bad, out };
}

let failed = 0;
for (const { bad, out } of await Promise.all(SIZES.map(([w, h]) => check(w, h)))) {
  for (const t of out) console.log(t);
  failed += bad;
}

await browser.close();
server.close();
console.log(failed ? `${failed} penguin(s) not whole` : "all penguins whole");
process.exitCode = failed ? 1 : 0;
