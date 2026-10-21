import { readKey, writeKey } from "./persist";

/**
 * The map's "Guess links" switch: per connection, off by default. On, the map
 * also draws links an app keeps only in its models (`customer_id` →
 * `customers`), dashed. Kept in config.json by connection id.
 */
const KEY = "rowkery.mapGuess";

function load(): Record<string, true> {
  const v = readKey(KEY);
  return v && typeof v === "object" ? (v as Record<string, true>) : {};
}

export function mapGuessOn(connectionId: string | null | undefined): boolean {
  return !!connectionId && load()[connectionId] === true;
}

export function setMapGuess(connectionId: string, on: boolean) {
  const next = { ...load() };
  if (on) next[connectionId] = true;
  else delete next[connectionId];
  writeKey(KEY, Object.keys(next).length ? next : undefined);
}
