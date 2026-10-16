import window from "@/assets/img/window-dark.webp";

/**
 * The real app screens on the page (assets/img, dark .webp at 2x), rendered from the app
 * itself in Chromium, and their size in CSS pixels. They are imported, not served from
 * public/, so a build only ships the screens a page on it draws.
 */
export const SHOTS = {
  window: { src: window.src, width: 1280, height: 800 },
} as const satisfies Record<string, { src: string; width: number; height: number }>;

export type ShotName = keyof typeof SHOTS;
