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
  hardhat: (
    <>
      <path d="M170 90 C172 38 254 26 266 86 Z" fill="var(--acc)" />
      <rect x="156" y="82" width="124" height="13" rx="6.5" fill="var(--acc)" />
      <rect x="210" y="40" width="11" height="44" rx="5" fill="var(--bg)" opacity=".35" />
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
  arrow: <path d="M214 0 v44 M192 24 l22 22 l22 -22" stroke="var(--acc)" strokeWidth="13" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  question: (
    <text x="262" y="62" fontSize="84" fontWeight="600" fill="var(--acc)" fontFamily="var(--font-sans), system-ui, sans-serif">
      ?
    </text>
  ),
} satisfies Record<string, ReactNode>;

export type PgProp = keyof typeof PROPS;

/**
 * The penguin: the mark plus an eyelid over its eye hole, which blinks on hover (only on hover:
 * a blink on a timer repaints the page while it sits still). `prop` adds something to hold,
 * `tilted` leans it 10° on its feet (the app's Tilted posture), `floe` stands it on an ice
 * floe. `tight` uses the mark's own view box, for a penguin with nothing beside it (the brand,
 * the 404).
 */
export function Pg({
  prop,
  tilted,
  floe,
  tight,
  className,
  style,
}: {
  prop?: PgProp;
  tilted?: boolean;
  floe?: boolean;
  tight?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg className={`pg${className ? ` ${className}` : ""}`} viewBox={tight ? MARK_VIEW_BOX : "40 0 330 340"} style={style} aria-hidden="true">
      {floe && <path d="M44 322 L66 306 H334 L362 322 L346 336 H62 Z" fill="var(--card2)" />}
      <g transform={tilted ? "rotate(-10 198 320)" : undefined}>
        <MarkPaths />
        <ellipse className="lid" cx="240.7" cy="138.9" rx="12.4" ry="13.7" />
        {prop && <g className="prop">{PROPS[prop]}</g>}
      </g>
    </svg>
  );
}
