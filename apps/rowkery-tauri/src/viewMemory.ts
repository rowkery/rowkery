import type { MapDepth } from "./mapLayout";
import { readKey, writeKey } from "./persist";

/**
 * What table tabs remember between tables, kept in config.json:
 * - the view last shown (Data, Structure or Map), which a table opened from
 *   the sidebar starts in;
 * - the map's reach (1 step, 2 steps or All), one per database, so every
 *   table of it and a reopened tab show the same.
 */
export type TableView = "data" | "structure" | "map";

const VIEW_KEY = "rowkery.tableView";
const DEPTH_KEY = "rowkery.mapDepth";

export function lastTableView(): TableView {
  const v = readKey(VIEW_KEY);
  return v === "structure" || v === "map" ? v : "data";
}

export function setLastTableView(view: TableView) {
  if (view !== lastTableView()) writeKey(VIEW_KEY, view === "data" ? undefined : view);
}

/** A database, as the map's reach is kept for it. */
export function depthKey(connectionId: string, database: string): string {
  return `${connectionId}/${database}`;
}

function depths(): Record<string, MapDepth> {
  const raw = readKey(DEPTH_KEY);
  const out: Record<string, MapDepth> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) if (v === 2 || v === "all") out[k] = v;
  return out;
}

export function mapDepthFor(db: string): MapDepth {
  return depths()[db] ?? 1;
}

export function setMapDepth(db: string, depth: MapDepth) {
  const { [db]: _old, ...rest } = depths();
  writeKey(DEPTH_KEY, depth === 1 ? rest : { ...rest, [db]: depth });
}
