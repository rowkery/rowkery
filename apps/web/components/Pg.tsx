import type { CSSProperties, ReactNode } from "react";
import { MARK_VIEW_BOX, MarkPaths } from "./Mark";

/**
 * Things a penguin can hold or wear around the page. The mark itself is never redrawn: props
 * are drawn beside it in the mark's own coordinates, in orange, and poses are transforms only.
 */
const PROPS = {
  hat: (
    <>
      <path d="M180 86 L244 76 L206 16 Z" fill="var(--acc)" />
      <circle cx="206" cy="16" r="10" fill="currentColor" />
    </>
  ),
  shades: (
    <>
      <path d="M194 138 L222 134" stroke="var(--acc)" strokeWidth="7" strokeLinecap="round" />
      <rect x="218" y="122" width="56" height="32" rx="13" fill="var(--acc)" />
      <path d="M230 131 l12 0" stroke="var(--bg)" strokeWidth="5" strokeLinecap="round" opacity=".6" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="322" cy="152" r="30" fill="var(--acc)" fillOpacity=".2" stroke="var(--acc)" strokeWidth="9" />
      <path d="M344 176 L366 206" stroke="var(--acc)" strokeWidth="13" strokeLinecap="round" />
    </>
  ),
  letter: (
    <>
      <rect x="236" y="204" width="88" height="60" rx="7" fill="var(--acc)" />
      <path d="M242 212 L280 240 L318 212" fill="none" stroke="var(--bg)" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  sign: (
    <>
      <rect x="226" y="196" width="98" height="76" rx="9" fill="var(--acc)" />
      <path d="M257 212 h36 l-18 21 l18 21 h-36 l18 -21 z" fill="var(--bg)" />
    </>
  ),
  key: (
    <>
      <circle cx="304" cy="214" r="22" fill="none" stroke="var(--acc)" strokeWidth="11" />
      <path d="M304 236 V300 M304 268 h20 M304 290 h15" stroke="var(--acc)" strokeWidth="11" strokeLinecap="round" fill="none" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type PgProp = keyof typeof PROPS;

const VIEW_BOX = "40 0 330 340";

/**
 * The penguin: the mark plus an eyelid over its eye hole, which blinks on hover (only on hover:
 * a blink on a timer repaints the page while it sits still). `prop` adds something to hold;
 * with `props`, every one of them is drawn and `prop` names the one showing (`data-prop`, which
 * the story scenes swap as they go). `tilted` leans it 10° on its feet (the app's Tilted
 * posture). `tight` uses the mark's own view box, for a penguin with nothing beside it (the
 * brand, the colony, the 404).
 *
 * The mark is always an inline path in an SVG with overflow visible, never a <symbol> behind
 * <use>: a symbol clips to the view box that references it, which cuts penguins off.
 */
export function Pg({
  prop,
  props,
  tilted,
  tight,
  className,
  style,
}: {
  prop?: PgProp;
  props?: readonly PgProp[];
  tilted?: boolean;
  tight?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const drawn = props ?? (prop ? [prop] : []);
  return (
    <svg className={`pg${className ? ` ${className}` : ""}`} viewBox={tight ? MARK_VIEW_BOX : VIEW_BOX} style={style} data-prop={props ? (prop ?? "") : undefined} aria-hidden="true">
      <g transform={tilted ? "rotate(-10 198 320)" : undefined}>
        <MarkPaths />
        <ellipse className="lid" cx="240.7" cy="138.9" rx="12.4" ry="13.7" />
        {drawn.map((p) => (
          <g className="prop" data-p={p} key={p}>
            {PROPS[p]}
          </g>
        ))}
      </g>
    </svg>
  );
}
