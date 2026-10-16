import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RenderErrorBoundary } from "./ErrorBoundary";
import { FatalError } from "./FatalError";
import { isMacPlatform } from "./platform";
import { initTimings } from "./timings";

void initTimings();
import { initPersist } from "./persist";
import { installKeyTracker, noteMenuCommand } from "./keyTracker";
import { installCloseScope } from "./closeScope";
import { initWindowChrome } from "./windowChrome";
import { initTheme } from "./theme";
// IBM Plex Sans and Mono, the website's faces, self-hosted (no font requests leave the app).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/400-italic.css";

if (isMacPlatform()) document.documentElement.classList.add("platform-mac");

// No webview menu (Reload, Inspect Element) on app chrome. Text fields keep
// the native Cut / Copy / Paste menu, and so does selected text.
const TEXT_INPUT = /^(text|search|url|email|password|tel|number)$/;
document.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement | null;
  const editable =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_INPUT.test(el.type)) ||
    !!el?.isContentEditable;
  const selected = !(window.getSelection()?.isCollapsed ?? true);
  if (!editable && !selected) e.preventDefault();
});

// Counts shortcut use (the sheet, the key strip) and runs keymap-swapped chords.
installKeyTracker();
// Which area ⌘W closes from: the query tab or the window (closeScope.ts).
installCloseScope();

// macOS menu bar items come from commands.ts (`src-tauri/menu.json`); a pick
// arrives as `menu-command` with the command id, and the shown workspace runs
// it on `rowkery:command`. ⌘W is File > Close Tab, so it never closes the app.
if (isMacPlatform() && "__TAURI_INTERNALS__" in window) {
  void listen<string>("menu-command", (e) => {
    // A pick made with its accelerator (⌘W) counts as a use of the key.
    noteMenuCommand(e.payload);
    window.dispatchEvent(new CustomEvent("rowkery:command", { detail: e.payload }));
  }).catch(() => {});
}

// A window answered from the catalog cache hears back once its session is
// open (`catalog-update`); App applies it from `rowkery:catalog-update`, which
// stubbed proofs dispatch directly.
if ("__TAURI_INTERNALS__" in window) {
  void listen("catalog-update", (e) => {
    window.dispatchEvent(
      new CustomEvent("rowkery:catalog-update", { detail: e.payload }),
    );
  }).catch(() => {});
}

// Files dragged onto the window (Tauri gives paths; an HTML drop doesn't)
// arrive as `rowkery:file-drag` with `{ type, paths }`; stubbed proofs
// dispatch it directly.
if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        window.dispatchEvent(
          new CustomEvent("rowkery:file-drag", {
            detail: { type: p.type, paths: "paths" in p ? p.paths : [] },
          }),
        );
      }),
    )
    .catch(() => {});
}

/**
 * The window is created hidden; once the first render has committed, core
 * shows it (`app_ready`), so launch goes straight from nothing to the
 * restored window. Not on an animation frame: a hidden webview may not run
 * them.
 */
let shown = false;
function ShowWhenPainted({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Once, even when StrictMode runs effects twice.
    if (shown || !("__TAURI_INTERNALS__" in window)) return;
    shown = true;
    performance.mark("rowkery:window-shown");
    void invoke("app_ready").catch(() => {});
  }, []);
  return children;
}

// The saved windows, tabs and SQL come first (one IPC): the first render
// restores them instead of flashing an empty window. Alongside it, whether
// the system draws the window's controls (Linux / Windows), so the first
// render leaves no room for ours when it does.
// And the appearance (config.json's theme), so the first render wears it.
void Promise.allSettled([initPersist(), initWindowChrome(), initTheme()]).finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ShowWhenPainted>
        <RenderErrorBoundary
          fallback={(err) => <FatalError error={err} />}
        >
          <App />
        </RenderErrorBoundary>
      </ShowWhenPainted>
    </React.StrictMode>,
  );
});
