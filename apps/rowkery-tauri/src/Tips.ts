import { useSyncExternalStore } from "react";
import { formatChord, keysFor } from "./commands";
import { readKey, writeKey } from "./persist";
import { isMacPlatform } from "./platform";

/**
 * Five tips, earned one at a time (TipKit's rules): each is a 12 px line
 * under the control it is about, shown when its trigger has been counted
 * enough times, retired for good once the user does what it teaches. At most
 * one is visible, at most one shows a day, none while a query runs, and ⌘K
 * "Hide tips" turns them off. Counters and retirements live in config.json
 * (`rowkery.tips`); a trigger counted per session ("the second retarget in a
 * session") is counted in memory.
 */

export type TipId = "preview-reused" | "type-to-filter" | "view-keys" | "widths-remembered" | "db-new-window";

/** The control a tip sits under; each place renders `useTip(where)`. */
export type TipPlace = "tab-row" | "sql-line" | "view-switch" | "grid-header" | "db-picker";

interface TipDef {
  text: (mac: boolean) => string;
  where: TipPlace;
  /** Counted triggers before it shows. */
  after: number;
  /** Counted per session (memory) rather than per install. */
  session?: boolean;
  /** Informational: shown once, then retired. */
  retireOnShow?: boolean;
}

/** The command's keycap under the active keymap (a TablePlus swap prints its own). */
const keys = (id: string, mac: boolean) => keysFor(id, mac);

export const TIPS: Record<TipId, TipDef> = {
  // The second retarget of the Preview tab in a session; a kept table retires it.
  "preview-reused": {
    text: (mac) => `Preview tab reused · ${mac ? "⌘" : "Ctrl"}-click a table to keep it`,
    where: "tab-row",
    after: 2,
    session: true,
  },
  // The first explicit chip in this install (it also unlocks type-to-filter).
  "type-to-filter": {
    text: () => "Type on a column to filter",
    where: "sql-line",
    after: 1,
  },
  // The third click on the Data | Structure | Map thumb; any of the chords retires it.
  "view-keys": {
    text: (mac) => `${keys("show-data", mac)} / ${keys("show-structure", mac)} / ${keys("show-map", mac)} switch Data, Structure and Map`,
    where: "view-switch",
    after: 3,
  },
  // The second drag of the same column within one result shape.
  "widths-remembered": {
    text: () => "Widths are remembered for this table",
    where: "grid-header",
    after: 2,
    retireOnShow: true,
  },
  // The third open of the database picker; ⌘↵ or ⌘-click in it retires it.
  "db-new-window": {
    // The picker's own key (not a registry command): ⌘↵ on a database row.
    text: (mac) => `${formatChord({ mac: "Mod+Enter" }, mac)} opens a database in a new window`,
    where: "db-picker",
    after: 3,
  },
};

const STORE_KEY = "rowkery.tips";
/** How long a tip stays before it fades (it is not retired by fading). */
const SHOWN_MS = 8000;

interface Saved {
  counts: Partial<Record<TipId, number>>;
  retired: TipId[];
  /** The local day (YYYY-MM-DD) a tip last showed: one a day. */
  shownOn?: string;
  /** ⌘K Hide tips. */
  off?: boolean;
}

export interface ShownTip {
  id: TipId;
  text: string;
  where: TipPlace;
  /** What it points at within its place (the dragged column). */
  anchor?: string;
}

let shown: ShownTip | null = null;
/** Earned while a query ran (or hidden by one starting): shows once it ends. */
let pending: ShownTip | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
const sessionCounts: Partial<Record<TipId, number>> = {};
/** Per-key counts for triggers counted on one thing (a column in a result shape). */
const keyCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function load(): Saved {
  const raw = readKey(STORE_KEY) as Partial<Saved> | undefined;
  return {
    counts: raw && typeof raw.counts === "object" && raw.counts ? { ...raw.counts } : {},
    retired: Array.isArray(raw?.retired) ? [...raw.retired] : [],
    shownOn: typeof raw?.shownOn === "string" ? raw.shownOn : undefined,
    off: raw?.off === true,
  };
}

function save(s: Saved) {
  writeKey(STORE_KEY, s);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emit() {
  for (const l of listeners) l();
}

function setShown(next: ShownTip | null) {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  shown = next;
  if (next) timer = setTimeout(() => setShown(null), SHOWN_MS);
  emit();
}

/**
 * Counts one trigger of `id` (`key`: count per thing, e.g. a column of one
 * result shape). Shows the tip when the count reaches its threshold and the
 * rules allow: not retired or off, nothing else showing, none shown today,
 * no query running. Returns whether it showed.
 */
export function noteTrigger(id: TipId, o: { key?: string; anchor?: string; mac?: boolean } = {}): boolean {
  const def = TIPS[id];
  const saved = load();
  if (saved.off || saved.retired.includes(id)) return false;
  let count: number;
  if (o.key !== undefined) {
    const k = `${id}\0${o.key}`;
    count = (keyCounts.get(k) ?? 0) + 1;
    keyCounts.set(k, count);
  } else if (def.session) {
    count = (sessionCounts[id] ?? 0) + 1;
    sessionCounts[id] = count;
  } else {
    count = (saved.counts[id] ?? 0) + 1;
    saved.counts[id] = count;
    save(saved);
  }
  if (count < def.after || shown || pending || saved.shownOn === today()) return false;
  saved.shownOn = today();
  if (def.retireOnShow) saved.retired.push(id);
  save(saved);
  const tip = { id, text: def.text(o.mac ?? isMacPlatform()), where: def.where, anchor: o.anchor };
  if (running) pending = tip;
  else setShown(tip);
  return true;
}

/** The user did what the tip teaches: it never shows again (and goes now). */
export function retireTip(id: TipId) {
  const saved = load();
  if (!saved.retired.includes(id)) {
    saved.retired.push(id);
    save(saved);
  }
  if (pending?.id === id) pending = null;
  if (shown?.id === id) setShown(null);
}

/** Its control went away (the picker closed): the tip goes too, unretired. */
export function dismissTip(id: TipId) {
  if (pending?.id === id) pending = null;
  if (shown?.id === id) setShown(null);
}

/** A query started (or ended) in the shown window: no tip while one runs. */
export function setQueryRunning(on: boolean) {
  if (on === running) return;
  running = on;
  if (on && shown) {
    // The gesture that earned it often starts a query (a retarget, a chip): it waits for the rows.
    pending = shown;
    setShown(null);
  } else if (!on && pending) {
    const next = pending;
    pending = null;
    setShown(next);
  }
}

/** ⌘K Hide tips: none show again. */
export function hideTips() {
  save({ ...load(), off: true });
  pending = null;
  setShown(null);
}

export function tipsHidden(): boolean {
  return load().off === true;
}

/** Whether ⌘K Hide tips was used; re-renders the caller when it is. */
export function useTipsHidden(): boolean {
  return useSyncExternalStore(subscribe, tipsHidden, tipsHidden);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The tip showing now, wherever it is. */
export function currentTip(): ShownTip | null {
  return shown;
}

/** The tip showing under `where`, if any. */
export function useTip(where: TipPlace): ShownTip | null {
  const tip = useSyncExternalStore(subscribe, () => shown);
  return tip?.where === where ? tip : null;
}

/** Tests: forget the session's counts and what is showing. */
export function resetTipsForTests() {
  for (const k of Object.keys(sessionCounts)) delete sessionCounts[k as TipId];
  keyCounts.clear();
  running = false;
  pending = null;
  setShown(null);
}
