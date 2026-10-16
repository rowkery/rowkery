// Drives the real Rowkery app for the end-to-end suites: launches a binary
// built with `--features e2e` (src-tauri/src/e2e.rs), talks to its socket, and
// watches it. A crash is the process ending on its own or a new
// `rowkery-tauri*.ips` report; a hang is the page not answering within the step's
// timeout, captured with `sample <pid>`. Page errors (window.onerror, unhandled
// rejections, console.error) are collected from the moment the driver attaches.
//
// Clicks and keys are DOM events built like the real ones (pointer and mouse
// events at the element's centre; keydown/keyup with `code`, which is what
// commands.ts matches). They don't pass through macOS: the menu bar,
// accelerators and system dialogs are the computer-use pass's job.
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPORTS = join(homedir(), "Library/Logs/DiagnosticReports");
/** WebKit web processes started at most `ageS` seconds ago: [{ pid, rssKb }]. macOS ps prints etime as [[dd-]hh:]mm:ss. */
function webContentProcesses(ageS) {
  const seconds = (t) => {
    const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
    const p = rest.split(":").map(Number);
    while (p.length < 3) p.unshift(0);
    return Number(d) * 86_400 + p[0] * 3600 + p[1] * 60 + p[2];
  };
  return execFileSync("ps", ["-axo", "pid=,rss=,etime=,command="])
    .toString()
    .split("\n")
    .map((r) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+.*WebKit\.WebContent/.exec(r))
    .filter((m) => m && seconds(m[3]) <= ageS)
    .map((m) => ({ pid: Number(m[1]), rssKb: Number(m[2]) }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page-side helpers, installed once per page load as `window.__e2e`. */
const PAGE_HELPERS = String.raw`
if (!window.__e2e) {
  const errors = [];
  // Counted apart: WebKit's notice that a ResizeObserver callback resized what it observes (the
  // layout settles a frame later). The soak expects none; sites names the observers whose
  // callbacks ran in that frame (those created after this script; none listed means an earlier one).
  const benign = { resizeObserverLoop: 0, sites: [] };
  const roRecent = [];
  const NativeRO = window.ResizeObserver;
  window.ResizeObserver = class extends NativeRO {
    constructor(cb) {
      const site = (new Error().stack || "").split("\n").slice(1, 3).join(" < ");
      super((entries, obs) => {
        roRecent.push({ site, at: performance.now() });
        if (roRecent.length > 20) roRecent.shift();
        return cb(entries, obs);
      });
    }
  };
  const keep = (kind, text) => {
    if (/ResizeObserver loop/.test(String(text))) {
      const now = performance.now();
      if (benign.sites.length < 10) benign.sites.push(roRecent.filter((r) => now - r.at < 50).map((r) => r.site));
      return void benign.resizeObserverLoop++;
    }
    if (errors.length < 200) errors.push({ kind, text: String(text).slice(0, 2000), at: Date.now() });
  };
  window.addEventListener("error", (e) => keep("error", (e.error && e.error.stack) || e.message));
  window.addEventListener("unhandledrejection", (e) => keep("rejection", (e.reason && e.reason.stack) || e.reason));
  const consoleError = console.error.bind(console);
  console.error = (...args) => { keep("console", args.map((a) => (a && a.stack) || String(a)).join(" ")); consoleError(...args); };

  // Runs, from the results header: each time a "Running" header appears
  // (started) and goes (done). Tauri's invoke can't be wrapped, and a fast
  // query shows its running header for at least one commit, which the
  // observer sees even when no frame paints it.
  const runs = { started: 0, done: 0 };
  let running = false;
  const RUNNING = '[data-testid="card-meta"][data-state="running"]';
  new MutationObserver(() => {
    const now = !!document.querySelector(RUNNING);
    if (now && !running) runs.started++;
    if (!now && running) runs.done++;
    running = now;
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });

  // Hidden windows stay in the DOM: a selector means the first match that
  // shows, else the first match at all.
  const first = (sel) => {
    const all = document.querySelectorAll(sel);
    for (const el of all) if (visible(el)) return el;
    return all[0] || null;
  };
  const q = (sel) => {
    const el = typeof sel === "string" ? first(sel) : sel;
    if (!el) throw new Error("no element " + sel);
    return el;
  };
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
  }
  const centre = (el) => {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  // What a real pointer at the element's centre hits: the deepest element
  // there when it belongs to the target, else the target itself.
  const hit = (el, at) => {
    const top = document.elementFromPoint(at.x, at.y);
    return top && el.contains(top) ? top : el;
  };
  const mods = (m = "") => ({
    metaKey: /Mod|Meta/.test(m),
    ctrlKey: /Ctrl/.test(m),
    altKey: /Alt/.test(m),
    shiftKey: /Shift/.test(m),
  });
  const fire = (el, type, init) => {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }));
  };
  const focusable = (el) => el.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable=true]");
  const press = (el, at, button, m, detail) => {
    const init = { clientX: at.x, clientY: at.y, button, buttons: button === 2 ? 2 : 1, detail, ...mods(m) };
    fire(el, "pointerdown", init);
    if (fire(el, "mousedown", init)) focusable(el)?.focus?.();
    fire(el, "pointerup", { ...init, buttons: 0 });
    fire(el, "mouseup", { ...init, buttons: 0 });
    return init;
  };
  const KEYS = {
    Enter: ["Enter", "Enter"], Escape: ["Escape", "Escape"], Esc: ["Escape", "Escape"], Backspace: ["Backspace", "Backspace"],
    Delete: ["Delete", "Delete"], Tab: ["Tab", "Tab"], Space: [" ", "Space"], " ": [" ", "Space"],
    Up: ["ArrowUp", "ArrowUp"], Down: ["ArrowDown", "ArrowDown"], Left: ["ArrowLeft", "ArrowLeft"], Right: ["ArrowRight", "ArrowRight"],
    Home: ["Home", "Home"], End: ["End", "End"], PageUp: ["PageUp", "PageUp"], PageDown: ["PageDown", "PageDown"], F2: ["F2", "F2"],
    ".": [".", "Period"], ",": [",", "Comma"], "/": ["/", "Slash"], "?": ["?", "Slash"], "[": ["[", "BracketLeft"], "]": ["]", "BracketRight"],
    "\x60": ["\x60", "Backquote"], "#": ["#", "Digit3"], "=": ["=", "Equal"], "-": ["-", "Minus"],
  };
  const keyOf = (k, shift) => {
    if (KEYS[k]) return KEYS[k];
    if (/^[a-z]$/i.test(k)) return [shift ? k.toUpperCase() : k.toLowerCase(), "Key" + k.toUpperCase()];
    if (/^\d$/.test(k)) return [k, "Digit" + k];
    throw new Error("unknown key " + k);
  };

  window.__e2e = {
    errors,
    benign,
    runs,
    q,
    visible,
    first,
    exists: (sel) => !!document.querySelector(sel),
    shown: (sel) => visible(first(sel)),
    count: (sel) => [...document.querySelectorAll(sel)].filter(visible).length,
    text: (sel) => q(sel).textContent.replace(/\s+/g, " ").trim(),
    texts: (sel) => [...document.querySelectorAll(sel)].filter(visible).map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    attr: (sel, name) => q(sel).getAttribute(name),
    value: (sel) => q(sel).value,
    active: () => {
      const a = document.activeElement;
      return a ? { tag: a.tagName, testid: a.getAttribute("data-testid"), cls: a.className } : null;
    },
    click(sel, opts) {
      opts = opts || {};
      const target = q(sel);
      const at = centre(target);
      const el = hit(target, at);
      const init = press(el, at, 0, opts.mods, 1);
      fire(el, "click", init);
      if (opts.double) {
        press(el, at, 0, opts.mods, 2);
        fire(el, "click", { ...init, detail: 2 });
        fire(el, "dblclick", { ...init, detail: 2 });
      }
    },
    rightClick(sel) {
      const target = q(sel);
      const at = centre(target);
      const el = hit(target, at);
      const init = press(el, at, 2, "", 1);
      fire(el, "contextmenu", init);
    },
    middleClick(sel) {
      const target = q(sel);
      const at = centre(target);
      const el = hit(target, at);
      const init = { clientX: at.x, clientY: at.y, button: 1, buttons: 4 };
      fire(el, "pointerdown", init); fire(el, "mousedown", init);
      fire(el, "pointerup", { ...init, buttons: 0 }); fire(el, "mouseup", { ...init, buttons: 0 });
      fire(el, "auxclick", { ...init, buttons: 0 });
    },
    hover(sel) {
      const target = q(sel);
      const at = centre(target);
      const el = hit(target, at);
      for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) fire(el, t, { clientX: at.x, clientY: at.y, buttons: 0 });
    },
    async drag(sel, dx, dy, steps, opts) {
      steps = steps || 8;
      opts = opts || {};
      const el = q(sel);
      const a = centre(el);
      const init = { clientX: a.x, clientY: a.y, button: 0, buttons: 1, ...mods(opts.mods) };
      fire(el, "pointerdown", init); fire(el, "mousedown", init);
      for (let i = 1; i <= steps; i++) {
        const p = { ...init, clientX: a.x + (dx * i) / steps, clientY: a.y + (dy * i) / steps };
        const over = document.elementFromPoint(p.clientX, p.clientY) || el;
        fire(over, "pointermove", p); fire(over, "mousemove", p);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const end = { ...init, clientX: a.x + dx, clientY: a.y + dy, buttons: 0 };
      const over = document.elementFromPoint(end.clientX, end.clientY) || el;
      fire(over, "pointerup", end); fire(over, "mouseup", end);
    },
    key(chord, sel) {
      const parts = chord.split("+");
      const k = parts.pop() || "+";
      const m = parts.join("+");
      const init = mods(m);
      const [key, code] = keyOf(k, init.shiftKey);
      const el = sel ? q(sel) : document.activeElement || document.body;
      const ev = { key, code, bubbles: true, cancelable: true, composed: true, ...init };
      const down = new KeyboardEvent("keydown", ev);
      const passed = el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent("keyup", ev));
      return passed;
    },
    // One key per "gap" ms (a quick typist is ~80 ms), each in its own task, so
    // a slow keystroke shows up as a long frame instead of hiding in a batch.
    async type(text, sel, gap) {
      if (sel) q(sel).focus();
      const el = document.activeElement;
      if (!el) throw new Error("nothing focused to type into");
      for (const ch of text) {
        const isNl = ch === "\n";
        const ev = { key: isNl ? "Enter" : ch, code: isNl ? "Enter" : "", bubbles: true, cancelable: true, composed: true };
        if (el.dispatchEvent(new KeyboardEvent("keydown", ev))) {
          document.execCommand("insertText", false, ch);
          el.dispatchEvent(new KeyboardEvent("keyup", ev));
        }
        await new Promise((r) => setTimeout(r, gap ?? 0));
      }
    },
    fill(sel, value) {
      const el = q(sel);
      el.focus();
      if (el.select) el.select(); else document.execCommand("selectAll");
      if (value === "") document.execCommand("delete");
      else document.execCommand("insertText", false, value);
    },
    invoke: (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    frames: {
      start() {
        this.gaps = []; this.running = true; let last = performance.now();
        const tick = (t) => { this.gaps.push(t - last); last = t; if (this.running) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      },
      stop() {
        this.running = false;
        const g = (this.gaps || []).slice(1);
        const sorted = [...g].sort((a, b) => a - b);
        return { frames: g.length, max: Math.round(sorted.at(-1) || 0), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0), over50: g.filter((x) => x > 50).length };
      },
    },
  };
}
return true;
`;

export class StepError extends Error {
  constructor(message, kind = "fail") {
    super(message);
    this.kind = kind; // fail | hang | crash
  }
}

export class App {
  /**
   * @param {{ bin: string, out: string, name: string, env?: Record<string,string>, configDir: string, port: number }} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.seq = 0;
    this.waiting = new Map();
    this.buffer = "";
    this.exited = null;
    this.quitting = false;
    this.hangs = [];
    this.log = join(o.out, `${o.name}.log`);
  }

  static async launch(o) {
    const app = new App(o);
    await app.start();
    return app;
  }

  async start() {
    mkdirSync(this.out, { recursive: true });
    this.startedAt = Date.now();
    const logLines = [];
    this.logLines = logLines;
    // App Nap would slow an app whose window is behind others.
    this.child = spawn(this.bin, ["-NSAppSleepDisabled", "YES"], {
      env: {
        ...process.env,
        ROWKERY_E2E_PORT: String(this.port),
        ROWKERY_CONFIG_DIR: this.configDir,
        ROWKERY_UPDATES: "0",
        ...this.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const s of [this.child.stdout, this.child.stderr]) s.on("data", (d) => logLines.push(d.toString()));
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal, at: Date.now() };
      // Appended: a suite relaunches after a crash, and the crashed run's
      // stderr (a panic's message) is the one worth keeping.
      appendFileSync(this.log, `--- launch ${new Date(this.startedAt).toISOString()} · exit ${signal ?? code}\n${logLines.join("")}`);
      for (const [, w] of this.waiting) w.reject(new StepError(this.quitting ? "app quit" : `the app exited (code ${code}, signal ${signal})`, this.quitting ? "fail" : "crash"));
      this.waiting.clear();
    });
    // The socket opens in setup; the page needs a moment more to answer.
    const until = Date.now() + 20_000;
    for (;;) {
      if (this.exited) throw new StepError(`the app exited during launch (code ${this.exited.code})`, "crash");
      try {
        await this.connect();
        await this.eval(PAGE_HELPERS, { timeout: 3000 });
        break;
      } catch (e) {
        this.socket?.destroy();
        this.socket = null;
        if (Date.now() > until) throw new StepError(`the page never answered: ${e.message}`, "hang");
        await sleep(250);
      }
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host: "127.0.0.1", port: this.port }, () => {
        this.socket = sock;
        resolve();
      });
      sock.on("error", reject);
      sock.on("data", (d) => {
        this.buffer += d.toString();
        let nl;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const w = this.waiting.get(msg.id);
          if (!w) continue;
          this.waiting.delete(msg.id);
          if (msg.ok) w.resolve(msg.value);
          else w.reject(new StepError(msg.error, /^timeout/.test(msg.error) ? "hang" : "fail"));
        }
      });
    });
  }

  /** Runs `body` (an async function body) in the page and returns its value. */
  async eval(body, { timeout = 10_000 } = {}) {
    if (this.exited) throw new StepError(`the app is gone (code ${this.exited.code})`, this.quitting ? "fail" : "crash");
    if (!this.socket || this.dead) throw new StepError("not connected");
    const id = ++this.seq;
    const reply = new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.socket.write(JSON.stringify({ id, js: body, timeout_ms: timeout }) + "\n");
    try {
      return await reply;
    } catch (e) {
      if (e.kind === "hang") this.captureHang(body);
      throw e;
    }
  }

  /** `__e2e.<fn>(...args)` in the page. */
  call(fn, ...args) {
    while (args.length && args.at(-1) === undefined) args.pop();
    return this.eval(`return await window.__e2e.${fn}(...${JSON.stringify(args)});`);
  }

  captureHang(body) {
    if (!this.child || this.exited) return;
    const file = join(this.out, `${this.name}-hang-${this.hangs.length + 1}.txt`);
    try {
      execFileSync("/usr/bin/sample", [String(this.child.pid), "2", "-file", file], { stdio: "ignore", timeout: 15_000 });
    } catch {
      /* sample is best effort */
    }
    // The page runs in WebKit's own process: sample the ones started with this app.
    try {
      for (const { pid } of webContentProcesses((Date.now() - this.startedAt) / 1000 + 2)) {
        execFileSync("/usr/bin/sample", [String(pid), "2", "-file", file.replace(/\.txt$/, `-webcontent-${pid}.txt`)], { stdio: "ignore", timeout: 15_000 });
      }
    } catch {
      /* best effort */
    }
    this.hangs.push({ file, step: body.slice(0, 200) });
  }

  /** Waits until `predicate` (a JS expression, `__e2e` in scope) is truthy; returns its value. */
  async until(predicate, { timeout = 5000, what = predicate } = {}) {
    const body = `
      const deadline = performance.now() + ${timeout};
      const e2e = window.__e2e;
      for (;;) {
        let v; try { v = (() => { const __e2e = e2e; return (${predicate}); })(); } catch (err) { v = undefined; }
        if (v) return v instanceof Node ? true : v;
        if (performance.now() > deadline) return { __timeout: true };
        await new Promise((r) => setTimeout(r, 40));
      }`;
    const v = await this.eval(body, { timeout: timeout + 3000 });
    if (v && v.__timeout) throw new StepError(`not within ${timeout} ms: ${what}`);
    return v;
  }

  waitFor(sel, { timeout = 5000 } = {}) {
    return this.until(`__e2e.shown(${JSON.stringify(sel)})`, { timeout, what: `${sel} shown` });
  }
  waitGone(sel, { timeout = 5000 } = {}) {
    return this.until(`!__e2e.shown(${JSON.stringify(sel)})`, { timeout, what: `${sel} gone` });
  }
  waitText(sel, re, { timeout = 5000 } = {}) {
    return this.until(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const t = el && el.textContent.replace(/\\s+/g, " ").trim(); return el && new RegExp(${JSON.stringify(re.source ?? re)}, ${JSON.stringify(re.flags ?? "")}).test(t) && t; })()`,
      { timeout, what: `${sel} text ${re}` },
    );
  }

  click(sel, opts) {
    return this.call("click", sel, opts);
  }
  rightClick(sel) {
    return this.call("rightClick", sel);
  }
  hover(sel) {
    return this.call("hover", sel);
  }
  drag(sel, dx, dy, steps, opts) {
    return this.call("drag", sel, dx, dy, steps, opts);
  }
  press(chord, sel) {
    return this.call("key", chord, sel);
  }
  type(text, sel, gap) {
    return this.eval(`return await window.__e2e.type(${JSON.stringify(text)}, ${JSON.stringify(sel ?? null)}, ${gap ?? 0});`, { timeout: 10_000 + text.length * ((gap ?? 0) + 50) });
  }
  fill(sel, value) {
    return this.call("fill", sel, value);
  }
  text(sel) {
    return this.call("text", sel);
  }
  texts(sel) {
    return this.call("texts", sel);
  }
  count(sel) {
    return this.call("count", sel);
  }
  shown(sel) {
    return this.call("shown", sel);
  }
  attr(sel, name) {
    return this.call("attr", sel, name);
  }
  /** A macOS menu-bar pick: the `menu-command` event the native menu sends (src-tauri app_menu). */
  menu(id) {
    return this.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-command", payload: ${JSON.stringify(id)} }); return true;`);
  }
  invoke(cmd, args) {
    return this.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`, { timeout: 30_000 });
  }
  /** Page errors collected since the helpers were installed (cleared when read). */
  async takeErrors() {
    return this.eval("const e = window.__e2e.errors.splice(0); return e;");
  }

  /** Reloads the webview (to pick up connections saved through `invoke`) and reinstalls the helpers. */
  async reload() {
    await this.eval("setTimeout(() => location.reload(), 10); return true;");
    await sleep(500);
    const until = Date.now() + 15_000;
    for (;;) {
      try {
        await this.eval(PAGE_HELPERS, { timeout: 2000 });
        await this.waitFor('[data-testid="workspace"], [data-testid="app-frame"]', { timeout: 10_000 });
        return;
      } catch (e) {
        if (Date.now() > until) throw e;
        await sleep(250);
      }
    }
  }

  rssMb() {
    if (!this.child || this.exited) return null;
    try {
      return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(this.child.pid)]).toString().trim()) / 1024);
    } catch {
      return null;
    }
  }

  /** WebKit's web process for this app (started with it), in MB; null when it can't be told apart. */
  webContentRssMb() {
    try {
      const mine = webContentProcesses((Date.now() - this.startedAt) / 1000 + 2);
      return mine.length === 1 ? Math.round(mine[0].rssKb / 1024) : null;
    } catch {
      return null;
    }
  }

  /** Crash reports macOS wrote for the app since it started. */
  crashReports() {
    // macOS moves a report to Retired/ once it has sent it.
    return [REPORTS, join(REPORTS, "Retired")]
      .filter((dir) => existsSync(dir))
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((f) => /rowkery-tauri|Rowkery/i.test(f) && f.endsWith(".ips"))
          .map((f) => join(dir, f)),
      )
      .filter((f) => statSync(f).mtimeMs >= this.startedAt - 1000);
  }

  /** Closes the main window, which quits the app (and flushes config.json). */
  async quit({ timeout = 10_000 } = {}) {
    if (this.exited) return this.exited;
    this.quitting = true;
    this.eval('window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); return true;', { timeout: 2000 }).catch(() => {});
    const until = Date.now() + timeout;
    while (!this.exited && Date.now() < until) await sleep(100);
    if (!this.exited) {
      this.child.kill("SIGKILL");
      await sleep(200);
      throw new StepError("the app didn't quit when its window closed", "hang");
    }
    this.socket?.destroy();
    return this.exited;
  }

  /** Kills the process and waits for it to be gone. */
  async kill() {
    this.quitting = true;
    this.dead = true;
    if (!this.exited) this.child.kill("SIGKILL");
    this.socket?.destroy();
    const until = Date.now() + 5000;
    while (!this.exited && Date.now() < until) await sleep(50);
  }
}
