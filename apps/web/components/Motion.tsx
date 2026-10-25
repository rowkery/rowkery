"use client";

import { useEffect } from "react";

/**
 * The page's one entrance: each `.rv` block rises into place the first time it scrolls into
 * view (opacity and transform only, once). The head script in app/layout.tsx marks the page
 * `data-js` before the first paint so the blocks start lowered; this marks it `data-ready`, and
 * without that mark (the page's scripts failed) the head script shows everything after a while.
 */
export function Motion() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }),
      { rootMargin: "0px 0px -6% 0px" },
    );
    document.querySelectorAll(".rv").forEach((el) => io.observe(el));
    document.documentElement.setAttribute("data-ready", "");
    return () => io.disconnect();
  }, []);
  return null;
}
