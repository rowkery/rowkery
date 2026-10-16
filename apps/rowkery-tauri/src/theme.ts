import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Light or dark Paper (App.css `:root` / `:root[data-theme="dark"]`). The
 * setting is `auto` (follow the system), `light` or `dark`. It lives in
 * config.json as rowkery-core's typed `AppConfig.theme`, which core reads
 * before the window exists to give it the matching native appearance and
 * background (`set_theme_preference`, `get_theme_preference`).
 *
 * The page wears the resolved theme as `data-theme` on <html>. index.html
 * applies it before the bundle runs from `PAINT_KEY`, a copy of the setting
 * kept only for that first paint (config.json stays the truth: `initTheme`
 * corrects the page, and the copy, before the first render).
 */
export type ThemeSetting = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_SETTINGS: { value: ThemeSetting; label: string }[] = [
  { value: "auto", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The first-paint copy index.html reads. Not `rowkery.`-prefixed: persist.ts imports those keys. */
export const PAINT_KEY = "rowkery-paint-theme";

const listeners = new Set<() => void>();
let setting: ThemeSetting = "auto";
let current: { setting: ThemeSetting; theme: Theme } | null = null;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const isSetting = (v: unknown): v is ThemeSetting => v === "auto" || v === "light" || v === "dark";

export function themeSetting(): ThemeSetting {
  return setting;
}

/** What the page wears now. */
export function resolvedTheme(): Theme {
  return setting === "auto" ? systemTheme() : setting;
}

function snapshot() {
  const theme = resolvedTheme();
  if (!current || current.setting !== setting || current.theme !== theme) current = { setting, theme };
  return current;
}

/** Puts the resolved theme on <html> and the window, and keeps the paint copy. */
function applyTheme(save: boolean) {
  const { theme } = snapshot();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  // The pre-paint background (index.html) gives way to CSS.
  root.style.removeProperty("background");
  try {
    localStorage.setItem(PAINT_KEY, setting);
  } catch {
    // No storage: the next launch paints the system theme until config.json answers.
  }
  if (inTauri()) void invoke("set_theme_preference", { theme: setting, save }).catch(() => {});
  for (const l of listeners) l();
}

export function setThemeSetting(next: ThemeSetting) {
  setting = next;
  applyTheme(true);
}

/** Flips between light and dark: an explicit choice. */
export function toggleTheme() {
  setThemeSetting(resolvedTheme() === "dark" ? "light" : "dark");
}

let installed = false;
/** Reads the setting from config.json, applies it and follows the system on Auto. Call before the first render. */
export async function initTheme(): Promise<void> {
  if (inTauri()) {
    try {
      const saved = await invoke<unknown>("get_theme_preference");
      if (isSetting(saved)) setting = saved;
    } catch {
      // An older core: Auto.
    }
  } else {
    // A browser preview has no config.json: the paint copy is all there is.
    try {
      const v = localStorage.getItem(PAINT_KEY);
      if (isSetting(v)) setting = v;
    } catch {
      // Auto.
    }
  }
  applyTheme(false);
  if (installed || typeof window === "undefined" || !window.matchMedia) return;
  installed = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (setting === "auto") applyTheme(false);
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The setting and the resolved theme, re-rendering on change. */
export function useTheme(): { setting: ThemeSetting; theme: Theme } {
  return useSyncExternalStore(subscribe, snapshot);
}
