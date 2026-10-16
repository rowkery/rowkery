"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A short looping screen recording (MP4 from scripts/docs-shots, 2x, no sound) in the same
 * rounded panel as a <Shot>. It plays only while on screen; with Reduce Motion on it stays on
 * its poster (the flow's end) with controls, so it starts only when asked.
 */
export function Clip({ src, poster, alt, width, height, caption }: { src: string; poster: string; alt: string; width: number; height: number; caption?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) {
      setStill(true);
      return;
    }
    const seen = new IntersectionObserver(([e]) => (e.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.25 });
    seen.observe(v);
    return () => seen.disconnect();
  }, []);
  return (
    <figure className="shot clip">
      <video ref={ref} src={src} poster={poster} width={width} height={height} muted loop playsInline preload="metadata" controls={still} aria-label={alt} data-testid="clip" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
