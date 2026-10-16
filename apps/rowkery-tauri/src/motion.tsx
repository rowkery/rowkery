import {
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * Motion helpers. Entries are CSS animations that play on mount; these keep a
 * closing element on screen until its exit has played. Exits are shorter than
 * entries, like macOS menus and sheets. Reduce Motion skips all of it.
 */

const TAB_ENTER_MS = 160;
const TAB_EXIT_MS = 140;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
/** Upper bound on an exit, in case its animations never report finishing. */
const EXIT_SAFETY_MS = 1000;

export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Resolves once every finite animation in `el`'s subtree has ended. */
function exitsDone(el: HTMLElement): Promise<unknown> {
  const anims = el
    .getAnimations({ subtree: true })
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
  return Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
}

/**
 * Renders `children` while `open`, then keeps the last open render under
 * `data-closing` until the exit animations CSS attaches to it have played.
 * The closing copy is `inert`: no clicks, no keys, no focus. Reopening
 * mid-exit drops it and mounts a fresh copy (empty filter, focused input).
 * The wrapper is `display: contents`, so layout and positioning are
 * unchanged.
 */
export function Presence({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  /** Bumped on every open, so reopening mid-exit starts a fresh copy. */
  const [generation, setGeneration] = useState(0);
  const last = useRef(children);
  const wrapRef = useRef<HTMLDivElement>(null);
  if (open) last.current = children;
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMounted(true);
      setGeneration((g) => g + 1);
    }
  }

  useLayoutEffect(() => {
    if (open || !mounted) return;
    const el = wrapRef.current;
    let live = true;
    const unmount = () => live && setMounted(false);
    const safety = window.setTimeout(unmount, EXIT_SAFETY_MS);
    if (!el || reducedMotion()) unmount();
    else void exitsDone(el).then(unmount);
    return () => {
      live = false;
      window.clearTimeout(safety);
    };
  }, [open, mounted]);

  if (!mounted) return null;
  const closing = !open;
  return (
    <div
      key={generation}
      ref={wrapRef}
      className="presence"
      data-closing={closing || undefined}
      inert={closing}
    >
      {closing ? last.current : children}
    </div>
  );
}

/**
 * Text that rolls up to its new value: the old one slides out above while the
 * new one slides in from below. The first value shows without motion.
 */
export function RollText({
  text,
  className,
  "data-testid": testid,
}: {
  text: string;
  className?: string;
  "data-testid"?: string;
}) {
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (shown !== text) {
    setLeaving(reducedMotion() ? null : shown);
    setShown(text);
  }
  const done = () => setLeaving(null);

  return (
    <span className={`roll${className ? ` ${className}` : ""}`} data-testid={testid}>
      {leaving !== null && (
        <span
          key={`out:${leaving}`}
          className="roll-out"
          aria-hidden
          onAnimationEnd={done}
        >
          {leaving}
        </span>
      )}
      <span key={`in:${shown}`} className={leaving !== null ? "roll-in" : undefined}>
        {shown}
      </span>
    </span>
  );
}

export interface PresenceRow<T> {
  key: string;
  item: T;
  /** Removed from `items` and playing its exit; render it inert. */
  exiting: boolean;
}

/**
 * A row of tabs whose items widen into place when added and narrow away when
 * removed, so their neighbours slide over. Removed items stay in `rows` (at
 * their old place, `exiting`) until the exit ends. Items present on the first
 * render appear without motion. Pass `ref(key)` to each rendered element.
 *
 * Uses the Web Animations API with measured widths, so it survives
 * re-renders and needs no fixed tab size. `gap` is the container's flex gap,
 * folded away with the tab.
 */
export function useTabPresence<T>(
  items: T[],
  getKey: (item: T) => string,
  gap: number,
): { rows: PresenceRow<T>[]; ref: (key: string) => (el: HTMLElement | null) => void } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const exiting = useRef(new Map<string, { item: T; index: number }>());
  const lastRows = useRef<PresenceRow<T>[]>([]);
  const els = useRef(new Map<string, HTMLElement>());
  const seen = useRef<Set<string> | null>(null);
  const running = useRef(new Map<string, Animation>());
  const refFns = useRef(new Map<string, (el: HTMLElement | null) => void>());

  const keys = new Set(items.map(getKey));
  lastRows.current.forEach((r, index) => {
    if (!keys.has(r.key) && !exiting.current.has(r.key)) {
      exiting.current.set(r.key, { item: r.item, index });
    }
  });
  for (const k of [...exiting.current.keys()]) {
    if (keys.has(k)) exiting.current.delete(k);
  }

  const rows: PresenceRow<T>[] = items.map((item) => ({
    key: getKey(item),
    item,
    exiting: false,
  }));
  [...exiting.current.entries()]
    .sort((a, b) => a[1].index - b[1].index)
    .forEach(([key, { item, index }]) => {
      rows.splice(Math.min(index, rows.length), 0, { key, item, exiting: true });
    });

  useLayoutEffect(() => {
    lastRows.current = rows;
    const reduce = reducedMotion();
    if (seen.current === null) {
      seen.current = new Set(rows.map((r) => r.key));
      return;
    }
    const drop = (key: string) => {
      exiting.current.delete(key);
      running.current.delete(key);
      lastRows.current = lastRows.current.filter((r) => r.key !== key);
      rerender();
    };
    for (const r of rows) {
      const el = els.current.get(r.key);
      const current = running.current.get(r.key);
      if (r.exiting) {
        if (current?.id === "exit") continue;
        current?.cancel();
        if (reduce || !el) {
          drop(r.key);
          continue;
        }
        const anim = animateWidth(el, gap, "exit");
        running.current.set(r.key, anim);
        anim.onfinish = () => drop(r.key);
      } else if (!seen.current.has(r.key) || current?.id === "exit") {
        seen.current.add(r.key);
        current?.cancel();
        running.current.delete(r.key);
        if (reduce || !el) continue;
        const anim = animateWidth(el, gap, "enter");
        running.current.set(r.key, anim);
        anim.onfinish = () => running.current.delete(r.key);
      }
    }
  });

  const ref = (key: string) => {
    let fn = refFns.current.get(key);
    if (!fn) {
      fn = (el) => {
        if (el) els.current.set(key, el);
        else {
          els.current.delete(key);
          refFns.current.delete(key);
        }
      };
      refFns.current.set(key, fn);
    }
    return fn;
  };

  return { rows, ref };
}

function animateWidth(el: HTMLElement, gap: number, dir: "enter" | "exit"): Animation {
  const cs = getComputedStyle(el);
  const open: Keyframe = {
    width: `${el.offsetWidth}px`,
    minWidth: "0px",
    maxWidth: "none",
    paddingLeft: cs.paddingLeft,
    paddingRight: cs.paddingRight,
    marginRight: "0px",
    opacity: 1,
  };
  const shut: Keyframe = {
    width: "0px",
    minWidth: "0px",
    maxWidth: "none",
    paddingLeft: "0px",
    paddingRight: "0px",
    marginRight: `${-gap}px`,
    opacity: 0,
  };
  // Clip the label while the tab is narrower than its content.
  const overflow = el.style.overflow;
  el.style.overflow = "hidden";
  const anim = el.animate(dir === "enter" ? [shut, open] : [open, shut], {
    duration: dir === "enter" ? TAB_ENTER_MS : TAB_EXIT_MS,
    easing: dir === "enter" ? EASE_OUT : EASE_IN,
    fill: dir === "exit" ? "forwards" : "none",
  });
  anim.id = dir;
  const restore = () => {
    el.style.overflow = overflow;
  };
  anim.addEventListener("finish", restore);
  anim.addEventListener("cancel", restore);
  return anim;
}

/**
 * Keeps `thumb` over the child of `track` marked `data-on`, so a selection
 * slides (the glide itself is a CSS transition on the thumb). It lands without
 * motion the first time, and follows the item while tabs resize or animate.
 * `onPlace` gets the item's box in the track's coordinates. Re-run it with
 * `deps` whenever the items or the selection change.
 */
export function useSlidingThumb(
  track: RefObject<HTMLElement | null>,
  thumb: RefObject<HTMLElement | null>,
  deps: unknown[],
  onPlace?: (box: { left: number; width: number }) => void,
) {
  const placed = useRef(false);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;

  useLayoutEffect(() => {
    const t = track.current;
    const th = thumb.current;
    if (!t || !th) return;
    const place = () => {
      const on = t.querySelector<HTMLElement>(":scope > [data-on]");
      if (!on) {
        th.style.opacity = "0";
        return;
      }
      const box = {
        left: on.offsetLeft,
        top: on.offsetTop,
        width: on.offsetWidth,
        height: on.offsetHeight,
      };
      const first = !placed.current;
      if (first) th.style.transition = "none";
      th.style.opacity = "";
      th.style.width = `${box.width}px`;
      th.style.height = `${box.height}px`;
      th.style.transform = `translate(${box.left}px, ${box.top}px)`;
      if (first) {
        // Commit the start position before transitions come back on.
        void th.offsetWidth;
        th.style.transition = "";
        placed.current = true;
      }
      onPlaceRef.current?.({ left: box.left, width: box.width });
    };
    place();
    // Tabs widen, narrow and roll their text; follow them while they do. Not
    // the thumb itself (placing it resizes it), and a frame later: moving it
    // inside the observer's own callback looped ("ResizeObserver loop
    // completed with undelivered notifications").
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    });
    ro.observe(t);
    for (const child of Array.from(t.children)) if (child !== th) ro.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, deps);
}

const GLIDE_MS = 180;
const GLIDE_FADE_MS = 120;

/**
 * Paper's hover: one highlight per list that glides to the row under the
 * pointer (transform and height, 180 ms) and fades when the pointer leaves
 * (120 ms), instead of each row painting its own hover fill. It lives inside
 * `list` (absolutely placed, under the rows), so it scrolls with them; it
 * appears at once the first time and under Reduce Motion. Rows are the
 * elements matching `rowSelector`; a keyboard cursor keeps its own fill.
 * With `boxSelector` the highlight takes the size of that part of the row
 * (a row's icon, not its label). Follows `list` when React swaps the
 * element (a re-keyed list).
 */
export function useGlideHover(list: RefObject<HTMLElement | null>, rowSelector: string, boxSelector?: string) {
  const bound = useRef<{ el: HTMLElement; off: () => void } | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (bound.current?.el === el) return;
    bound.current?.off();
    bound.current = null;
    if (!el) return;
    const glide = document.createElement("div");
    glide.className = "glide";
    glide.dataset.glide = "";
    glide.setAttribute("aria-hidden", "true");
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.style.isolation = "isolate";
    el.append(glide);
    let shown: Element | null = null;

    const moveTo = (row: HTMLElement) => {
      const lr = el.getBoundingClientRect();
      const rr = ((boxSelector && row.querySelector(boxSelector)) || row).getBoundingClientRect();
      const x = rr.left - lr.left + el.scrollLeft - el.clientLeft;
      const y = rr.top - lr.top + el.scrollTop - el.clientTop;
      const fresh = shown === null || reducedMotion();
      glide.style.transition = fresh
        ? "none"
        : `transform ${GLIDE_MS}ms ${EASE_OUT}, height ${GLIDE_MS}ms ${EASE_OUT}, width ${GLIDE_MS}ms ${EASE_OUT}, opacity ${GLIDE_FADE_MS}ms ease`;
      glide.style.width = `${rr.width}px`;
      glide.style.height = `${rr.height}px`;
      glide.style.transform = `translate(${x}px, ${y}px)`;
      glide.style.opacity = "1";
      glide.dataset.glideOn = "";
      shown = row;
    };
    const hide = () => {
      if (shown === null) return;
      shown = null;
      glide.style.transition = reducedMotion() ? "none" : `opacity ${GLIDE_FADE_MS}ms ease`;
      glide.style.opacity = "0";
      delete glide.dataset.glideOn;
    };
    const onOver = (e: PointerEvent) => {
      const row = (e.target as Element | null)?.closest?.(rowSelector) as HTMLElement | null;
      if (row && el.contains(row)) {
        if (row !== shown) moveTo(row);
      } else hide();
    };
    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointerleave", hide);
    // A row that moves under a still pointer (scrolling, filtering) lets go.
    el.addEventListener("scroll", hide, { passive: true });
    bound.current = {
      el,
      off: () => {
        el.removeEventListener("pointerover", onOver);
        el.removeEventListener("pointerleave", hide);
        el.removeEventListener("scroll", hide);
        glide.remove();
      },
    };
  });
  useLayoutEffect(
    () => () => {
      bound.current?.off();
      bound.current = null;
    },
    [],
  );
}
