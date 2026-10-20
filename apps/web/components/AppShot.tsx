"use client";

import { useEffect, useRef } from "react";
import { Shot } from "./Shot";
import { Pg } from "./Pg";

/** The agent's limits (crates/rowkery-mcp/src/guard.rs and lib.rs), counted up as they come into view. */
const STATS: { to: number; unit?: string; label: string }[] = [
  { to: 1000, label: "rows at most per agent query" },
  { to: 10, unit: "s", label: "agent query time limit" },
  { to: 0, label: "accounts to make" },
  { to: 1, label: "click to connect Claude" },
];

/**
 * The real app window, tilting upright as it scrolls in, then the numbers, then a penguin
 * belly-sliding across the ice. The numbers are written in full, so without scripts (or with
 * Reduce Motion) they simply show.
 */
export function AppShot() {
  const frame = useRef<HTMLDivElement>(null);
  const stats = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = frame.current!;
    let queued = false;
    const tilt = () => {
      queued = false;
      const r = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight * 0.9)));
      el.style.transform = p === 1 ? "" : `perspective(1400px) rotateX(${(1 - p) * 9}deg) scale(${0.92 + p * 0.08})`;
    };
    const onScroll = () => {
      if (!queued) requestAnimationFrame(tilt);
      queued = true;
    };
    tilt();
    addEventListener("scroll", onScroll, { passive: true });

    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      stats.current!.querySelectorAll<HTMLElement>("[data-count]").forEach((b) => {
        const to = Number(b.dataset.count), text = b.firstChild!, t0 = performance.now();
        const step = (t: number) => {
          const k = Math.min(1, (t - t0) / 1200);
          text.nodeValue = Math.round(to * (1 - (1 - k) ** 3)).toLocaleString("en-US");
          if (k < 1) requestAnimationFrame(step);
        };
        if (to > 1) requestAnimationFrame(step);
      });
    });
    io.observe(stats.current!);
    return () => {
      removeEventListener("scroll", onScroll);
      io.disconnect();
    };
  }, []);
  return (
    <section className="shot">
      <div className="shot-frame" ref={frame}>
        <Shot name="window" alt="The Rowkery window: a storefront database with the orders table open" />
      </div>
      <div className="stats" ref={stats} data-stats>
        {STATS.map((s) => (
          <div className="stat" key={s.label}>
            <b data-count={s.to}>
              {s.to.toLocaleString("en-US")}
              {s.unit && <small>{s.unit}</small>}
            </b>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <div className="ice" aria-hidden="true">
        <div className="slider">
          <span className="lines">
            <i />
            <i />
            <i />
          </span>
          <Pg />
        </div>
      </div>
    </section>
  );
}
