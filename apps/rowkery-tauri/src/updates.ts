import { invoke } from "@tauri-apps/api/core";
import { showOfferToast, showToast } from "./notify";

/**
 * In-app updates (src-tauri/src/updates.rs): a quiet check after launch and
 * every few hours, and Help > Check for Updates…. A newer release downloads
 * in the background; the toast offers Restart, and quitting installs it
 * anyway. Nothing restarts on its own, and Restart waits while a query runs.
 */

/** What `check_for_update` answers. */
export type UpdateStatus =
  | { status: "off" }
  | { status: "up-to-date"; version: string }
  | { status: "ready"; version: string; notes: string | null };

/** The quiet check waits this long after launch (the first query comes first), then repeats. */
export const FIRST_CHECK_MS = 15_000;
export const RECHECK_MS = 6 * 60 * 60 * 1000;

export type UpdateToast =
  | { kind: "none" }
  | { kind: "say"; message: string; detail?: string; tone?: "ok" | "error" }
  | { kind: "offer"; version: string };

/** What a check says: a quiet one speaks only when an update is ready; a menu pick always answers. */
export function updateToast(result: UpdateStatus | { error: string }, manual: boolean): UpdateToast {
  if ("error" in result) {
    return manual ? { kind: "say", message: "Couldn't check for updates", detail: result.error, tone: "error" } : { kind: "none" };
  }
  if (result.status === "ready") return { kind: "offer", version: result.version };
  if (!manual) return { kind: "none" };
  if (result.status === "off") return { kind: "say", message: "This build doesn't update itself" };
  return { kind: "say", message: "Rowkery is up to date", detail: result.version };
}

/** Why Restart has to wait, or null: `running` queries across every window. */
export function restartBlocker(running: number): string | null {
  if (running <= 0) return null;
  return running === 1 ? "A query is running" : `${running} queries are running`;
}

/** Asks for an update and says what came of it (`updateToast`). */
export async function lookForUpdate(manual: boolean, running: () => number): Promise<void> {
  if (manual) showToast("Checking for updates…");
  let result: UpdateStatus | { error: string };
  try {
    // Nothing back (a build or stub without the updater) reads as couldn't check.
    result = (await invoke<UpdateStatus | null>("check_for_update")) ?? { error: "no answer" };
  } catch (e) {
    result = { error: String(e) };
  }
  const toast = updateToast(result, manual);
  if (toast.kind === "say") showToast(toast.message, toast.detail, toast.tone);
  if (toast.kind === "offer") offerRestart(toast.version, running);
}

function offerRestart(version: string, running: () => number) {
  showOfferToast(`Rowkery ${version} is ready`, "Restart", "or it installs when you quit", {
    run: () => {
      const blocker = restartBlocker(running());
      if (blocker) return showToast(blocker, "Restart once it finishes, or quit to install");
      invoke("restart_to_update").catch((e) => showToast("Couldn't install the update", String(e), "error"));
    },
  });
}
