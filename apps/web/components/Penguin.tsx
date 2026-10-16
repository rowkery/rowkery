import { MARK_VIEW_BOX, MarkPaths } from "./Mark";

/**
 * The penguin: the Rowkery mark, unmodified (apps/rowkery-tauri/brand/rowkery-mark-no-shadow.svg's
 * path verbatim), posed by a CSS transform on the <g> around it, as in the
 * app's PenguinMark. Ready stands upright; Tilted leans 10° on its feet (the
 * 404). One colour, currentColor; no motion.
 */
export function Penguin({ pose = "ready", size, className }: { pose?: "ready" | "tilted"; size: number; className?: string }) {
  return (
    <span className={`penguin-box${className ? ` ${className}` : ""}`} style={{ paddingInline: 0.2 * size }}>
      <svg className="penguin" data-pose={pose} width={size} height={Math.round((size * 256) / 240)} viewBox={MARK_VIEW_BOX} aria-hidden="true">
        <g className="penguin-body">
          <MarkPaths />
        </g>
      </svg>
    </span>
  );
}
