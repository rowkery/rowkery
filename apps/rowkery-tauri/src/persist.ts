import { invoke } from "@tauri-apps/api/core";

/**
 * The webview's saved state (windows and their tabs and SQL, the sidebar,
 * pins, history, keyword habits) lives in config.json beside the
 * connections, not in localStorage: it survives a webview data reset and
 * travels with the config. Values keep their old localStorage key names.
 *
 * Reads are synchronous from memory after `initPersist` (one IPC before the
 * first render). Writes change memory at once and reach disk at most once a
 * second (`save_ui_state`, then core's writer adds its own 500 ms debounce
 * and writes temp + rename off every hot thread), so typing SQL never costs a
 * write per keystroke. On the first launch of this release the old
 * localStorage keys are imported; for one release every flushed key is also
 * mirrored back to localStorage, so going back a version loses nothing.
 */

const VERSION = 1;
/** Writes wait this long for more changes (and SQL for the typing to pause). */
const FLUSH_AFTER_MS = 1000;
/** Old localStorage keys this state took over. */
const PREFIX = "rowkery.";

interface UiState {
  version: number;
  keys: Record<string, unknown>;
}

let state: UiState = { version: VERSION, keys: {} };
let ready: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const changed = new Set<string>();

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/**
 * A proof or end-to-end build runs on its own config dir, but WebKit keeps one
 * localStorage per app id: it neither imports what other builds left there
 * nor mirrors its state back over theirs.
 */
const proofBuild = () => !!import.meta.env.VITE_ROWKERY_AUTO_PROOF && inTauri();

function fromLocalStorage(): UiState {
  const keys: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        keys[key] = JSON.parse(raw);
      } catch {
        keys[key] = raw;
      }
    }
  } catch {
    // No storage (private window): start empty.
  }
  return { version: VERSION, keys };
}

function isUiState(v: unknown): v is UiState {
  return !!v && typeof v === "object" && typeof (v as UiState).keys === "object" && (v as UiState).keys !== null;
}

/**
 * Loads the saved state: config.json's, else (first launch of this release,
 * or no backend) the old localStorage keys. Call once before rendering.
 */
export function initPersist(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    let saved: unknown = null;
    if (inTauri()) {
      try {
        saved = await invoke("load_ui_state");
      } catch {
        // An older backend: localStorage below.
      }
    }
    if (isUiState(saved) && saved.version <= VERSION) {
      state = { version: VERSION, keys: { ...saved.keys } };
    } else if (proofBuild()) {
      state = { version: VERSION, keys: {} };
    } else {
      state = fromLocalStorage();
      // Imported: write it to config.json once.
      if (Object.keys(state.keys).length > 0) {
        for (const k of Object.keys(state.keys)) changed.add(k);
        schedule();
      }
    }
  })();
  return ready;
}

/** A saved value (as the old localStorage JSON held it), or undefined. */
export function readKey(key: string): unknown {
  return state.keys[key];
}

/** Saves a value; `undefined` removes it. Reaches disk within about a second. */
export function writeKey(key: string, value: unknown) {
  if (value === undefined) delete state.keys[key];
  else state.keys[key] = value;
  changed.add(key);
  schedule();
}

function schedule() {
  if (timer !== undefined) return;
  timer = setTimeout(flushPersist, FLUSH_AFTER_MS);
}

/** Sends pending changes now (page hidden, closing). */
export function flushPersist() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (changed.size === 0) return;
  const keys = [...changed];
  changed.clear();
  if (inTauri()) {
    void invoke("save_ui_state", { ui: state }).catch(() => {});
  }
  // The one-release mirror (and the only store when there is no backend).
  if (proofBuild()) return;
  try {
    for (const k of keys) {
      const v = state.keys[k];
      if (v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    }
  } catch {
    // Full or blocked storage: config.json still has it.
  }
}

if (typeof document !== "undefined") {
  // Don't lose the last second of typing to a quit or a reload.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
  window.addEventListener("pagehide", flushPersist);
}

/** Tests: start over with these keys. */
export function resetPersistForTests(keys: Record<string, unknown> = {}) {
  state = { version: VERSION, keys: { ...keys } };
  changed.clear();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  ready = Promise.resolve();
}
