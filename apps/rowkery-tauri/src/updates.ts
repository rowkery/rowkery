import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showOfferToast, showToast } from "./notify";
import { readKey, writeKey } from "./persist";

/**
 * In-app updates (src-tauri/src/updates.rs): a quiet check after launch and
 * every few hours, Rowkery > Check for Updates…, and Settings > Updates.
 * The update preference says what a newer release does:
 *
 * - Automatic: downloads, then restarts into it once Rowkery is idle
 *   (`idleEnough`) and no tab holds an open transaction.
 * - Download only (the default): downloads; the toast and the orange button
 *   at the schema column's foot offer Restart, and quitting installs it.
 * - Notify only: the orange button appears; Download in Settings fetches it.
 * - Off: no quiet checks (Check for Updates… still asks).
 *
 * Restart waits while a query runs.
 */

/** What `check_for_update` and `download_update` answer. */
export type UpdateStatus =
  | { status: "off" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; notes: string | null }
  | { status: "ready"; version: string; notes: string | null };

export type UpdatePref = "auto" | "download" | "notify" | "off";

/** Settings > Updates' choices, most automatic first. */
export const UPDATE_PREFS: { value: UpdatePref; label: string; detail: string }[] = [
  { value: "auto", label: "Automatic", detail: "Installs on its own while Rowkery is idle" },
  { value: "download", label: "Download only", detail: "Downloads, installs when you restart" },
  { value: "notify", label: "Notify only", detail: "Tells you, downloads when you say so" },
  { value: "off", label: "Off", detail: "Never checks" },
];

const PREF_KEY = "rowkery.updates";
export const DEFAULT_UPDATE_PREF: UpdatePref = "download";

/** The quiet check waits this long after launch (the first query comes first), then repeats. */
export const FIRST_CHECK_MS = 15_000;
export const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Automatic restarts only after this long without a key or click, and unfocused. */
export const IDLE_MS = 10 * 60 * 1000;

/** Where updating stands, for Settings > Updates and the foot's button. */
export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "off" }
  | { phase: "up-to-date"; version: string }
  | { phase: "error"; message: string }
  | { phase: "available"; version: string; notes: string | null }
  | { phase: "downloading"; version: string; notes: string | null }
  | { phase: "ready"; version: string; notes: string | null };

let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const l of listeners) l();
}

function setState(next: UpdateState) {
  state = next;
  emit();
}

export function updateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, updateState, updateState);
}

/** Tests: start over. */
export function resetUpdatesForTests(next: UpdateState = { phase: "idle" }) {
  state = next;
  emit();
}

export function updatePref(): UpdatePref {
  const v = readKey(PREF_KEY);
  return UPDATE_PREFS.some((p) => p.value === v) ? (v as UpdatePref) : DEFAULT_UPDATE_PREF;
}

/** Saves the preference; one found and not downloaded downloads now if the new choice does. */
export function setUpdatePref(next: UpdatePref) {
  if (next === updatePref()) return;
  writeKey(PREF_KEY, next === DEFAULT_UPDATE_PREF ? undefined : next);
  emit();
  if (state.phase === "available" && downloads(next)) void downloadUpdate();
}

export function useUpdatePref(): UpdatePref {
  return useSyncExternalStore(subscribe, updatePref, updatePref);
}

/** Whether a found release downloads without asking. */
const downloads = (pref: UpdatePref) => pref === "auto" || pref === "download";

/** The foot's orange button: a newer release waits for the user. Automatic installs on its own. */
export function updateWaiting(s: UpdateState, pref: UpdatePref): boolean {
  if (s.phase === "available" || s.phase === "downloading") return true;
  return s.phase === "ready" && pref !== "auto";
}

export type UpdateToast =
  | { kind: "none" }
  | { kind: "say"; message: string; detail?: string; tone?: "ok" | "error" }
  | { kind: "offer"; version: string }
  | { kind: "available"; version: string };

/**
 * What a check says. A quiet one speaks only when an update is ready to
 * restart into (not under Automatic, which restarts on its own); one found
 * and not downloaded shows as the foot's button. A menu pick always answers.
 */
export function updateToast(
  result: UpdateStatus | { error: string },
  manual: boolean,
  pref: UpdatePref = DEFAULT_UPDATE_PREF,
): UpdateToast {
  if ("error" in result) {
    return manual ? { kind: "say", message: "Couldn't check for updates", detail: result.error, tone: "error" } : { kind: "none" };
  }
  if (result.status === "ready") return manual || pref !== "auto" ? { kind: "offer", version: result.version } : { kind: "none" };
  if (!manual) return { kind: "none" };
  if (result.status === "available") return { kind: "available", version: result.version };
  if (result.status === "off") return { kind: "say", message: "This build doesn't update itself" };
  return { kind: "say", message: "Rowkery is up to date", detail: result.version };
}

/** Why Restart has to wait, or null: `running` queries across every window. */
export function restartBlocker(running: number): string | null {
  if (running <= 0) return null;
  return running === 1 ? "A query is running" : `${running} queries are running`;
}

function stateOf(result: UpdateStatus | { error: string }): UpdateState {
  if ("error" in result) return { phase: "error", message: result.error };
  if (result.status === "off") return { phase: "off" };
  if (result.status === "up-to-date") return { phase: "up-to-date", version: result.version };
  return { phase: result.status, version: result.version, notes: result.notes };
}

let running: () => number = () => 0;

/** Asks for an update and says what came of it (`updateToast`). */
export async function lookForUpdate(manual: boolean, runningNow: () => number): Promise<void> {
  running = runningNow;
  const pref = updatePref();
  if (!manual && pref === "off") return;
  const before = state;
  if (manual) {
    showToast("Checking for updates…");
    if (before.phase !== "available" && before.phase !== "downloading") setState({ phase: "checking" });
  }
  let result: UpdateStatus | { error: string };
  try {
    // Nothing back (a build or stub without the updater) reads as couldn't check.
    result = (await invoke<UpdateStatus | null>("check_for_update", { download: downloads(pref) })) ?? { error: "no answer" };
  } catch (e) {
    result = { error: String(e) };
  }
  // A quiet check that fails leaves what was known; a found release stays found.
  if (!("error" in result) || manual) {
    if (!(before.phase === "downloading" && "status" in result && result.status === "available")) setState(stateOf(result));
  }
  const toast = updateToast(result, manual, pref);
  if (toast.kind === "say") showToast(toast.message, toast.detail, toast.tone);
  if (toast.kind === "offer") offerRestart(toast.version);
  if (toast.kind === "available") showToast(`Rowkery ${toast.version} is out`, "Download it in Settings > Updates");
}

/** Notify only's Download: fetches the release found, then offers Restart. */
export async function downloadUpdate(): Promise<void> {
  if (state.phase !== "available" && state.phase !== "error") return;
  const found = state.phase === "available" ? state : null;
  if (found) setState({ phase: "downloading", version: found.version, notes: found.notes });
  let result: UpdateStatus | { error: string };
  try {
    result = (await invoke<UpdateStatus | null>("download_update")) ?? { error: "no answer" };
  } catch (e) {
    result = { error: String(e) };
  }
  if ("error" in result) {
    if (found) setState(found);
    showToast("Couldn't download the update", result.error, "error");
    return;
  }
  setState(stateOf(result));
  if (result.status === "ready") offerRestart(result.version);
}

/** Restart into the downloaded release, unless a query runs. */
export function restartToUpdate() {
  const blocker = restartBlocker(running());
  if (blocker) return showToast(blocker, "Restart once it finishes, or quit to install");
  invoke("restart_to_update").catch((e) => showToast("Couldn't install the update", String(e), "error"));
}

function offerRestart(version: string) {
  showOfferToast(`Rowkery ${version} is ready`, "Restart", "or it installs when you quit", { run: restartToUpdate });
}

/** Automatic's moment to restart: unfocused, no key or click for `IDLE_MS`, nothing running. */
export function idleEnough(o: { now: number; lastInput: number; focused: boolean; running: number }): boolean {
  return !o.focused && o.running === 0 && o.now - o.lastInput >= IDLE_MS;
}

/**
 * Automatic: once an update is ready, restarts into it the first time the app
 * is idle (`idleEnough`) and no tab holds an open transaction. Windows and
 * tabs come back as they were. Returns the cleanup.
 */
export function watchIdleInstall(runningNow: () => number): () => void {
  let lastInput = Date.now();
  const touch = () => {
    lastInput = Date.now();
  };
  window.addEventListener("keydown", touch, true);
  window.addEventListener("pointerdown", touch, true);
  let busy = false;
  const tick = async () => {
    if (busy || state.phase !== "ready" || updatePref() !== "auto") return;
    if (!idleEnough({ now: Date.now(), lastInput, focused: document.hasFocus(), running: runningNow() })) return;
    busy = true;
    try {
      const held = await invoke<boolean | null>("holds_open_transaction").catch(() => true);
      if (held === false && idleEnough({ now: Date.now(), lastInput, focused: document.hasFocus(), running: runningNow() }))
        await invoke("restart_to_update");
    } catch {
      // It installs on quit instead.
    } finally {
      busy = false;
    }
  };
  const timer = window.setInterval(() => void tick(), 60_000);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("keydown", touch, true);
    window.removeEventListener("pointerdown", touch, true);
  };
}
