/**
 * How often you run each SQL keyword, across every connection, so completion
 * puts SELECT above SET once you've used it. Saved with the UI state (persist.ts) like query
 * history: a map of about a hundred keywords, read once, updated per run.
 */
import { keywordsIn } from "./sqlComplete";
import { readKey, writeKey } from "./persist";

const KEY = "rowkery.keywordHabits";
/** Days for a use to count half: last month's habits outweigh last year's. */
const HALF_LIFE_DAYS = 30;
const DAY = 86_400_000;

interface Stored {
  /** Decayed use count as of `at`. */
  n: number;
  at: number;
}

let stored: Record<string, Stored> | null = null;
let habits: Map<string, number> | null = null;

function decayed(s: Stored, now: number): number {
  return s.n * Math.pow(0.5, Math.max(0, now - s.at) / DAY / HALF_LIFE_DAYS);
}

function load(): Record<string, Stored> {
  if (stored) return stored;
  stored = {};
  try {
    const parsed: unknown = readKey(KEY) ?? {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const s = v as Stored;
        if (s && typeof s.n === "number" && typeof s.at === "number") stored[k] = s;
      }
    }
  } catch {
    // A convenience; starting over is fine.
  }
  return stored;
}

/** Decayed use count per keyword. The same map until the next run changes it. */
export function keywordHabits(): ReadonlyMap<string, number> {
  if (habits) return habits;
  const now = Date.now();
  habits = new Map(Object.entries(load()).map(([k, s]) => [k, decayed(s, now)]));
  return habits;
}

/** Count the keywords `sql` uses, each once. */
export function recordKeywords(sql: string, now = Date.now()) {
  const used = keywordsIn(sql);
  if (used.size === 0) return;
  const all = load();
  for (const k of used) {
    const prev = all[k];
    all[k] = { n: (prev ? decayed(prev, now) : 0) + 1, at: now };
  }
  habits = null;
  writeKey(KEY, all);
}
