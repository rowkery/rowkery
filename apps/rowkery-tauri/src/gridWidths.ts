import { readKey, writeKey } from "./persist";

/**
 * Dragged column widths per result shape (its column names joined by NUL),
 * so a width set on one table's `id` doesn't squash every other table's
 * `id`. Saved with the UI state in config.json (`persist.ts`), shared by
 * every window; only dragged columns are in it.
 */
export type WidthsByShape = Record<string, Record<string, number>>;

const KEY = "rowkery.columnWidths";
/** Shapes kept; the least recently dragged go first. */
export const MAX_SHAPES = 200;

export function loadWidths(): WidthsByShape {
  const v = readKey(KEY);
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: WidthsByShape = {};
  for (const [shape, widths] of Object.entries(v as Record<string, unknown>)) {
    if (!widths || typeof widths !== "object") continue;
    const ok = Object.entries(widths as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number" && e[1] > 0,
    );
    if (ok.length) out[shape] = Object.fromEntries(ok);
  }
  return out;
}

/** Saves one shape's widths over what is saved now (another window may have saved since). */
export function saveShapeWidths(shape: string, widths: Record<string, number>): WidthsByShape {
  const all = loadWidths();
  // Re-inserted last: object order is the recency order the cap trims by.
  delete all[shape];
  all[shape] = widths;
  const shapes = Object.keys(all);
  for (const old of shapes.slice(0, Math.max(0, shapes.length - MAX_SHAPES))) delete all[old];
  writeKey(KEY, all);
  return all;
}
