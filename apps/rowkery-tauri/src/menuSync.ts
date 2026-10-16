import { invoke } from "@tauri-apps/api/core";
import { menuState, type CommandState, type MenuItemState } from "./commands";
import { isMacPlatform } from "./platform";

/**
 * Keeps the macOS menu bar in step with the shown window: an item whose
 * command can't run now is disabled (never hidden), titles that read the
 * state (Show / Hide Sidebar) follow it, and accelerators follow the keymap.
 * Only what changed since the last push crosses IPC, so a render that changes
 * nothing costs one object walk.
 */

let sent: Record<string, MenuItemState> = {};

export interface MenuPush {
  id: string;
  enabled: boolean;
  title: string | null;
  accelerator: string | null;
}

/** The items whose state differs from what app_menu last heard. */
export function menuDiff(next: Record<string, MenuItemState>, prev: Record<string, MenuItemState>): MenuPush[] {
  const out: MenuPush[] = [];
  for (const [id, v] of Object.entries(next)) {
    const p = prev[id];
    if (p && p.enabled === v.enabled && p.title === v.title && p.accelerator === v.accelerator) continue;
    out.push({ id, enabled: v.enabled, title: v.title ?? null, accelerator: v.accelerator });
  }
  return out;
}

/** Pushes the shown window's command state to the menu bar (macOS app only). */
export function syncMenu(s: CommandState) {
  if (!isMacPlatform() || !("__TAURI_INTERNALS__" in window)) return;
  const next = menuState(s);
  const items = menuDiff(next, sent);
  if (items.length === 0) return;
  sent = next;
  void invoke("set_menu_state", { items }).catch(() => {
    // An older backend: the menu stays all enabled, as before.
  });
}
