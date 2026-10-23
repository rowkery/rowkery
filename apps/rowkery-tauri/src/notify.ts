/** One short confirmation at the foot of the window ("Copied", "Saved wallet"). */
export type ToastTone = "ok" | "error";

export interface ToastMessage {
  message: string;
  /** Dimmed monospace text after the message, such as the copied value. */
  detail?: string;
  tone?: ToastTone;
  /** The toast offers Undo (a button, ⌥⌘Z) and holds 10 s instead of 1.6. */
  undoable?: boolean;
  /** The toast offers to do something (a button, ↵ in `scope`); holds 10 s. */
  offer?: string;
  /** The offer is a button only (it arrived unasked); ↵ doesn't take it. */
  offerMouseOnly?: boolean;
}

/** A toast's offer: ↵ takes it while focus is in `scope`, Esc lets it go. */
export interface Offer {
  run: () => void;
  scope?: Element | null;
  /** "error" when the toast says something is wrong ("No column nam"). */
  tone?: ToastTone;
  /** Only its button takes it: for a toast nobody asked for (an agent's refusal). */
  mouseOnly?: boolean;
}

let offer: Offer | null = null;

/** Toasts shown so far: an offer's action that shows its own toast keeps it open. */
let shown = 0;
export function toastsShown(): number {
  return shown;
}

/** Takes the live offer and runs it; true when its action showed no toast of its own (close the one on screen). */
export function runOffer(): boolean {
  const before = shown;
  takeOffer()?.run();
  return shown === before;
}

/** The live offer, taken once; null when none. */
export function takeOffer(): Offer | null {
  const o = offer;
  offer = null;
  return o;
}

export function liveOffer(): Offer | null {
  return offer;
}

/**
 * "Looks like a connection URL · Connect ↵ · Esc keeps the text": a toast
 * whose button (or ↵ where the text went) does `run`. Any other toast drops it.
 */
export function showOfferToast(message: string, label: string, detail: string | undefined, o: Offer) {
  commitPending();
  shown++;
  window.dispatchEvent(
    new CustomEvent<ToastMessage>(EVENT, { detail: { message, detail, tone: o.tone ?? "ok", offer: label, offerMouseOnly: o.mouseOnly } }),
  );
  offer = o;
}

/** A reversible action's two endings: put it back, or make it final. */
export interface Undoable {
  undo: () => void;
  /** The deferred part (removing keychain entries…); runs when the toast leaves any way but Undo. */
  commit?: () => void;
}

let pending: Undoable | null = null;

/** Makes the pending action final (a new toast replaced it, or it timed out). */
export function commitPending() {
  const p = pending;
  pending = null;
  p?.commit?.();
}

/** Undo for the live toast; false when nothing is pending. */
export function undoPending(): boolean {
  const p = pending;
  if (!p) return false;
  pending = null;
  p.undo();
  return true;
}

export function hasPendingUndo(): boolean {
  return pending !== null;
}

/**
 * "Closed Query 2 · Undo": the action already happened; Undo puts it back
 * while the toast is live (10 s). Any other toast commits it first.
 */
export function showUndoToast(message: string, detail: string | undefined, action: Undoable) {
  commitPending();
  offer = null;
  shown++;
  window.dispatchEvent(
    new CustomEvent<ToastMessage>(EVENT, { detail: { message, detail, tone: "ok", undoable: true } }),
  );
  pending = action;
}

const EVENT = "rowkery:toast";

/** Shows a toast in the `ToastHost`; a new one replaces the one on screen. */
export function showToast(
  message: string,
  detail?: string,
  tone: ToastTone = "ok",
) {
  commitPending();
  offer = null;
  shown++;
  window.dispatchEvent(
    new CustomEvent<ToastMessage>(EVENT, { detail: { message, detail, tone } }),
  );
}

export function onToast(listener: (toast: ToastMessage) => void): () => void {
  const handle = (e: Event) =>
    listener((e as CustomEvent<ToastMessage>).detail);
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}

/** Copied values can be long or span lines; the toast shows one short line. */
export function toastPreview(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** At most one "went wrong" toast in this long; every one is still logged. */
const STRAY_ERROR_QUIET_MS = 10_000;
let lastStrayToast = -Infinity;

/**
 * A promise nobody waited on failed: says so in one toast, then stays quiet
 * for a while, so a failing loop can't flood the screen. Returns whether it
 * toasted.
 */
export function toastStrayError(reason: unknown, now = performance.now()): boolean {
  console.error("Rowkery: unhandled rejection", reason);
  if (now - lastStrayToast < STRAY_ERROR_QUIET_MS) return false;
  lastStrayToast = now;
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : undefined;
  showToast("Something went wrong", detail ? toastPreview(detail, 120) : undefined, "error");
  return true;
}

/** Toasts unhandled promise rejections (`toastStrayError`) instead of dropping them. */
export function installStrayErrorToast() {
  window.addEventListener("unhandledrejection", (e) => toastStrayError(e.reason));
}
