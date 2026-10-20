"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadButton } from "../Download";
import { Pg } from "../Pg";
import "./rookery.css";

/**
 * The close: where the name comes from, and a colony of penguins under falling snow, each
 * drifting at its own pace as the page scrolls (one orange, in a party hat). Tap the colony
 * and a hop runs through it; type "rookery" anywhere and a parade crosses the bottom of the
 * screen. Reduce Motion keeps them all still.
 */
const FLOCK: [x: number, h: number, look: "" | "fg" | "me", drift: number][] = [
  [4, 64, "", 0.5],
  [12, 104, "", -0.3],
  [22, 72, "fg", 0.7],
  [33, 140, "", -0.15],
  [46, 178, "me", 0],
  [60, 92, "fg", 0.35],
  [69, 126, "", -0.45],
  [80, 70, "", 0.6],
  [90, 112, "fg", -0.25],
];
const FLAKES = 28;

export function Rookery() {
  const colony = useRef<HTMLDivElement>(null);
  const [parades, setParades] = useState<number[]>([]);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = colony.current!;
    const birds = [...el.querySelectorAll<HTMLElement>(".bird")];
    let queued = false;
    const drift = () => {
      queued = false;
      const r = el.getBoundingClientRect(), p = (innerHeight - r.top) / (innerHeight + r.height);
      if (p < -0.2 || p > 1.2) return;
      for (const b of birds) b.style.translate = `${(p - 0.5) * 160 * Number(b.dataset.drift)}px 0`;
    };
    const onScroll = () => {
      if (!queued) requestAnimationFrame(drift);
      queued = true;
    };
    drift();
    addEventListener("scroll", onScroll, { passive: true });

    let typed = "";
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      typed = (typed + e.key.toLowerCase()).slice(-7);
      if (typed !== "rookery") return;
      typed = "";
      const id = Date.now();
      setParades((ps) => [...ps, id]);
      setTimeout(() => setParades((ps) => ps.filter((p) => p !== id)), 11500);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("keydown", onKey);
    };
  }, []);
  const hop = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    colony.current!.querySelectorAll(".bird .pg").forEach((pg, i) =>
      pg.animate([{ transform: "translateY(0)" }, { transform: "translateY(-30px)" }, { transform: "translateY(0)" }], { duration: 520, delay: i * 70, easing: "cubic-bezier(.3,.7,.4,1)" }),
    );
  };
  return (
    <section className="band rookery">
      <div className="snow" aria-hidden="true">
        {Array.from({ length: FLAKES }, (_, i) => (
          // Spread across the band and through their loop, so no two fall in step.
          <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `-${(i * 2.3) % 18}s` }} />
        ))}
      </div>
      <h2 className="h2">
        <span className="ln">The name comes from rookery</span>
        <span className="ln">a colony of penguins</span>
      </h2>
      <p className="lead">Rowkery is one of them. Say hello.</p>
      <div className="ctas">
        <DownloadButton />
      </div>
      <div className="colony" ref={colony} onClick={hop} aria-hidden="true" data-colony>
        {FLOCK.map(([x, h, look, d], i) => (
          <span className={`bird${look ? ` ${look}` : ""}`} key={x} data-drift={d} style={{ left: `${x}%`, ["--h" as string]: `${h}px` }}>
            <Pg tight prop={look === "me" ? "hat" : undefined} className={i % 3 === 1 ? "flip" : undefined} />
          </span>
        ))}
      </div>
      {parades.map((id) => (
        <div className="parade" key={id} aria-hidden="true">
          {Array.from({ length: 11 }, (_, i) => (
            <div className="marcher" key={i} style={{ animationDelay: `${i * 0.32}s` }}>
              <Pg prop={i === 5 ? "hat" : undefined} />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
