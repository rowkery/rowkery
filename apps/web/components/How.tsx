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
    let at = 0;
    let run = 0;
    let inView = false;
    let anim: Animation | null = null;
    let timers: number[] = [];

    const fill = (bar: HTMLElement, ms: number) =>
      bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: ms, easing: "linear", fill: "forwards" });

    const stop = () => {
      run++;
      timers.forEach(clearTimeout);
      timers = [];
      anim?.cancel();
      anim = null;
      slides.forEach((_, i) => clip(i)?.pause());
    };

    const start = () => {
      const token = run;
      const v = clip(at);
      if (!v) {
        beats.forEach((b) => b.classList.remove("in"));
        timers = beats.map((b) => window.setTimeout(() => b.classList.add("in"), Number(b.dataset.at)));
        anim = fill(bars[at], CHAT_MS);
        anim.onfinish = () => token === run && show((at + 1) % slides.length);
        return;
      }
      v.preload = "auto";
      const go = () => {
        if (token !== run) return;
        v.currentTime = 0;
        anim = fill(bars[at], v.duration * 1000);
        anim.pause();
        v.play().catch(() => {});
      };
      if (v.readyState >= 1) go();
      else v.addEventListener("loadedmetadata", go, { once: true });
    };

    const show = (i: number) => {
      stop();
      at = i;
      slides.forEach((s, j) => s.classList.toggle("on", j === i));
      caps.forEach((c, j) => c.classList.toggle("on", j === i));
      dots.forEach((d, j) => d.toggleAttribute("aria-current", j === i));
      bars.forEach((b, j) => (b.style.transform = `scaleX(${j < i || still ? 1 : 0})`));
      if (still) return;
      // The next clip starts loading while this step plays.
      const next = clip((i + 1) % slides.length);
      if (next && next.preload === "none") next.preload = "metadata";
      if (inView) start();
    };

    // A clip's bar follows the clip: it waits while the clip buffers and the step ends when the clip does.
    slides.forEach((_, i) => {
      const v = clip(i);
      if (!v) return;
      v.addEventListener("playing", () => {
        if (i !== at || !anim) return;
        anim.currentTime = v.currentTime * 1000;
        anim.play();
      });
      v.addEventListener("waiting", () => i === at && anim?.pause());
      v.addEventListener("ended", () => i === at && inView && show((i + 1) % slides.length));
    });

    const picks = dots.map((d, i) => {
      const pick = () => show(i);
      d.addEventListener("click", pick);
      return pick;
    });

    if (still) {
      beats.forEach((b) => b.classList.add("in"));
      slides.forEach((_, i) => clip(i)?.setAttribute("controls", ""));
    }
    show(0);

    // Plays while at least a third of it is on screen; scrolled away it stops, and it starts the step again on return.
    const io = new IntersectionObserver(
      ([e]) => {
        inView = e.isIntersecting;
        if (still) return;
        if (inView) show(at);
        else stop();
      },
      { threshold: 0.35 },
    );
    io.observe(root.querySelector("[data-stage]")!);

    return () => {
      io.disconnect();
      stop();
      dots.forEach((d, i) => d.removeEventListener("click", picks[i]));
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
                    Three customers ordered this week. Ana Lima spent the most, $412 across two orders.
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
          <div className="pager" aria-label="Steps">
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
