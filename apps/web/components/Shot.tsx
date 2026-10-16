import type { CSSProperties } from "react";
import { SHOTS, type ShotName } from "@/lib/shots";

/** A real app screen at its size in CSS pixels; `eager` for the one above the fold. */
export function Shot({ name, alt, eager, style }: { name: ShotName; alt: string; eager?: boolean; style?: CSSProperties }) {
  const { src, width, height } = SHOTS[name];
  return (
    <img
      src={src}
      width={width}
      height={height}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      decoding="async"
      style={style}
    />
  );
}
