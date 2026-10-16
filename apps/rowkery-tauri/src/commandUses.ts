import { readKey, writeKey } from "./persist";

/**
 * How often each command was picked from ⌘K (`commandUses` in config.json,
 * under its usual `rowkery.` key). ⌘K lists the most used first when nothing is
 * typed and lets use break near-ties in score.
 */
const KEY = "rowkery.commandUses";

export function commandUses(): Record<string, number> {
  const v = readKey(KEY);
  return v && typeof v === "object" ? (v as Record<string, number>) : {};
}

/** Counts a pick; returns the new counts (a fresh object, for React). */
export function recordCommandUse(id: string): Record<string, number> {
  const uses = { ...commandUses(), [id]: (commandUses()[id] ?? 0) + 1 };
  writeKey(KEY, uses);
  return uses;
}
