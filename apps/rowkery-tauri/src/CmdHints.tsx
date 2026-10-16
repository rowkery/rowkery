import { useEffect, useState } from "react";
import { commandKeys } from "./commands";
import { isMacPlatform } from "./platform";
import "./CmdHints.css";
import { Keys, keyGaps } from "./Keys";

/**
 * Shortcut hints while ⌘ is held (Ctrl off the Mac): a small pill under each
 * control that has a registry command (`data-hint-cmd="<command id>"`) or is
 * window N (`data-hint-win="N"`). They show after ⌘ has been held alone for
 * HOLD_MS, so ⌘C / ⌘V never flash them, and go on release, on any other key
 * or when the window loses focus. One fixed layer measured when it opens:
 * nothing is laid out around the controls, and the layer takes no pointer
 * events. Chosen 2026-10-08 (#158); placement without overlaps,
 * 2026-10-13 (`place`).
 */
const HOLD_MS = 400;
const CLOSE_MS = 110;

interface Hint {
  key: string;
  keys: string;
  x: number;
  y: number;
}

type Box = { l: number; t: number; r: number; b: number };
const BADGE_H = 22;
const GAP = 8; // clearance between two badges (2026-10-13)
let ruler: CanvasRenderingContext2D | null = null;
function badgeWidth(text: string): number {
  ruler ??= document.createElement("canvas").getContext("2d");
  const gaps = keyGaps(text) * 12 * 0.15; // Keys' .key-gap margins
  if (!ruler) return Math.ceil(text.length * 7.3 + gaps) + 14;
  ruler.font = "500 12px 'IBM Plex Mono', ui-monospace, monospace";
  return Math.ceil(ruler.measureText(text).width + gaps) + 14; // 6 px padding a side, the 1 px ring
}
const hit = (a: Box, b: Box, m = 0) => a.l < b.r + m && b.l < a.r + m && a.t < b.b + m && b.t < a.b + m;

/** Words or another control outside `own` under the badge (the hints layer takes no pointer events). */
function coversText(box: Box, own: HTMLElement): boolean {
  // A grid every 8 px across and three rows down: no control slips between samples.
  const pts: number[][] = [];
  for (let x = box.l + 2; x <= box.r - 2; x += 8) for (const y of [box.t + 3, (box.t + box.b) / 2, box.b - 3]) pts.push([x, y]);
  return pts.some(([x, y]) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || own.contains(el) || el.contains(own)) return false;
    if (el.closest("button, a, input, textarea, kbd, label, [role='tab']")) return true;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
  });
}

/**
 * Each badge gets its own place (2026-10-13: ⇧⌘O sat on the host
 * line, ⌘R on the filter box, the window keys on each other). Tried in
 * order: under its control, over its middle, right of it, above, left of
 * it; the first that stays in the window, keeps 8 px from every badge
 * already placed and covers no words outside its control wins, else the
 * one over its middle.
 */
function place(el: HTMLElement, r: DOMRect, w: number, placed: Box[]): Box {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Kept inside the window sideways (a control at the edge still gets a place).
  const at = (l: number, t: number): Box => {
    const x = Math.round(Math.min(Math.max(l, 4), innerWidth - 4 - w));
    return { l: x, t: Math.round(t), r: x + Math.round(w), b: Math.round(t + BADGE_H) };
  };
  const over = at(cx - w / 2, cy - BADGE_H / 2);
  const tries = [at(cx - w / 2, r.bottom + 4), over, at(r.right + 6, cy - BADGE_H / 2), at(cx - w / 2, r.top - BADGE_H - 4), at(r.left - w - 6, cy - BADGE_H / 2)];
  const inWindow = (b: Box) => b.l >= 4 && b.t >= 4 && b.r <= innerWidth - 4 && b.b <= innerHeight - 4;
  const free = (b: Box) => !placed.some((p) => hit(b, p, GAP));
  // Crowded: step further below, then further above, until there is room.
  const further = Array.from({ length: 16 }, (_, k) => {
    const step = (Math.floor(k / 2) + 1) * (BADGE_H + GAP);
    return k % 2 ? at(cx - w / 2, r.top - BADGE_H - 4 - step) : at(cx - w / 2, r.bottom + 4 + step);
  });
  const all = [...tries, ...further];
  return (
    all.find((b) => inWindow(b) && free(b) && !coversText(b, el)) ??
    all.find((b) => inWindow(b) && free(b)) ??
    over
  );
}

function measure(mac: boolean): (Hint & { w: number })[] {
  const out: (Hint & { w: number })[] = [];
  const placed: Box[] = [];
  const seen = new Set<string>();
  document.querySelectorAll<HTMLElement>("[data-hint-cmd],[data-hint-win]").forEach((el, i) => {
    if ((el as HTMLButtonElement).disabled) return;
    // A hidden column (an empty window's schema column) shows no hints.
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return;
    const win = el.dataset.hintWin;
    const keys = win ? `${mac ? "⌘" : "Ctrl+"}${win}` : commandKeys(el.dataset.hintCmd ?? "", mac);
    if (!keys) return;
    const id = `${keys}@${Math.round(r.left)},${Math.round(r.top)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const w = badgeWidth(keys);
    const box = place(el, r, w, placed);
    placed.push(box);
    out.push({ key: `${i}-${id}`, keys, x: box.l, y: box.t, w });
  });
  return out;
}

export function CmdHints() {
  const [hints, setHints] = useState<(Hint & { w: number })[]>([]);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const mac = isMacPlatform();
    const modKey = mac ? "Meta" : "Control";
    let hold: number | undefined;
    let close: number | undefined;
    const hide = () => {
      window.clearTimeout(hold);
      hold = undefined;
      setOn((was) => {
        if (was) {
          window.clearTimeout(close);
          close = window.setTimeout(() => setHints([]), CLOSE_MS);
        }
        return false;
      });
    };
    const down = (e: KeyboardEvent) => {
      if (e.key !== modKey) return hide();
      if (e.repeat || hold !== undefined) return;
      hold = window.setTimeout(() => {
        window.clearTimeout(close);
        setHints(measure(mac));
        // Next frame, so the pills mount at opacity 0 and the fade runs.
        requestAnimationFrame(() => setOn(true));
      }, HOLD_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === modKey) hide();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("pointerdown", hide, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("pointerdown", hide, true);
      window.clearTimeout(hold);
      window.clearTimeout(close);
    };
  }, []);

  if (!hints.length) return null;
  return (
    <div className="cmd-hints" data-testid="cmd-hints" data-on={on ? "" : undefined} aria-hidden>
      {hints.map((h) => (
        <kbd key={h.key} className="cmd-hint" data-key-hint style={{ left: h.x, top: h.y, width: h.w }}>
          <Keys text={h.keys} />
        </kbd>
      ))}
    </div>
  );
}
