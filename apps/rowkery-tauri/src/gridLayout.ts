import type { Column } from "./types";
import type { ResultRows } from "./resultStore";
import type { KeyColumns } from "./gridTypes";

/** Paper rows (2026-10-10): 30 px, ruled. */
export const ROW_HEIGHT = 30;
export const COL_MIN_WIDTH = 72;
const COL_MAX_AUTO_WIDTH = 360;
export const COL_DEFAULT = 120;
/** Rows sampled when sizing columns to their content; keeps first paint O(columns). */
export const WIDTH_SAMPLE_ROWS = 50;
/** Approximate advance of the 12.5px monospace cell font. */
const MONO_CHAR_PX = 7.6;
const CELL_PADDING_PX = 20;
/** Approximate advances of the header's 12px name and 10.5px monospace type. */
const HEADER_CHAR_PX = 7;
const TYPE_CHAR_PX = 6.4;
/** Room for a key icon beside a header name. */
const KEY_ICON_PX = 16;
/** Columns rendered past each side of the sheet (column virtualization). */
const COL_OVERSCAN = 2;
/**
 * A cell shows at most this many characters (about 15,000 px), and its
 * tooltip `CELL_TITLE_CHARS`: a value of megabytes stays out of the DOM.
 * Copy, Quick Look and export read the whole value.
 */
export const CELL_SHOWN_CHARS = 2000;
export const CELL_TITLE_CHARS = 300;
/** Past `COL_MAX_AUTO_WIDTH` at any advance: no more of a value is measured. */
const WIDTH_MEASURED_CHARS = 120;

/** The first `max` characters and an ellipsis, never splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/**
 * Text widths in the grid's own fonts, measured on a canvas: WebKit's SF Mono
 * is wider than an estimate (7.73px at 12.5px), and a cell 1px short shows an
 * ellipsis. Null without a canvas (tests), where the estimates stand in.
 */
const measureText = (() => {
  let ctx: CanvasRenderingContext2D | null | undefined;
  let fonts: { cell: string; name: string; type: string } | undefined;
  return (text: string, font: "cell" | "name" | "type"): number | null => {
    if (ctx === undefined) {
      try {
        ctx = document.createElement("canvas").getContext("2d");
        const root = getComputedStyle(document.documentElement);
        const mono = root.getPropertyValue("--mono").trim() || "monospace";
        const sans = root.getPropertyValue("--sans").trim() || "sans-serif";
        fonts = { cell: `12.5px ${mono}`, name: `500 12px ${sans}`, type: `10.5px ${mono}` };
      } catch {
        ctx = null;
      }
    }
    if (!ctx || !fonts) return null;
    ctx.font = fonts[font];
    return ctx.measureText(text).width;
  };
})();

/** One character of the cell font (monospace), measured once. */
let cellCharPx: number | undefined;
function cellChar(): number {
  cellCharPx ??= (measureText("0".repeat(20), "cell") ?? MONO_CHAR_PX * 20) / 20;
  return cellCharPx;
}

export function initialWidths(
  columns: Column[],
  rows: ResultRows,
  saved?: Record<string, number>,
  keys?: KeyColumns | null,
): number[] {
  const sample = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  const charPx = cellChar();
  return columns.map((c, ci) => {
    const w = saved?.[c.name];
    if (w && w >= COL_MIN_WIDTH) return w;
    let text = 0;
    for (let r = 0; r < sample; r++) {
      if (rows.isNull(r, ci)) {
        text = Math.max(text, 4 * charPx);
        continue;
      }
      const value = clipText(rows.text(r, ci), WIDTH_MEASURED_CHARS);
      // Monospace: length × one advance, except wide characters (CJK, emoji), measured.
      const width = /[^\u0000-\u024f]/.test(value) ? (measureText(value, "cell") ?? value.length * 2 * charPx) : value.length * charPx;
      if (width > text) text = width;
    }
    const icon = keys && (keys.pk.has(c.name) || keys.fk.has(c.name)) ? KEY_ICON_PX : 0;
    // The header reads name then type on one line, above the profile.
    const header =
      (measureText(c.name, "name") ?? c.name.length * HEADER_CHAR_PX) + 5 + (measureText(c.type_name, "type") ?? c.type_name.length * TYPE_CHAR_PX);
    // +1: subpixel advances round up in layout, and 1px short is an ellipsis.
    const fit = Math.ceil(Math.max(text, header) + CELL_PADDING_PX + icon + 1);
    return Math.min(COL_MAX_AUTO_WIDTH, Math.max(COL_MIN_WIDTH, fit));
  });
}

/**
 * The columns a sheet scrolled to `left` and `width` px wide shows, plus
 * `COL_OVERSCAN` each side: only those are rendered, in the header and in
 * every row. Selection, copy and find work on indices, never on cell nodes.
 */
export function columnWindow(
  offsets: number[],
  widths: number[],
  gutter: number,
  left: number,
  width: number,
): [number, number] {
  const n = offsets.length;
  if (n === 0) return [0, -1];
  // The first column ending right of the sticky gutter.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] + (widths[mid] ?? 0) > left + gutter) hi = mid;
    else lo = mid + 1;
  }
  let last = lo;
  while (last < n - 1 && offsets[last + 1] < left + width) last++;
  return [Math.max(0, lo - COL_OVERSCAN), Math.min(n - 1, last + COL_OVERSCAN)];
}
