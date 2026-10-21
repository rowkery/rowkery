/**
 * The story engine: each scene is a tall section with one pinned stage, and the scroll position
 * through it (in units of `--unit`, damped) drives every piece on the stage. It runs only when
 * the page carries `data-motion` (scripts on, no Reduce Motion: app/layout.tsx); without it every
 * scene is a plain stack showing its finished state, which is what the markup holds.
 *
 * Performance rules (scripts/scroll-profile.mjs checks the last one):
 * - pieces move by transform and opacity only, on HTML boxes, never on shapes inside an SVG;
 * - a style is written only when its value changes (`css`, `place`, `setText`);
 * - one requestAnimationFrame loop runs while something is still settling and stops after, and
 *   scroll, resize and the pointer wake it; nothing runs on a timer (the hero's jobs cycle and
 *   the key presses are CSS animations);
 * - so a page sitting still never lays out or paints.
 */
import { AGENT_SQL, CARDS, CHORDS, SEC, type SecKey } from "./data";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const linear = (t: number) => t;
/** Progress from 0 to 1 as s goes from a to b, eased. */
const seg = (s: number, a: number, b: number, f = easeIO) => f(clamp((s - a) / (b - a), 0, 1));

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

// ── Writing styles only when they change ───────────────────────────────────
const written = new WeakMap<HTMLElement, Record<string, string>>();
function css(el: HTMLElement, prop: string, value: string) {
  let w = written.get(el);
  if (!w) written.set(el, (w = {}));
  if (w[prop] === value) return;
  w[prop] = value;
  el.style.setProperty(prop, value);
}
function setText(el: HTMLElement, t: string) {
  if (el.textContent !== t) el.textContent = t;
}
/** Places a piece (design px), with its scale and opacity; hidden outright once it fades out. */
function place(el: HTMLElement, v: { x: number; y: number; s?: number; o?: number }) {
  const o = clamp(v.o ?? 1, 0, 1);
  css(el, "transform", `translate3d(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px, 0) scale(${(v.s ?? 1).toFixed(4)})`);
  css(el, "opacity", o.toFixed(3));
  css(el, "visibility", o < 0.005 ? "hidden" : "visible");
}
/** Plays a one-shot CSS animation again by switching between two classes that run the same keyframes. */
function replay(el: HTMLElement, a: string, b: string) {
  const next = el.classList.contains(a) ? b : a;
  el.classList.remove(a, b);
  el.classList.add(next);
}
const hop = (el: HTMLElement) => replay(el, "ha", "hb");
function setProp(host: HTMLElement, prop: string) {
  const svg = $<SVGElement>("svg", host);
  if (svg.dataset.prop === prop) return false;
  svg.dataset.prop = prop;
  return true;
}
// Text that turns into its stand-in a character at a time, scrambling at the edge.
const NOISE = "abcdef0123456789#%&*@$";
function morph(real: string, masked: string, k: number, salt: number) {
  const L = Math.max(real.length, masked.length);
  let out = "";
  for (let i = 0; i < L; i++) {
    if (i < k - 1.5) out += masked[i] ?? "";
    else if (i < k + 1.5 && k > 0 && k < L) out += NOISE[(i * 7 + salt * 13) % NOISE.length];
    else out += real[i] ?? "";
  }
  return out;
}

// ── Layout: the sizes every scene places its pieces by ─────────────────────
let root: HTMLElement;
let VW = 0, VH = 0, wide = true, phone = false, UNIT = 1;
let AREA = { w: 800, h: 600 };
const NAV = 78;

/** Scales a scene's object (drawn at dw × dh) to fit the area; dy (design px) leaves room above it. */
function fit(obj: HTMLElement, dw: number, dh: number, extraW = 1, extraH = 1, dy = 0) {
  const k = Math.min(AREA.w / (dw * extraW), AREA.h / (dh * extraH), 1.25);
  css(obj, "--dw", dw + "px");
  css(obj, "--dh", dh + "px");
  css(obj.firstElementChild as HTMLElement, "transform", `translateY(${(dy * k).toFixed(1)}px) scale(${k.toFixed(4)})`);
  return k;
}

/** A big title whose words arrive one after another and leave together. */
class TitleFx {
  words: HTMLElement[];
  key = "";
  constructor(public el: HTMLElement) {
    this.words = $$(".w", el);
  }
  update(pin: number, pout: number) {
    const key = pin.toFixed(3) + pout.toFixed(3);
    if (key === this.key) return;
    this.key = key;
    const n = this.words.length;
    this.words.forEach((w, i) => {
      const e = easeOut(clamp(pin * (1 + n * 0.16) - i * 0.16, 0, 1));
      css(w, "opacity", (e * (1 - pout)).toFixed(3));
      css(w, "transform", `translateY(${((1 - e) * 0.32 - pout * 0.1).toFixed(3)}em) scale(${(0.94 + e * 0.06).toFixed(3)})`);
    });
    // Faded out, never hidden: the words stay in the page for a screen reader.
    css(this.el, "transform", `translate(-50%, -50%) scale(${(1 + pout * 0.08).toFixed(4)})`);
  }
}

/** The captions and the rail: one caption per step, its bar filling as you scroll through it. */
class Steps {
  rail: HTMLElement;
  fills: HTMLElement[];
  caps: HTMLElement[];
  on = -2;
  constructor(stage: HTMLElement, public starts: number[]) {
    this.rail = $(".rail", stage);
    this.fills = $$(".rail i", stage);
    this.caps = $$(".cap", stage);
  }
  /** The step the object shows: the last one started, so it holds after the captions end. */
  at(s: number) {
    let i = 0;
    this.starts.forEach((a, k) => {
      if (s >= a - 0.02) i = k;
    });
    return i;
  }
  update(s: number) {
    let on = -1;
    this.starts.forEach((a, i) => {
      if (s >= a - 0.02 && s < a + 0.98) on = i;
    });
    this.fills.forEach((f, i) => css(f, "transform", `scaleY(${clamp(s - this.starts[i], 0, 1).toFixed(3)})`));
    const last = this.starts[this.starts.length - 1] + 1;
    this.rail.classList.toggle("on", s > this.starts[0] - 0.3 && s < last + 0.3);
    if (on === this.on) return;
    this.on = on;
    this.caps.forEach((el, i) => {
      el.classList.toggle("on", i === on);
      el.classList.toggle("up", i < on);
    });
  }
}

// ── A scene: a tall section, a pinned stage, a damped position ─────────────
abstract class Scene {
  s = -1.2;
  target = -1.2;
  top = 0;
  h = 0;
  visible = false;
  drawn: number | null = null;
  stage: HTMLElement;
  constructor(public el: HTMLElement, public n: number) {
    this.stage = $(".stage", el);
  }
  measure() {
    this.top = this.el.offsetTop;
    this.h = this.el.offsetHeight;
  }
  read(y: number) {
    this.target = clamp((y - this.top) / UNIT, -1.2, this.n);
    this.visible = y + VH > this.top - 10 && y < this.top + this.h + 10;
  }
  /** Moves s toward the target; true while it is still on its way. */
  step(dt: number) {
    this.s += (this.target - this.s) * (1 - Math.exp(-dt * 6.5));
    if (Math.abs(this.target - this.s) < 0.0006) this.s = this.target;
    return this.s !== this.target;
  }
  layout() {
    this.measure();
    this.fitObj();
    this.drawn = null;
  }
  frame() {
    if (this.drawn === this.s) return;
    this.drawn = this.s;
    this.update(this.s);
  }
  fitObj() {}
  abstract update(s: number): void;
}

// ── 01 · With your agent ──────────────────────────────────────────────────
const SQL_LEN = AGENT_SQL.reduce<number>((n, p) => n + (typeof p === "string" ? p : p[0]).length, 0);
class AgentScene extends Scene {
  title = new TitleFx($(".title", this.stage));
  steps = new Steps(this.stage, [1.2, 2.2, 3.2, 4.2]);
  obj = $(".obj", this.stage);
  win = $(".a-win", this.stage);
  ask = $(".a-ask", this.stage);
  checks = $(".a-checks", this.stage);
  checkEls = $$(".check", this.stage);
  legend = $(".a-legend", this.stage);
  toast = $(".a-toast", this.stage);
  peek = $(".a-peek", this.stage);
  sql = $(".a-sql", this.stage);
  grid = $(".a-grid", this.stage);
  rows = $$(".a-grid .r.in", this.stage);
  cc = $$(".a-grid .cc", this.stage);
  review = $(".a-review", this.stage);
  commit = $(".a-commit", this.stage);
  html = "";
  fitObj() {
    if (phone) fit(this.obj, 360, 420, 1.02, 1.26, 40);
    else fit(this.obj, 700, 470, wide ? 1.36 : 1.06, 1.22);
  }
  update(s: number) {
    this.title.update(seg(s, -0.9, 0.35, linear), seg(s, 0.55, 1.05, linear));
    this.steps.update(s);
    const W = phone ? 360 : 700;
    const enter = seg(s, 0.75, 1.3), leave = seg(s, 5.6, 6.5);
    const L = (a: number, b: number) => seg(s, a, b);
    // Wide screens have room beside the window for the cards; narrower ones keep them over it.
    const inX = (x: number, w: number) => (wide ? x : clamp(x, 16, W - w - 16));
    place(this.win, { x: 0, y: mix(160, 0, enter) - leave * 120, s: mix(0.9, 1, enter) - leave * 0.06, o: enter * (1 - leave) });
    // Step 1: the question lifts out to the left, and the query types itself as you scroll.
    const ask = L(1.15, 1.5) * (1 - L(2.05, 2.35));
    place(this.ask, phone ? { x: 20, y: mix(120, 60, ask), o: ask } : { x: inX(mix(80, -150, ask), 322), y: mix(110, 70, ask), o: ask });
    let left = Math.round(SQL_LEN * seg(s, 1.3, 2.0, linear)), html = "";
    for (const p of AGENT_SQL) {
      const t = typeof p === "string" ? p : p[0];
      const part = t.slice(0, Math.max(0, left));
      left -= t.length;
      if (part) html += typeof p === "string" ? part.replace(/</g, "&lt;") : `<span class="k">${part}</span>`;
    }
    if (left < 0 || s < 2.2) html += '<span class="caret"></span>';
    if (this.html !== html) this.sql.innerHTML = this.html = html;
    // Step 2: the checks lift out to the right and tick one by one.
    const ch = L(2.15, 2.5) * (1 - L(3.05, 3.35));
    place(this.checks, phone ? { x: 30, y: mix(260, 190, ch), o: ch } : { x: inX(mix(W - 330, W - 210, ch), 332), y: mix(210, 150, ch), o: ch });
    this.checkEls.forEach((c, i) => c.classList.toggle("done", s > 2.35 + i * 0.16));
    // Step 3: the rows arrive, and card_number turns into its stand-in row by row.
    css(this.grid, "opacity", s > 3.1 ? "1" : "0");
    this.rows.forEach((r, i) => {
      const e = seg(s, 3.15 + i * 0.07, 3.45 + i * 0.07);
      place(r, { x: 0, y: (1 - e) * 10, o: e });
    });
    const m = seg(s, 3.5, 4.0, linear) * CARDS.length;
    this.cc.forEach((el, i) => {
      const [real, masked] = CARDS[i];
      const k = clamp(m - i, 0, 1) * (Math.max(real.length, masked.length) + 2);
      setText(el, morph(real, masked, k, Math.floor(s * 60)));
      el.classList.toggle("mask", k >= masked.length);
    });
    const lg = L(3.55, 3.85) * (1 - L(4.1, 4.35));
    place(this.legend, phone ? { x: 40, y: mix(400, 350, lg), o: lg } : { x: inX(mix(40, -150, lg), 302), y: mix(360, 330, lg), o: lg });
    // Step 4: the change Claude proposed slides in; Commit presses; a note says it's done.
    css(this.review, "transform", `translateX(${((1 - seg(s, 4.2, 4.55)) * 102).toFixed(2)}%)`);
    this.commit.classList.toggle("press", s > 4.78 && s < 4.9);
    const ts = L(4.85, 5.05) * (1 - leave);
    place(this.toast, phone ? { x: 70, y: mix(450, 400, ts) - leave * 120, o: ts } : { x: mix(230, 260, ts), y: mix(500, 440, ts) - leave * 120, o: ts });
    // The penguin stands on the window's top edge and carries what fits the step.
    if (setProp(this.peek, ["letter", "magnifier", "shades", "sign"][this.steps.at(s)])) hop($(".hopper", this.peek));
    const pk = seg(s, 1.05, 1.4, easeOut);
    place(this.peek, { x: phone ? 260 : 560, y: mix(20, -78, pk) - leave * 120 + mix(160, 0, enter), o: Math.min(pk, 1 - leave) });
  }
}

// ── 02 · Security ─────────────────────────────────────────────────────────
class SecurityScene extends Scene {
  title = new TitleFx($(".title", this.stage));
  steps = new Steps(this.stage, [1.2, 2.2, 3.2]);
  obj = $(".obj", this.stage);
  gpg = $(".gpg", this.stage);
  card = $(".scard", this.stage);
  panes = $$(".spane", this.stage);
  tl = $$(".tl", this.stage);
  vals = $$("[data-sec]", this.stage);
  beams = $$(".beam", this.stage);
  fitObj() {
    // A phone stands the penguin on top of the card; wider screens put it beside the card.
    if (phone) fit(this.obj, 380, 630, 1.02, 1);
    else fit(this.obj, 760, 540, wide ? 1 : 1.04, 1.04);
  }
  update(s: number) {
    this.title.update(seg(s, -0.9, 0.35, linear), seg(s, 0.55, 1.05, linear));
    this.steps.update(s);
    const enter = seg(s, 0.7, 1.35), leave = seg(s, 4.35, 5.1), card = seg(s, 0.95, 1.4), cardO = seg(s, 0.95, 1.35) * (1 - leave);
    // The penguin rises from below the stage and sinks back at the end, faster than it came.
    place(this.gpg, phone ? { x: 44, y: mix(660, 0, enter) + leave * 900, o: 1 - leave } : { x: 345, y: mix(620, 68, enter) + leave * 900, o: 1 - leave });
    place(this.card, phone ? { x: 0, y: mix(420, 292, card) - leave * 80, o: cardO } : { x: 0, y: mix(330, 200, card) - leave * 80, o: cardO });
    const step = this.steps.at(s);
    this.panes.forEach((p, i) => p.classList.toggle("off", i !== step));
    // Step 1: three tables switch on.
    this.tl.forEach((t, i) => t.classList.toggle("on", i < 3 && s > 1.35 + i * 0.15));
    // Steps 2 and 3: a beam sweeps across and the values turn into stand-ins behind it.
    const p1 = seg(s, 2.35, 2.95, linear), p2 = seg(s, 3.35, 3.95, linear);
    const at: Record<SecKey, number> = {
      card: p1,
      phone: clamp(p1 * 1.15 - 0.15, 0, 1),
      host: p2,
      user: clamp(p2 * 1.1 - 0.05, 0, 1),
      password: clamp(p2 * 1.2 - 0.2, 0, 1),
    };
    for (const el of this.vals) {
      const key = el.dataset.sec as SecKey, [real, masked] = SEC[key];
      const k = at[key] * (Math.max(real.length, masked.length) + 2);
      setText(el, morph(real, masked, k, Math.floor(s * 60) + key.length));
      el.classList.toggle("m", k >= masked.length);
    }
    [p1, p2].forEach((p, i) => {
      css(this.beams[i], "opacity", p > 0.01 && p < 0.99 ? "1" : "0");
      css(this.beams[i], "transform", `translateX(${(118 + p * 165).toFixed(1)}px)`);
    });
    // The big penguin picks up a magnifier, then orange shades, then a key.
    if (s > 0.9 && setProp(this.gpg, ["magnifier", "shades", "key"][step])) hop($(".hopper", this.gpg));
  }
}

// ── 03 · On your own ──────────────────────────────────────────────────────
class KeysScene extends Scene {
  title = new TitleFx($(".title", this.stage));
  steps = new Steps(this.stage, [1.2, 2.2, 3.2]);
  obj = $(".obj", this.stage);
  win = $(".k-win", this.stage);
  keys = $(".keys", this.stage);
  shift = $(".k-shift", this.stage);
  label = $(".k-last .kl", this.stage);
  peek = $(".kpg .hopper", this.stage);
  panels = $$(".panel", this.win);
  typed = $(".k-typed", this.stage);
  res = $$(".pal .res", this.stage);
  rows = $$(".k-row", this.stage);
  commit = $(".k-commit", this.stage);
  chord = -1;
  /** The pointer, damped (-0.5 to 0.5 across the window): the keycaps lean toward it. */
  px = 0;
  py = 0;
  fitObj() {
    if (phone) fit(this.obj, 360, 580, 1.02, 1);
    // The keys stand out to the left of the window: -170 to 790 across a 640 drawing.
    else fit(this.obj, 640, 430, 1.55, 1.32);
  }
  update(s: number) {
    this.title.update(seg(s, -0.9, 0.35, linear), seg(s, 0.55, 1.05, linear));
    this.steps.update(s);
    const enter = seg(s, 0.75, 1.3), leave = seg(s, 4.35, 5.1);
    place(this.win, { x: phone ? 0 : 150, y: mix(140, 0, enter) - leave * 120, s: mix(0.92, 1, enter), o: enter * (1 - leave) });
    this.lean(s);
    const step = this.steps.at(s);
    if (step !== this.chord && s > 1.1) {
      this.chord = step;
      const [shift, , key] = CHORDS[step];
      this.shift.classList.toggle("gone", !shift);
      setText(this.label, key);
      // The keys press one after another (CSS delays), and the penguin hops with the last one.
      replay(this.keys, "pa", "pb");
      hop(this.peek);
    }
    this.panels.forEach((p, i) => p.classList.toggle("on", i === step));
    const q = "ord", n = Math.round(q.length * seg(s, 1.35, 1.75, linear));
    setText(this.typed, q.slice(0, n));
    this.res.forEach((r, i) => r.classList.toggle("hide", n >= 2 && i >= 3));
    this.rows.forEach((r, i) => {
      const e = seg(s, 2.35 + i * 0.08, 2.6 + i * 0.08);
      place(r, { x: 0, y: (1 - e) * 10, o: e });
    });
    this.commit.classList.toggle("press", s > 3.75 && s < 3.9);
  }
  /** The keycaps come up from below and lean toward the pointer. */
  lean(s = this.s) {
    const ke = seg(s, 0.95, 1.45), leave = seg(s, 4.35, 5.1), o = ke * (1 - leave);
    // On a phone the keys sit under the window, with room for the penguin between them.
    const kx = phone ? 12 : -170, ky = phone ? 470 : 300;
    css(this.keys, "transform", `translate3d(${kx}px, ${(mix(ky + 200, ky, ke) + leave * 300).toFixed(1)}px, 0) perspective(900px) rotateX(${(14 - this.py * 18).toFixed(2)}deg) rotateY(${(-10 + this.px * 22).toFixed(2)}deg)`);
    css(this.keys, "opacity", o.toFixed(3));
    css(this.keys, "visibility", o < 0.005 ? "hidden" : "visible");
  }
}

// ── 04 · For everyone: the page turns white ───────────────────────────────
class FreeScene extends Scene {
  flood = $(".flood", this.stage);
  bigs = $$(".big", this.stage).map((el) => new TitleFx(el));
  cards = $$(".fcard", this.stage);
  discs = $(".discs", this.stage);
  btns = $$("[data-disc]", this.stage);
  starts = [0.55, 1.85, 3.15];
  R = 0;
  cx = 0;
  cy = 0;
  constructor(el: HTMLElement, n: number) {
    super(el, n);
    this.btns.forEach((b, i) => b.addEventListener("click", () => scrollTo({ top: this.top + (this.starts[i] + 0.6) * UNIT, behavior: "smooth" })));
  }
  update(s: number) {
    const din = seg(s, -0.7, 0.55), dout = seg(s, 4.4, 5.3);
    const diag = Math.hypot(VW, VH);
    const R = dout > 0 ? mix(diag * 0.62, VW * 0.22, dout) : mix(VW * 0.24, diag * 0.62, din);
    const cy = dout > 0 ? mix(VH / 2, -R * 0.75, dout) : mix(VH + R * 0.62, VH / 2, din);
    this.R = R;
    this.cx = VW / 2;
    this.cy = cy;
    css(this.flood, "transform", `translate3d(${(VW / 2 - 1000).toFixed(1)}px, ${(cy - 1000).toFixed(1)}px, 0) scale(${(R / 1000).toFixed(4)})`);
    css(this.flood, "visibility", din > 0 && dout < 1 ? "visible" : "hidden");
    let on = -1;
    this.bigs.forEach((b, i) => {
      const a = this.starts[i], end = i < 2 ? this.starts[i + 1] : 4.8;
      b.update(seg(s, a, a + 0.5, linear), seg(s, end - 0.32, end, linear));
      const c = seg(s, a + 0.2, a + 0.55) * (1 - seg(s, end - 0.3, end));
      place(this.cards[i], { x: 0, y: (1 - c) * 18, o: c });
      if (s >= a && s < end) on = i;
    });
    css(this.discs, "visibility", din > 0.9 && dout < 0.04 ? "visible" : "hidden");
    this.btns.forEach((b, i) => b.classList.toggle("on", i === on));
  }
  /** True where the white page lies under a point on the screen. */
  covers(x: number, y: number) {
    return this.visible && this.flood.style.visibility === "visible" && Math.hypot(x - this.cx, y - this.cy) < this.R - 4;
  }
}

const CHAPTERS = [
  ["01", "With your agent"],
  ["02", "Security"],
  ["03", "On your own"],
  ["04", "For everyone"],
];

export function startStory() {
  root = document.documentElement;
  const ac = new AbortController();
  const on = { signal: ac.signal, passive: true } as const;
  root.setAttribute("data-story", "");

  const agent = new AgentScene($("[data-scene=agent]"), 6.6);
  const security = new SecurityScene($("[data-scene=security]"), 5.2);
  const keys = new KeysScene($("[data-scene=keys]"), 5.2);
  const free = new FreeScene($("[data-scene=free]"), 5.4);
  const scenes: Scene[] = [agent, security, keys, free];

  // ── Hero ──
  const hero = $("[data-hero]"), hpg = $(".hpg", hero), look = $(".look", hpg), props = $(".props", hpg), hop1 = $(".hop1", hpg);
  const htL = $(".ht-l", hero), htR = $(".ht-r", hero), hFoot = $(".h-foot", hero), now = $(".now-o", hero), cue = $(".cue-o", hero);
  const brandMk = $(".nav .brand .mk");
  let base = { x: 0, y: 0, w: 1 };
  function measureHero() {
    // The job line sits under the penguin, wherever the words' widths put it.
    const slot = $(".h-slot", hero).getBoundingClientRect(), mid = $(".h-mid", hero).getBoundingClientRect();
    css(now, "--nx", (slot.left + slot.width / 2 - (mid.left + mid.width / 2)).toFixed(1) + "px");
    const prev = hpg.style.transform;
    hpg.style.transform = "none";
    const r = hpg.getBoundingClientRect();
    base = { x: r.left + r.width / 2, y: r.top + r.height / 2 + scrollY, w: r.width };
    hpg.style.transform = prev;
    heroKey = "";
  }
  // The jobs take turns on a CSS cycle (2.6 s each, globals.css); a mouse moving across the hero
  // picks one and holds it (.held), and a tap moves on to the next.
  const JOB_MS = 2600, JOBS = 5;
  const cycle = () => hero.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && (a.animationName === "job" || a.animationName === "hopc"));
  let picked = -1;
  hero.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      const i = clamp(Math.floor((e.clientX / VW) * JOBS), 0, JOBS - 1);
      if (i === picked) return;
      picked = i;
      // Held by a class, not pause(): once a script pauses or plays a CSS animation, the
      // stylesheet can no longer pause it, and the hero's loops must stop when it scrolls away.
      hero.classList.add("held");
      for (const a of cycle()) a.currentTime = i * JOB_MS + 450;
      hop(hop1);
    },
    on,
  );
  hero.addEventListener(
    "pointerleave",
    () => {
      picked = -1;
      hero.classList.remove("held");
    },
    on,
  );
  hero.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      for (const a of cycle()) a.currentTime = (Math.floor(Number(a.currentTime ?? 0) / JOB_MS) + 1) * JOB_MS;
    },
    on,
  );

  // ── Nav, dock, grid, the close and the colony ──
  const nav = $("[data-nav]"), chapter = $(".chapter", nav), chIn = $(".ch-in", nav), chN = $(".ch-n", nav), chT = $(".ch-t", nav), chBar = $(".ch-bar i", nav);
  const dock = $("[data-dock]"), grid = $(".bg-grid"), gridI = $(".bg-grid i");
  const close = $("[data-close]"), colony = $("[data-colony]"), birds = $$(".bird", colony);
  let shownCh = -2, drift = 0;
  function setChapter(c: number) {
    if (c === shownCh) return;
    shownCh = c;
    chapter.classList.toggle("on", c >= 0);
    if (c < 0) return;
    setText(chN, CHAPTERS[c][0]);
    setText(chT, CHAPTERS[c][1]);
    replay(chIn, "sa", "sb");
    css(chapter, "width", chIn.scrollWidth + "px");
  }
  function layoutColony() {
    // Even gaps between the birds standing now; the drift stays under the gap, so neighbours never touch.
    const shown = birds.filter((b) => b.offsetWidth > 0);
    const sum = shown.reduce((a, b) => a + b.offsetWidth, 0);
    drift = Math.max(0, ((colony.clientWidth - sum) / (shown.length + 1)) * 0.9);
  }
  $$("[data-jump]").forEach((a) =>
    a.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        scrollTo({ top: agent.top + 0.2 * UNIT, behavior: "smooth" });
      },
      { signal: ac.signal },
    ),
  );
  const io = new IntersectionObserver(
    (en) => {
      if (!en[0].isIntersecting || close.classList.contains("on")) return;
      close.classList.add("on");
      hop($(".hpg2 .hopper", close));
    },
    { threshold: 0.35 },
  );
  io.observe(close);

  // ── Layout ──
  function layout() {
    VW = innerWidth;
    VH = agent.stage.offsetHeight;
    wide = VW >= 1000;
    phone = VW < 600;
    // The scenes' heights come from CSS (--unit); read it back rather than set it.
    UNIT = (agent.el.offsetHeight - VH) / agent.n;
    // Stages: captions left and the object right, or the object over a caption zone.
    if (wide) {
      const capx = Math.max(72, VW * 0.075), capw = Math.min(380, VW * 0.27);
      const left = capx + capw + 40, right = VW - Math.max(40, VW * 0.04);
      css(root, "--capx", capx + "px");
      css(root, "--capw", capw + "px");
      css(root, "--capy", NAV + (VH - NAV) / 2 + "px");
      css(root, "--ax", (left + right) / 2 + "px");
      css(root, "--ay", NAV + (VH - NAV) / 2 + "px");
      AREA = { w: right - left, h: VH - NAV - 50 };
    } else {
      const CAP = phone ? 150 : 140, BOT = phone ? 84 : 92;
      const top = NAV + 6, bottom = VH - CAP - BOT;
      css(root, "--capx", "24px");
      css(root, "--capw", VW - 48 + "px");
      css(root, "--capy", bottom + 22 + CAP / 2 + "px");
      css(root, "--ax", VW / 2 + "px");
      css(root, "--ay", (top + bottom) / 2 + "px");
      AREA = { w: VW - 28, h: bottom - top };
    }
    scenes.forEach((s) => s.layout());
    measureHero();
    layoutColony();
    shownCh = -2;
    wake();
  }

  // ── Pointer: the hero penguin faces it, the keycaps lean toward it ──
  let tpx = 0, tpy = 0, mx = -1;
  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      tpx = e.clientX / VW - 0.5;
      tpy = e.clientY / VH - 0.5;
      mx = e.clientX;
      wake();
    },
    on,
  );

  // ── The frame: runs while anything is settling, then stops ──
  let raf = 0, last = 0, heroKey = "", lastY = -1;
  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame(t: number) {
    raf = 0;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
    last = t;
    const y = scrollY;
    let busy = false;
    keys.px += (tpx - keys.px) * 0.08;
    keys.py += (tpy - keys.py) * 0.08;
    if (Math.abs(tpx - keys.px) < 0.0005 && Math.abs(tpy - keys.py) < 0.0005) {
      keys.px = tpx;
      keys.py = tpy;
    } else busy = true;
    const px = keys.px, py = keys.py;

    // The hero: the words part, and the big penguin flies up into the brand.
    // Past the hero the scroll is held at its end, so a long jump still lands it there (and pauses its loops).
    const hy = Math.min(y, VH * 1.2), hk = clamp(hy / (VH * 0.8), 0, 1), he = easeIO(hk);
    const hKey = `${hy}|${px.toFixed(4)}|${py.toFixed(4)}|${mx >= 0 && mx < base.x - 20}`;
    if (hKey !== heroKey) {
      heroKey = hKey;
      css(htL, "transform", `translateX(${(-hk * VW * 0.22).toFixed(1)}px)`);
      css(htR, "transform", `translateX(${(hk * VW * 0.22).toFixed(1)}px)`);
      css(htL, "opacity", clamp(1 - hk * 1.3, 0, 1).toFixed(3));
      css(htR, "opacity", clamp(1 - hk * 1.3, 0, 1).toFixed(3));
      css(hFoot, "transform", `translateY(${(-hk * 80).toFixed(1)}px)`);
      css(hFoot, "opacity", clamp(1 - hk * 1.6, 0, 1).toFixed(3));
      css(now, "opacity", clamp(1 - hk * 3, 0, 1).toFixed(3));
      css(cue, "opacity", clamp(1 - hk * 4, 0, 1).toFixed(3));
      hero.classList.toggle("away", hk > 0.5);
      // The body (not the box with room for props) lands exactly on the brand's penguin.
      const br = brandMk.getBoundingClientRect();
      const end = br.width / (base.w * 0.727), dx = -0.021 * base.w, dy = 0.072 * base.w;
      const sc = mix(1, end, easeOut(hk));
      const tx = (br.left + br.width / 2 - base.x - end * dx) * he;
      const ty = Math.max((br.top + br.height / 2 - (base.y - y) - end * dy) * he, br.top + br.height / 2 - (base.y - y) - sc * dy);
      css(hpg, "transform", `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${sc.toFixed(4)})`);
      css(hpg, "visibility", hk >= 1 ? "hidden" : "visible");
      css(props, "opacity", clamp(1 - he * 2.5, 0, 1).toFixed(3));
      // It faces the pointer and leans a little toward it; on the way up it straightens out.
      const face = mx >= 0 && mx < base.x - 20 && he < 0.3 ? -1 : 1;
      const lean = (1 - he) * clamp(px * 16, -10, 10);
      css(look, "transform", `translate(${((1 - he) * px * 24).toFixed(1)}px, ${((1 - he) * py * 14).toFixed(1)}px) rotate(${lean.toFixed(2)}deg) scaleX(${face})`);
    }

    let ch = -1;
    for (const sc of scenes) {
      sc.read(y);
      if (sc.step(dt)) busy = true;
      if (sc.visible) sc.frame();
      if (sc.visible && y + VH * 0.5 >= sc.top && y + VH * 0.5 < sc.top + sc.h) ch = scenes.indexOf(sc);
    }
    if (keys.visible) keys.lean();
    if (y !== lastY) {
      lastY = y;
      const a = agent.top, b = free.top + free.h - VH;
      css(chBar, "transform", `scaleX(${clamp((y - a) / (b - a), 0, 1).toFixed(4)})`);
      css(grid, "opacity", clamp((y - VH * 0.4) / (VH * 0.5), 0, 1).toFixed(3));
      css(gridI, "transform", `translate3d(0, ${(-((y * 0.12) % 40)).toFixed(1)}px, 0)`);
      dock.classList.toggle("on", y > VH * 0.6 && close.getBoundingClientRect().top > VH * 0.6);
      const cr = colony.getBoundingClientRect(), p = (innerHeight - cr.top) / (innerHeight + cr.height);
      if (p > -0.2 && p < 1.2) birds.forEach((bd) => css(bd, "transform", `translateX(${((clamp(p, 0, 1) - 0.5) * drift * Number(bd.dataset.d)).toFixed(1)}px)`));
    }
    setChapter(ch);
    const nr = nav.getBoundingClientRect();
    nav.classList.toggle("inv", free.covers(nr.left + nr.width / 2, nr.top + nr.height / 2));
    if (busy) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  layout();
  let lastW = innerWidth, lastH = innerHeight;
  addEventListener(
    "resize",
    () => {
      // A phone's address bar showing or hiding changes only the height a little: keep the layout.
      if (innerWidth === lastW && Math.abs(innerHeight - lastH) < 160 && matchMedia("(pointer: coarse)").matches) return;
      lastW = innerWidth;
      lastH = innerHeight;
      layout();
    },
    on,
  );
  addEventListener("scroll", wake, on);
  document.fonts?.ready.then(() => !ac.signal.aborted && layout());
  const ro = new ResizeObserver(() => {
    scenes.forEach((s) => s.measure());
    layoutColony();
    wake();
  });
  ro.observe(document.body);

  return () => {
    ac.abort();
    io.disconnect();
    ro.disconnect();
    cancelAnimationFrame(raf);
    root.removeAttribute("data-story");
  };
}
