import { readKey, writeKey } from "./persist";

/**
 * Hover prefetch is a per-connection switch, off by default for every
 * connection (the New Connection sheet's Advanced section). Kept in
 * config.json with the rest of the UI state, by connection id.
 */
const KEY = "rowkery.prefetch";

function load(): Record<string, true> {
  const v = readKey(KEY);
  return v && typeof v === "object" ? (v as Record<string, true>) : {};
}

export function prefetchOn(connectionId: string | null | undefined): boolean {
  return !!connectionId && load()[connectionId] === true;
}

export function setPrefetch(connectionId: string, on: boolean) {
  const next = { ...load() };
  if (on) next[connectionId] = true;
  else delete next[connectionId];
  writeKey(KEY, Object.keys(next).length ? next : undefined);
}
