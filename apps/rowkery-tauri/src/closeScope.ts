/**
 * What ⌘W (Ctrl+W) closes: the shown query tab, or the shown window (its
 * connection), whichever area was used last (2026-10-14).
 *
 * Areas carry `data-close-scope`: the title bar's window pills and the schema
 * column say "connection", the tab row, editor and results say "tab". A
 * pointer press or a focus inside one moves the scope there; anywhere else
 * (title bar tools, ⌘K, a sheet) leaves it as it was. Opening or switching a
 * query tab moves it back to "tab" (Workspace), so a table opened from the
 * schema column closes first.
 *
 * Pointer presses count, not only focus: WebKit doesn't focus a clicked
 * button, and the window pills aren't focusable at all.
 */

export type CloseScope = "tab" | "connection";

let scope: CloseScope = "tab";
const listeners = new Set<() => void>();

export function closeScope(): CloseScope {
  return scope;
}

export function setCloseScope(next: CloseScope) {
  if (next === scope) return;
  scope = next;
  for (const l of listeners) l();
}

/** For `useSyncExternalStore`: the menu bar's title follows the scope. */
export function subscribeCloseScope(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function fromEvent(e: Event) {
  const el = e.target instanceof Element ? e.target.closest("[data-close-scope]") : null;
  const s = el?.getAttribute("data-close-scope");
  if (s === "tab" || s === "connection") setCloseScope(s);
}

let installed = false;

/** Once, at start (main.tsx). Capture phase, so a handler that stops the event still counts. */
export function installCloseScope() {
  if (installed) return;
  installed = true;
  window.addEventListener("pointerdown", fromEvent, true);
  window.addEventListener("focusin", fromEvent, true);
}
