import { useSyncExternalStore } from "react";
import { readKey, writeKey } from "./persist";

/**
 * How often each shortcut has been pressed (`usedKeys` in config.json, by
 * command or gesture id). The shortcut sheet brightens a used one and counts
 * "Used n of m"; the key strip retires a zone once every key on it reached
 * three. Only keys count: a menu or ⌘K pick of the same command does not.
 */
const KEY = "rowkery.usedKeys";
const listeners = new Set<() => void>();
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache) return cache;
  const v = readKey(KEY);
  cache = {};
  if (v && typeof v === "object") {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && n > 0) cache[k] = n;
    }
  }
  return cache;
}

/** Times each key was used; the same object until the next use. */
export function usedKeys(): Record<string, number> {
  return load();
}

/** Counts one press of `id`'s key. */
export function noteUsed(id: string) {
  const now = load();
  cache = { ...now, [id]: (now[id] ?? 0) + 1 };
  writeKey(KEY, cache);
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders the caller whenever a key is used. */
export function useUsedKeys(): Record<string, number> {
  return useSyncExternalStore(subscribe, usedKeys, usedKeys);
}

/** Tests: forget the cached counts (after resetPersistForTests). */
export function resetUsedKeysForTests() {
  cache = null;
}
