import { useSyncExternalStore } from "react";
import type { Chord } from "./commands";
import { readKey, writeKey } from "./persist";

/**
 * Keymaps for people coming from another client: each swaps only the handful
 * of chords that collide with that app's habits (new tab vs new window,
 * Data | Structure, refresh). Everything else keeps Rowkery's chord. The sheet,
 * ⌘K, the menu bar, tooltips and the key strip all read the swapped chords
 * (`chordFor` in commands.ts), and keyTracker.ts runs a swapped chord as its
 * command before the window's own handlers see it.
 */
export type KeymapId = "rowkery" | "tableplus" | "datagrip";

export const KEYMAPS: { id: KeymapId; label: string }[] = [
  { id: "rowkery", label: "Rowkery" },
  { id: "tableplus", label: "TablePlus" },
  { id: "datagrip", label: "DataGrip" },
];

/** The chords each keymap moves, by command id. */
export const KEYMAP_CHORDS: Record<KeymapId, Record<string, Chord>> = {
  rowkery: {},
  tableplus: {
    // TablePlus: ⌘T is a new tab; ⌃⌘[ / ⌃⌘] switch Data and Structure.
    "new-tab": { mac: "Mod+T" },
    "new-window": { mac: "Alt+Mod+T" },
    "show-data": { mac: "Ctrl+Mod+[", other: "Ctrl+Alt+[" },
    "show-structure": { mac: "Ctrl+Mod+]", other: "Ctrl+Alt+]" },
  },
  datagrip: {
    // DataGrip: ⇧⌘L opens a new query console; ⌥⌘Y synchronizes the schema.
    "new-tab": { mac: "Mod+Shift+L" },
    "refresh-schema": { mac: "Alt+Mod+Y" },
  },
};

const KEY = "rowkery.keymap";
const listeners = new Set<() => void>();

function isKeymap(v: unknown): v is KeymapId {
  return v === "rowkery" || v === "tableplus" || v === "datagrip";
}

/** The keymap in use (config.json `rowkery.keymap`), Rowkery by default. */
export function activeKeymap(): KeymapId {
  const v = readKey(KEY);
  return isKeymap(v) ? v : "rowkery";
}

/** Applies at once everywhere and persists. */
export function setKeymap(id: KeymapId) {
  if (id === activeKeymap()) return;
  writeKey(KEY, id === "rowkery" ? undefined : id);
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders the caller when the keymap changes. */
export function useKeymap(): KeymapId {
  return useSyncExternalStore(subscribe, activeKeymap, activeKeymap);
}
