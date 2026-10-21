"use client";

import { useEffect, useRef, useState } from "react";
import { Pg } from "./Pg";

/**
 * The rookery the name comes from: penguins on the ice under the close, spread with even gaps
 * (fewer and smaller on a phone) and drifting a little as the page scrolls (engine.ts caps the
 * drift below the gap, so none ever covers another). The orange one is Rowkery. Tap the colony
 * and a hop runs through it; type "rookery" anywhere and a parade crosses the foot of the
 * screen. Reduce Motion keeps them all still.
 */
const FLOCK: [h: number, drift: number][] = [
  [52, 0.5],
  [84, -0.3],
  [60, 0.7],
  [112, -0.15],
  [140, 0],
  [74, 0.35],
  [100, -0.45],
  [58, 0.6],
  [92, -0.25],
];
const ME = 4;
/** The birds a phone keeps. */
const PHONE = new Set([1, 3, 4, 6, 8]);

export function Colony() {
  const colony = useRef<HTMLDivElement>(null);
  const [parades, setParades] = useState<number[]>([]);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    let typed = "";
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      typed = (typed + e.key.toLowerCase()).slice(-7);
      if (typed !== "rookery" || still()) return;
      typed = "";
      const id = Date.now();
      setParades((ps) => [...ps, id]);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const hop = () => {
    if (still()) return;
    colony.current!.querySelectorAll(".bird:not(.off) .pg").forEach((pg, i) =>
      pg.animate([{ transform: "translateY(0)" }, { transform: "translateY(-30px)" }, { transform: "translateY(0)" }], { duration: 520, delay: i * 70, easing: "cubic-bezier(.3,.7,.4,1)" }),
    );
  };
  return (
    <>
      <div className="colony-box">
        <div className="colony" ref={colony} onClick={hop} aria-hidden="true" data-colony>
          {FLOCK.map(([h, d], i) => (
            <span className={`bird${i === ME ? " me" : ""}${PHONE.has(i) ? "" : " wide-only"}`} key={i} data-d={d} data-pg={`bird-${i}`} style={{ ["--h" as string]: h }}>
              <Pg tight />
            </span>
          ))}
        </div>
      </div>
      {parades.map((id) => (
        <div className="parade" key={id} aria-hidden="true" onAnimationEnd={(e) => e.animationName === "march" && e.target === e.currentTarget.lastElementChild && setParades((ps) => ps.filter((p) => p !== id))}>
          {Array.from({ length: 11 }, (_, i) => (
            <div className="marcher" key={i} style={{ animationDelay: `${i * 0.32}s` }}>
              <Pg prop={i === 5 ? "hat" : undefined} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
