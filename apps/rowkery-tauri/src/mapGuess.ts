import { readKey, writeKey } from "./persist";

/**
 * The map's "Guess links" switch: one setting for every connection, off by
 * default. On, the map also draws links an app keeps only in its models
 * (`customer_id` → `customers`), dashed. Kept in config.json.
 */
const KEY = "rowkery.mapGuess";

export function mapGuessOn(): boolean {
  return readKey(KEY) === true;
}

export function setMapGuess(on: boolean) {
  writeKey(KEY, on ? true : undefined);
}
