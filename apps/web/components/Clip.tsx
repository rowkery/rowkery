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
    // Starts loading a screen ahead; plays while 40% shows. A clip that can't autoplay (Low Power
    // Mode, say) gets its controls instead.
    const near = new IntersectionObserver(
      (es) => {
        if (!es[es.length - 1].isIntersecting) return;
        v.preload = "auto";
        near.disconnect();
      },
      { rootMargin: "300px 0px" },
    );
    const io = new IntersectionObserver(
      (es) => {
        if (es[es.length - 1].isIntersecting) v.play().catch(() => (v.controls = true));
        else v.pause();
      },
      { threshold: 0.4 },
    );
    near.observe(v);
    io.observe(v);
    return () => {
      near.disconnect();
      io.disconnect();
    };
  }, []);

  return <video ref={ref} className="clip" src={`/clips/${name}.mp4`} poster={`/clips/${name}.jpg`} width={w} height={h} muted loop playsInline preload="none" aria-label={label} />;
}
