"use client";

import { useEffect } from "react";

/**
 * Each .reveal block rises in once, as it comes into view. The layout's boot script marks the
 * page .js before first paint, which is what holds the blocks back; this marks the page live
 * (so the boot script keeps that mark) and lets each block in. It also pauses each card's loops
 * while the card is off screen.
 */
export function Reveal() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.live = "";
    if (!root.classList.contains("js")) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    // The cards' loops pause while their card is off screen, so a page sitting still only
    // plays what is in view.
    const loops = new IntersectionObserver((entries) => {
      for (const e of entries) e.target.toggleAttribute("data-off", !e.isIntersecting);
    });
    document.querySelectorAll(".card, .marquee").forEach((el) => loops.observe(el));
    return () => {
      io.disconnect();
      loops.disconnect();
    };
  }, []);
  return null;
}
