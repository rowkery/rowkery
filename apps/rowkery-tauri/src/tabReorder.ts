import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { reducedMotion } from "./motion";

/** Pixels the pointer travels before a press on a tab becomes a drag. */
const DRAG_THRESHOLD = 4;
const SETTLE_MS = 150;

interface DragState {
  key: string;
  from: number;
  to: number;
  startX: number;
  items: HTMLElement[];
  /** Left and right edges of each item when the drag began. */
  boxes: { left: number; width: number }[];
  step: number;
}

interface ReorderOptions {
  /** The row whose `[data-reorder-key]` children can be dragged. */
  track: RefObject<HTMLElement | null>;
  /** Keys in their current order; a change after a drop settles the tabs. */
  keys: string[];
  onReorder: (from: number, to: number) => void;
  /** A press became a drag. */
  onStart?: (key: string) => void;
  /** Every frame of a drag: the dragged tab's offset, null once it ends. */
  onMove?: (key: string, dx: number | null) => void;
  /** Which way the tabs run: a row (default) or a column. */
  axis?: "x" | "y";
}

/**
 * Drag tabs sideways (or up and down, with `axis: "y"`) to reorder them. The dragged tab follows the pointer and
 * its neighbours slide out of the way (CSS transitions on `.reordering`); on
 * drop the order is committed and every tab glides from where it was drawn to
 * its new slot. A press that never moves stays a plain click; one that became
 * a drag swallows the click that follows. Esc puts the tabs back.
 *
 * Tabs opt in with `data-reorder-key` and the returned `onPointerDown`.
 */
export function useTabReorder({ track, keys, onReorder, onStart, onMove, axis = "x" }: ReorderOptions) {
  const y = axis === "y";
  /** Leading edge and length of a box along the axis. */
  const lead = (r: DOMRect) => (y ? r.top : r.left);
  const span = (r: DOMRect) => (y ? r.height : r.width);
  const shift = (d: number) => (y ? `translateY(${d}px)` : `translateX(${d}px)`);
  const drag = useRef<DragState | null>(null);
  /** Where each tab was drawn at the drop, for the settle animation. */
  const settle = useRef<Map<string, number> | null>(null);
  const cbs = useRef({ onReorder, onStart, onMove });
  cbs.current = { onReorder, onStart, onMove };

  useLayoutEffect(() => {
    const drawn = settle.current;
    const t = track.current;
    settle.current = null;
    if (!drawn || !t) return;
    for (const el of t.querySelectorAll<HTMLElement>(":scope > [data-reorder-key]")) {
      const was = drawn.get(el.dataset.reorderKey!);
      if (was === undefined) continue;
      const delta = was - lead(el.getBoundingClientRect());
      if (Math.abs(delta) < 0.5 || reducedMotion()) continue;
      el.animate([{ transform: shift(delta) }, { transform: "none" }], {
        duration: SETTLE_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  }, [keys.join("\u0000"), axis]);

  return (key: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || drag.current) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const startX = y ? e.clientY : e.clientX;
    let state: DragState | null = null;

    const begin = (): DragState | null => {
      const t = track.current;
      if (!t) return null;
      // Measured now, not at the press: selecting a tab may have resized it.
      const items = Array.from(t.querySelectorAll<HTMLElement>(":scope > [data-reorder-key]"));
      const from = items.findIndex((el) => el.dataset.reorderKey === key);
      if (from < 0 || items.length < 2) return null;
      const boxes = items.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: lead(r), width: span(r) };
      });
      const gap = items.length > 1 ? boxes[1].left - (boxes[0].left + boxes[0].width) : 0;
      t.classList.add("reordering");
      items[from].dataset.dragging = "";
      cbs.current.onStart?.(key);
      return { key, from, to: from, startX, items, boxes, step: boxes[from].width + gap };
    };

    const paint = (s: DragState, rawDx: number) => {
      const first = s.boxes[0];
      const last = s.boxes[s.boxes.length - 1];
      const me = s.boxes[s.from];
      // Keep the tab inside the row.
      const dx = Math.max(first.left - me.left, Math.min(last.left + last.width - me.width - me.left, rawDx));
      // Swap as soon as the tab's leading edge is halfway over a neighbour,
      // so a wide tab doesn't have to travel its own width first. Measured
      // from the pointer, not the clamped tab, so the end slots stay reachable.
      const leftEdge = me.left + rawDx;
      const rightEdge = leftEdge + me.width;
      let to = s.from;
      for (let i = s.from + 1; i < s.boxes.length; i++) {
        if (rightEdge > s.boxes[i].left + s.boxes[i].width / 2) to = i;
      }
      for (let i = s.from - 1; i >= 0; i--) {
        if (leftEdge < s.boxes[i].left + s.boxes[i].width / 2) to = i;
      }
      s.to = to;
      s.items.forEach((el, i) => {
        if (i === s.from) el.style.transform = shift(dx);
        else if (to > s.from && i > s.from && i <= to) el.style.transform = shift(-s.step);
        else if (to < s.from && i >= to && i < s.from) el.style.transform = shift(s.step);
        else el.style.transform = "";
      });
      cbs.current.onMove?.(s.key, dx);
    };

    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key_, { capture: true });
      window.removeEventListener("blur", cancel);
      const s = state;
      drag.current = null;
      if (!s) return;
      // A drag is not a click: swallow the one this release is about to fire.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);

      const drawn = new Map<string, number>();
      s.items.forEach((el) => drawn.set(el.dataset.reorderKey!, lead(el.getBoundingClientRect())));
      track.current?.classList.remove("reordering");
      s.items.forEach((el) => {
        el.style.transform = "";
        delete el.dataset.dragging;
      });
      cbs.current.onMove?.(s.key, null);
      if (commit && s.to !== s.from) {
        settle.current = drawn;
        cbs.current.onReorder(s.from, s.to);
      } else if (!reducedMotion()) {
        // Same order: glide back from where they were drawn.
        s.items.forEach((el) => {
          const delta = drawn.get(el.dataset.reorderKey!)! - lead(el.getBoundingClientRect());
          if (Math.abs(delta) >= 0.5) {
            el.animate([{ transform: shift(delta) }, { transform: "none" }], {
              duration: SETTLE_MS,
              easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            });
          }
        });
      }
    };

    const move = (ev: PointerEvent) => {
      const dx = (y ? ev.clientY : ev.clientX) - startX;
      if (!state) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        state = begin();
        if (!state) return end(false);
        drag.current = state;
      }
      ev.preventDefault();
      paint(state, dx);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key_ = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !state) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key_, { capture: true });
    window.addEventListener("blur", cancel);
  };
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
