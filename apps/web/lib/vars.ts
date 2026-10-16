import type { CSSProperties } from "react";

/** CSS custom properties for an inline style, e.g. the delay of one looping animation: vars({ "--d": "4s" }). */
export const vars = (v: Record<`--${string}`, string>, rest?: CSSProperties) => ({ ...v, ...rest }) as CSSProperties;
