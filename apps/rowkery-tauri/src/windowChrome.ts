import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./notify";
import { isMacPlatform } from "./platform";

/**
 * Linux / Windows window chrome. By default the window has no system title
 * bar and the page draws its own buttons (`WindowControls.tsx`); with
 * `native_decorations` in config.json the system draws them instead.
 * Decorations are fixed when core creates the window, before the page loads,
 * so the switch (⌘K) is saved for the next launch and this launch keeps its
 * chrome. macOS always has native traffic lights over the content.
 *
 * `native` is how this window was created: `:root.native-decorations` drops
 * the room kept for the drawn buttons. Read once before the first render.
 */
interface WindowChrome {
  native: boolean;
  saved: boolean;
}

let chrome: WindowChrome = { native: false, saved: false };

export async function initWindowChrome(): Promise<void> {
  if (isMacPlatform() || !("__TAURI_INTERNALS__" in window)) return;
  try {
    const got = await invoke<Partial<WindowChrome> | null>("window_chrome");
    chrome = { native: got?.native === true, saved: got?.saved === true };
  } catch {
    return;
  }
  document.documentElement.classList.toggle("native-decorations", chrome.native);
}

/** The system draws this window's title bar and buttons. */
export function nativeDecorations(): boolean {
  return chrome.native;
}

/** What the next launch will use. */
export function savedNativeDecorations(): boolean {
  return chrome.saved;
}

/** ⌘K: flips the saved switch; it shows on the next launch. */
export async function toggleNativeDecorations(): Promise<void> {
  const on = !chrome.saved;
  // Set first, so ⌘K's title reads the new state when it re-renders.
  chrome = { ...chrome, saved: on };
  try {
    await invoke("set_native_decorations", { on });
  } catch (e) {
    chrome = { ...chrome, saved: !on };
    showToast("Couldn't save the window setting", String(e), "error");
    return;
  }
  showToast(
    on === chrome.native
      ? "The next launch keeps these window controls"
      : on
        ? "System window controls from the next launch"
        : "Rowkery window controls from the next launch",
  );
}
