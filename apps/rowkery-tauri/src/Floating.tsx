import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * A popover's layer above every column (2026-10-13: the switch
 * connection picker was clipped by the Agents page and the inspector, which
 * stack over the schema column). Portals its children to the app frame as
 * a fixed box over `anchor`, so a popover's own `top: calc(100% + 6px)` /
 * `left` still place it under its chip, and shifts it left if its right
 * edge would leave the window. `layerRef` lets an outside-click check count
 * clicks inside the portalled popover as inside.
 */
export function Floating({
  anchor,
  layerRef,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  layerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = layerRef ?? ownRef;
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setBox((b) =>
        b && b.left === r.left && b.top === r.top && b.width === r.width && b.height === r.height
          ? b
          : { left: r.left, top: r.top, width: r.width, height: r.height },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  useLayoutEffect(() => {
    const pop = ref.current?.querySelector<HTMLElement>(":scope > * > *, :scope > *");
    if (!pop) return;
    const r = pop.getBoundingClientRect();
    const over = r.right - shift - (window.innerWidth - 8);
    const next = over > 0 ? -Math.ceil(over) : 0;
    if (next !== shift) setShift(next);
  });
  const host = (anchor.current?.closest(".app-frame") as HTMLElement | null) ?? document.body;
  if (!box) return null;
  return createPortal(
    <div
      ref={ref}
      data-floating
      className="floating"
      style={{ left: box.left + shift, top: box.top, width: box.width, height: box.height }}
    >
      {children}
    </div>,
    host,
  );
}
