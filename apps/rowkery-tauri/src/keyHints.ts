import { useEffect, useSyncExternalStore } from "react";
import { COMMANDS, GESTURES, chordFor, formatChord, gestureKeys, type CommandState } from "./commands";
import { readKey, writeKey } from "./persist";
import { usedKeys } from "./usedKeys";

/**
 * The key strip: one 11 px line of up to five keys at the foot of the
 * focused zone (editor: left of Run; grid: over its bottom edge; panel:
 * under the filter box). Built from the same `canRun` predicate as ⌘K and
 * the menu bar, so it never shows a key that can't run now. A zone retires
 * (zero height, for good) once every key it shows was pressed three times
 * since its hints were last shown; ⌘K "Show key hints" brings all three back.
 * "One retiring line" per zone was chosen on 2026-10-05.
 */
export type StripZone = "editor" | "grid" | "panel";
export const STRIP_ZONES: StripZone[] = ["editor", "grid", "panel"];

/** A strip item: a registry command (shown only when it can run) or a gesture key. */
interface Candidate {
  id: string;
  label: string;
  /** When the key applies, beyond a command's `canRun`. */
  when?: (s: CommandState) => boolean;
}

const CANDIDATES: Record<StripZone, Candidate[]> = {
  editor: [
    // While a query runs, ⌘. cancel takes Run's place.
    { id: "cancel", label: "cancel" },
    { id: "run", label: "run", when: (s) => !s.running },
    { id: "explain", label: "plan", when: (s) => !s.running },
    { id: "complete", label: "complete" },
    { id: "command-palette", label: "search" },
    { id: "new-connection", label: "connect" },
    { id: "keyboard-shortcuts", label: "keys" },
  ],
  grid: [
    // Only where a cell can be edited; ⌘S commit takes ? keys' slot while edits wait.
    { id: "edit-cell", label: "edit" },
    { id: "quick-look", label: "look", when: (s) => s.hasRows },
    { id: "follow-key", label: "follow" },
    { id: "filter-rows", label: "filter" },
    { id: "find-results", label: "find" },
    { id: "copy-cells", label: "copy", when: (s) => s.hasRows },
    { id: "commit-edits", label: "commit" },
    { id: "shortcuts-here", label: "keys", when: (s) => !s.pendingEdits },
  ],
  panel: [
    { id: "filter-schema", label: "filter" },
    { id: "panel-open", label: "open", when: (s) => s.hasSchema },
    { id: "toggle-sidebar", label: "hide" },
    { id: "shortcuts-here", label: "keys" },
  ],
};

export interface StripItem {
  id: string;
  keys: string;
  label: string;
}

const commandById = new Map(COMMANDS.map((c) => [c.id, c]));
const gestureById = new Map(GESTURES.map((g) => [g.id, g]));

/** Keys a strip holds at most: the editor's has room beside Run for one more. */
const STRIP_MAX: Record<StripZone, number> = { editor: 6, grid: 5, panel: 5 };

/** What a zone's strip shows in this state: at most five keys (six in the editor) that can run now. */
export function stripItems(zone: StripZone, s: CommandState, mac: boolean): StripItem[] {
  const out: StripItem[] = [];
  for (const c of CANDIDATES[zone]) {
    const command = commandById.get(c.id);
    if (c.when && !c.when(s)) continue;
    if (command) {
      const chord = chordFor(command);
      if (!chord || !command.canRun(s)) continue;
      out.push({ id: c.id, keys: formatChord(chord, mac), label: c.label });
    } else {
      const g = gestureById.get(c.id);
      if (!g) continue;
      out.push({ id: c.id, keys: gestureKeys(g, mac), label: c.label });
    }
    if (out.length === STRIP_MAX[zone]) break;
  }
  return out;
}

/** Presses that retire a key from the strip. */
export const RETIRE_AFTER = 3;

interface StripState {
  retired: StripZone[];
  /** usedKeys when the hints were last shown again: presses count from here. */
  baseline: Record<string, number>;
}

const KEY = "rowkery.keyStrip";
const listeners = new Set<() => void>();
let cache: StripState | null = null;

function load(): StripState {
  if (cache) return cache;
  const v = readKey(KEY) as Partial<StripState> | undefined;
  cache = {
    retired: Array.isArray(v?.retired) ? v.retired.filter((z): z is StripZone => STRIP_ZONES.includes(z as StripZone)) : [],
    baseline: v?.baseline && typeof v.baseline === "object" ? v.baseline : {},
  };
  return cache;
}

function save(next: StripState) {
  cache = next;
  writeKey(KEY, next.retired.length === 0 && Object.keys(next.baseline).length === 0 ? undefined : next);
  for (const l of listeners) l();
}

export function stripState(): StripState {
  return load();
}

/** Whether every key on this strip was pressed often enough to retire it. */
export function shouldRetire(items: StripItem[], used: Record<string, number>, baseline: Record<string, number>): boolean {
  return items.length > 0 && items.every((i) => (used[i.id] ?? 0) - (baseline[i.id] ?? 0) >= RETIRE_AFTER);
}

export function retireZone(zone: StripZone) {
  const s = load();
  if (s.retired.includes(zone)) return;
  save({ ...s, retired: [...s.retired, zone] });
}

/** ⌘K "Show key hints": every zone again, counting presses from now. */
export function showKeyHints() {
  save({ retired: [], baseline: { ...usedKeys() } });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStripState(): StripState {
  return useSyncExternalStore(subscribe, stripState, stripState);
}

/** Tests: forget the cached state (after resetPersistForTests). */
export function resetKeyStripForTests() {
  cache = null;
}

// The focused zone, from focusin / focusout anywhere in the page.
let zone: StripZone | null = null;
const zoneListeners = new Set<() => void>();

export function zoneOf(el: Element | null): StripZone | null {
  if (!el) return null;
  if (el.closest(".sidebar")) return "panel";
  if (el.closest(".results-grid-wrap")) return "grid";
  if (el.closest("textarea.sql-editor") && el.closest(".editor-card")) return "editor";
  return null;
}

function setZone(next: StripZone | null) {
  if (next === zone) return;
  zone = next;
  for (const l of zoneListeners) l();
}

let tracking = false;
function track() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("focusin", (e) => setZone(zoneOf(e.target as Element)));
  // Focus leaving to nothing (a click on chrome) clears it; to another
  // element, focusin follows.
  document.addEventListener("focusout", (e) => {
    if (!e.relatedTarget) setZone(null);
  });
}

function subscribeZone(l: () => void) {
  track();
  zoneListeners.add(l);
  return () => zoneListeners.delete(l);
}

/** The zone that has focus now: editor, grid, schema panel, or none. */
export function useFocusZone(): StripZone | null {
  return useSyncExternalStore(subscribeZone, () => zone, () => null);
}

/** Retires the zone once its shown keys have all been pressed enough. */
export function useRetire(zoneName: StripZone, items: StripItem[], used: Record<string, number>, state: StripState) {
  const retire = !state.retired.includes(zoneName) && shouldRetire(items, used, state.baseline);
  useEffect(() => {
    if (retire) retireZone(zoneName);
  }, [retire, zoneName]);
}
