"use client";

import { useEffect, useRef } from "react";
import { Pg } from "./Pg";

/** The three steps, in the site's order: your agent, then security, then the keyboard. */
const STEPS = [
  { title: "Ask your agent", text: "It reads your tables through Rowkery and answers in plain words." },
  { title: "Say yes before anything changes", text: "Agents can only read. A change they suggest waits in Rowkery until you commit it." },
  { title: "Or do it yourself", text: "Press ⌘K to open any table, query or command from the keyboard." },
];

/** How long the drawn chat step plays; the clips play for their own length. */
const CHAT_MS = 7200;

const ROWS = [
  ["Ana Lima", "Lisbon", "$412.00"],
  ["Kenji Mori", "Osaka", "$186.50"],
  ["Sam Okafor", "Lagos", "$94.20"],
];

/**
 * How it works: one orange stage that plays the steps in turn while it's on screen. The first is
 * drawn (the agent's chat lives in Claude, not in Rowkery); the other two are clips of the real
 * app. Each pager bar fills as its step plays and a step ends the moment its clip does. Bars and
 * chat lines move by transform and opacity only, from Web Animations and class switches, so the
 * page never lays out or paints for them. Under Reduce Motion nothing plays by itself: the chat
 * shows whole and the clips get their controls.
 */
export function How() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current!;
    const slides = [...root.querySelectorAll<HTMLElement>("[data-slide]")];
    const caps = [...root.querySelectorAll<HTMLElement>("[data-cap]")];
    const dots = [...root.querySelectorAll<HTMLButtonElement>("[data-dot]")];
    const bars = dots.map((d) => d.firstElementChild as HTMLElement);
    const beats = [...slides[0].querySelectorAll<HTMLElement>("[data-at]")];
    const clip = (i: number) => slides[i].querySelector("video");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const off = new AbortController();
    const on = { signal: off.signal };
    let at = 0;
    let run = 0;
    // On screen in a visible tab; the steps play only while this holds.
    let inView = false;
    let live = false;
    // The current step has started and can resume where it stopped.
    let begun = false;
    // The clip was playing (or about to) when it was scrolled away.
    let rolling = false;
    let anim: Animation | null = null;
    let timers: number[] = [];
    let dog = 0;

    const fill = (bar: HTMLElement, ms: number) =>
      bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: ms, easing: "linear", fill: "forwards" });
    const next = () => show((at + 1) % slides.length);

    const stop = () => {
      run++;
      begun = false;
      timers.forEach(clearTimeout);
      timers = [];
      clearTimeout(dog);
      anim?.cancel();
      anim = null;
      slides.forEach((_, i) => clip(i)?.pause());
    };

    // A clip that won't play (autoplay refused, as in Low Power Mode, or a failed load) gets its
    // controls and the step moves on after the chat's time, so the steps never stall on it.
    const fallback = (v: HTMLVideoElement) => {
      clearTimeout(dog);
      v.controls = true;
      anim?.cancel();
      anim = fill(bars[at], CHAT_MS);
      const token = run;
      anim.onfinish = () => token === run && next();
    };
    const play = (v: HTMLVideoElement) => {
      const token = run;
      v.play().catch(() => token === run && live && clip(at) === v && fallback(v));
    };

    const start = () => {
      begun = true;
      const token = run;
      const v = clip(at);
      if (!v) {
        beats.forEach((b) => b.classList.remove("in"));
        timers = beats.map((b) => window.setTimeout(() => b.classList.add("in"), Number(b.dataset.at)));
        anim = fill(bars[at], CHAT_MS);
        anim.onfinish = () => token === run && next();
        return;
      }
      v.preload = "auto";
      if (v.readyState >= 1) v.currentTime = 0;
      play(v);
      // Slow to start is fine (the bar waits for it); never starting is not.
      dog = window.setTimeout(() => token === run && !anim && fallback(v), 5000);
    };

    const show = (i: number) => {
      stop();
      at = i;
      slides.forEach((s, j) => (s.inert = j !== i));
      slides.forEach((s, j) => s.classList.toggle("on", j === i));
      caps.forEach((c, j) => {
        c.classList.toggle("on", j === i);
        c.inert = j !== i;
      });
      dots.forEach((d, j) => (j === i ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current")));
      bars.forEach((b, j) => (b.style.transform = `scaleX(${j < i || (still && j === i) ? 1 : 0})`));
      if (!live) return;
      // The next clip starts loading while this step plays.
      const after = clip((i + 1) % slides.length);
      if (after && after.preload === "none") after.preload = "metadata";
      start();
    };

    // Scrolled away or in a hidden tab, a clip pauses where it is and picks up from there on
    // return; the chat, being short, starts over.
    const sync = () => {
      const now = !still && inView && !document.hidden;
      if (now === live) return;
      live = now;
      const v = clip(at);
      if (live) {
        if (!begun) show(at);
        else if (v && rolling) play(v);
        else anim?.play();
      } else if (v && begun) {
        clearTimeout(dog);
        rolling = !v.paused;
        v.pause();
        anim?.pause();
      } else stop();
    };

    // A clip's bar follows the clip: it waits while the clip buffers and the step ends when the clip does.
    slides.forEach((_, i) => {
      const v = clip(i);
      if (!v) return;
      v.addEventListener(
        "playing",
        () => {
          if (i !== at || !live) return;
          clearTimeout(dog);
          anim?.cancel();
          anim = fill(bars[at], v.duration * 1000);
          anim.currentTime = v.currentTime * 1000;
        },
        on,
      );
      v.addEventListener("waiting", () => i === at && anim?.pause(), on);
      // Paused by something other than this (the system, say): don't sit on it.
      v.addEventListener("pause", () => i === at && live && v.paused && !v.ended && !v.controls && fallback(v), on);
      v.addEventListener("error", () => i === at && live && fallback(v), on);
      v.addEventListener("ended", () => i === at && live && next(), on);
    });

    dots.forEach((d, i) => d.addEventListener("click", () => show(i), on));
    document.addEventListener("visibilitychange", sync, on);

    if (still) {
      beats.forEach((b) => b.classList.add("in"));
      slides.forEach((_, i) => clip(i)?.setAttribute("controls", ""));
    }
    show(0);

    // Plays while at least a third of it is on screen.
    const io = new IntersectionObserver(
      (es) => {
        inView = es[es.length - 1].isIntersecting;
        sync();
      },
      { threshold: 0.35 },
    );
    io.observe(root.querySelector("[data-stage]")!);

    return () => {
      io.disconnect();
      off.abort();
      stop();
    };
  }, []);

  return (
    <section className="sec wrap" id="how" ref={ref}>
      <div className="col">
        <h2 className="rv">How Rowkery works</h2>
        <div className="panel rv">
          <div className="stage" data-stage>
            <div className="slide on" data-slide>
              <div className="chat-win" role="img" aria-label="Claude asks Rowkery which customers ordered this week and answers from the rows">
                <div className="chat-bar">
                  <i />
                  <i />
                  <i />
                  <span>Claude</span>
                </div>
                <div className="chat">
                  <div className="me" data-at="300">
                    Which customers ordered this week?
                  </div>
                  <div className="tool" data-at="1300">
                    <Pg tight />
                    <span>rowkery · query · orders</span>
                    <span className="ms">12 ms</span>
                  </div>
                  <div className="tbl">
                    <div data-at="1800">
                      <span>customer</span>
                      <span className="city">city</span>
                      <span className="n">total</span>
                    </div>
                    {ROWS.map(([name, city, total], i) => (
                      <div data-at={2000 + i * 160} key={name}>
                        <span>{name}</span>
                        <span className="city">{city}</span>
                        <span className="n">{total}</span>
                      </div>
                    ))}
                  </div>
                  <p className="ans" data-at="3000">
                    Ana Lima spent the most this week, $412 across two orders.
                  </p>
                </div>
              </div>
            </div>
            <div className="slide" data-slide>
              <video
                className="clip"
                src="/clips/agent-review.mp4"
                poster="/clips/agent-review.jpg"
                width={1180}
                height={700}
                muted
                playsInline
                preload="none"
                aria-label="Claude Code suggests marking two orders refunded; you open it, try a dry run and commit, and the orders show refunded"
              />
            </div>
            <div className="slide" data-slide>
              <video
                className="clip"
                src="/clips/command-k.mp4"
                poster="/clips/command-k.jpg"
                width={1100}
                height={640}
                muted
                playsInline
                preload="none"
                aria-label="Pressing ⌘K, typing cust and opening the customers table"
              />
            </div>
          </div>
        </div>
        <div className="cap">
          <div className="txt">
            {STEPS.map((s, i) => (
              <div className={i === 0 ? "t on" : "t"} data-cap key={s.title}>
                <b>{s.title}</b>
                <span>{s.text}</span>
              </div>
            ))}
          </div>
          <div className="pager" role="group" aria-label="Steps">
            {STEPS.map((s) => (
              <button type="button" data-dot aria-label={s.title} key={s.title}>
                <i />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
