import { MARK_VIEW_BOX, MarkPaths } from "./Mark";

/**
 * The penguin: the mark plus an eyelid over its eye hole, which blinks on hover (only on hover:
 * a blink on a timer would repaint the page while it sits still). `tilted` leans it 10° on its
 * feet (the app's Tilted posture, on the 404). `tight` uses the mark's own view box; without it
 * there is room around the mark for the tilt.
 *
 * The mark is always an inline path in an SVG with overflow visible, never a <symbol> behind
 * <use>: a symbol clips to the view box that references it, which cuts penguins off.
 */
export function Pg({ tilted, tight, className }: { tilted?: boolean; tight?: boolean; className?: string }) {
  return (
    <svg className={`pg${className ? ` ${className}` : ""}`} viewBox={tight ? MARK_VIEW_BOX : "40 0 330 340"} aria-hidden="true">
      <g transform={tilted ? "rotate(-10 198 320)" : undefined}>
        <MarkPaths />
        <ellipse className="lid" cx="240.7" cy="138.9" rx="12.4" ry="13.7" />
      </g>
    </svg>
  );
}
