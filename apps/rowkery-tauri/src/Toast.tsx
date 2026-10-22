import { useEffect, useState } from "react";
import { Presence } from "./motion";
import { commitPending, hasPendingUndo, liveOffer, onToast, runOffer, takeOffer, undoPending, type ToastMessage } from "./notify";
import { isMacPlatform } from "./platform";
import { Keys } from "./Keys";

/**
 * How long a toast stays: Paper's `toast` keyframes rise, hold and fade it
 * over the same 2.6 s (styles/toast.css). One with Undo or an offer holds longer and
 * fades on its exit instead.
 */
const TOAST_MS = 2600;
const UNDO_MS = 10_000;

function CheckIcon() {
  return (
    <svg className="toast-icon" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="toast-icon" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 4.5v4.5M8 11.5v.01" />
    </svg>
  );
}

/** Floating capsule over the main column, above the results card's foot. */
export function ToastHost() {
  const [toast, setToast] = useState<(ToastMessage & { seq: number }) | null>(
    null,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let seq = 0;
    return onToast((t) => {
      setToast({ ...t, seq: ++seq });
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!open || !toast) return;
    const timer = window.setTimeout(() => {
      setOpen(false);
      // Gone without Undo: the action is final.
      if (toast.undoable) commitPending();
      if (toast.offer) takeOffer();
    }, toast.undoable || toast.offer ? UNDO_MS : TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [open, toast]);

  const undo = () => {
    if (undoPending()) setOpen(false);
  };
  // ⌥⌘Z (Ctrl+Alt+Z) wherever focus is, while an Undo toast is live. ⌘Z
  // stays the native text undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
      if (mod && e.altKey && !e.shiftKey && e.code === "KeyZ" && hasPendingUndo()) {
        e.preventDefault();
        undo();
        return;
      }
      // An offer: ↵ takes it where the text went, Esc lets it go (the
      // key still does what it does there).
      const o = liveOffer();
      if (!o || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const inScope = !o.mouseOnly && (!o.scope || o.scope.contains(document.activeElement));
      if (e.key === "Enter" && inScope) {
        e.preventDefault();
        e.stopPropagation();
        if (runOffer()) setOpen(false);
      } else if (e.key === "Escape") {
        takeOffer();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const undoKey = isMacPlatform() ? "⌥⌘Z" : "Ctrl+Alt+Z";

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      <Presence open={open}>
        {toast && (
          // Keyed so a new toast replays its entry instead of swapping text.
          <div
            key={toast.seq}
            data-toast={toast.tone}
            data-held={toast.undoable || toast.offer ? "" : undefined}
            className={`toast${toast.tone === "error" ? " toast-error" : ""}`}
          >
            {toast.tone === "error" ? <ErrorIcon /> : <CheckIcon />}
            <span data-testid="toast-message" className="toast-message">{toast.message}</span>
            {toast.detail && (
              <span className="toast-detail">{toast.detail}</span>
            )}
            {toast.undoable && (
              <button type="button" className="toast-undo" data-toast-undo onClick={undo}>
                Undo <kbd><Keys text={undoKey} /></kbd>
              </button>
            )}
            {toast.offer && (
              <button
                type="button"
                className="toast-undo"
                data-toast-offer
                onClick={() => {
                  if (runOffer()) setOpen(false);
                }}
              >
                {/* A space before the key, as Undo has ("Connect ↵"). */}
                {toast.offer}
                {!toast.offerMouseOnly && <> <kbd>↵</kbd></>}
              </button>
            )}
          </div>
        )}
      </Presence>
    </div>
  );
}
