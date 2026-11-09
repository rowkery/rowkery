import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readKey, writeKey } from "./persist";
import { showToast } from "./notify";

/**
 * The GitHub star card (2026-11-08): once Rowkery has been used on five
 * different days (a day counts when the shown tab starts a query, a table
 * read or an export, including the read a restored table tab runs at
 * launch, so opening Rowkery on a table counts), a card
 * above the schema column's foot asks for a star. Star on GitHub or × ends
 * it for good. The app is offline, so it can't know whether a star was
 * given: the click is the answer. Help > Star Rowkery on GitHub stays.
 * Kept in config.json (`rowkery.starAsk`); there is no install date, so an
 * existing install starts counting on the release that brings the card.
 */
const KEY = "rowkery.starAsk";

/** Days of use before the card shows. */
export const STAR_AFTER_DAYS = 5;

interface Saved {
  /** Different local days counted (up to STAR_AFTER_DAYS). */
  days: number;
  /** The local day (YYYY-MM-DD) last counted. */
  lastDay?: string;
  /** Starred or dismissed: never again. */
  done?: boolean;
}

const listeners = new Set<() => void>();

function load(): Saved {
  const raw = readKey(KEY) as Partial<Saved> | undefined;
  return {
    days: typeof raw?.days === "number" && raw.days > 0 ? raw.days : 0,
    lastDay: typeof raw?.lastDay === "string" ? raw.lastDay : undefined,
    ...(raw?.done === true ? { done: true } : {}),
  };
}

function save(s: Saved) {
  writeKey(KEY, s);
  for (const l of listeners) l();
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A query started: counts today once. */
export function noteUseDay() {
  const s = load();
  const day = today();
  if (s.done || s.days >= STAR_AFTER_DAYS || s.lastDay === day) return;
  save({ ...s, days: s.days + 1, lastDay: day });
}

export function starAskDue(): boolean {
  const s = load();
  return !s.done && s.days >= STAR_AFTER_DAYS;
}

/** Whether the card shows; re-renders the caller when that changes. */
export function useStarAskDue(): boolean {
  return useSyncExternalStore(subscribe, starAskDue, starAskDue);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** × on the card, or a star given: the card never shows again. */
export function endStarAsk() {
  const s = load();
  if (!s.done) save({ ...s, done: true });
}

/**
 * Star on GitHub (the card, Help, ⌘K): opens the repository in the browser
 * (core holds the URL) and ends the card once it opened; if it couldn't,
 * the card stays and a toast says so.
 */
export function starOnGitHub() {
  invoke("open_repo_page").then(endStarAsk, (e) => showToast("Couldn't open GitHub", String(e), "error"));
}
