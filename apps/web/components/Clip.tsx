"use client";

import { useEffect, useRef } from "react";

/**
 * A short clip of the real app (public/clips, filmed in the app's light theme) that loops while
 * it's on screen and stops when scrolled away. It loads only once it comes near. Under Reduce
 * Motion it stays on its poster with controls, so it plays only when asked.
 */
export function Clip({ name, w, h, label }: { name: string; w: number; h: number; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current!;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      v.controls = true;
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          v.preload = "auto";
          v.play().catch(() => {});
        } else v.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return <video ref={ref} className="clip" src={`/clips/${name}.mp4`} poster={`/clips/${name}.jpg`} width={w} height={h} muted loop playsInline preload="none" aria-label={label} />;
}
