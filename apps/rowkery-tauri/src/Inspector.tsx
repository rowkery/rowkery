import { forwardRef, useEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { ChevronLeftIcon, CloseIcon } from "./icons";
import { readKey, writeKey } from "./persist";
import "./Inspector.css";

/**
 * The inspector: the column at the main column's right that hosts Quick Look,
 * New connection and Review SQL (Paper, 2026-10-10: "a row opens on
 * the right, not over the data"), and the Sessions tab's picked session. It takes its width from the main column, so
 * nothing it shows covers a row. 340 px (Quick Look 280 under 1100 px);
 * New connection 380; each as dragged on its left edge (InspectorResize).
 * Widths live in Inspector.css.
 *
 * Mount it inside `<Presence>`: it slides in from the right on mount and
 * fades out, shorter, while Presence holds it closing.
 */
export type InspectorKind = "quicklook" | "connect" | "review" | "session" | "import";

type DataProps = { [data: `data-${string}`]: unknown };

export const Inspector = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & DataProps & { kind: InspectorKind }>(
  function Inspector({ kind, className, style, children, ...rest }, ref) {
    return (
      <aside
        ref={ref}
        className={`inspector${className ? ` ${className}` : ""}`}
        data-inspector={kind}
        style={style}
        {...rest}
      >
        <InspectorResize kind={kind} />
        {children}
      </aside>
    );
  },
);

/** Dragged widths: 320 px to 60% of the window (2026-10-13). */
export const INSPECTOR_MIN = 320;
const inspectorMax = () => Math.round(window.innerWidth * 0.6);
const widthKey = (kind: InspectorKind) => `rowkery.inspectorWidth.${kind}`;
const widthVar = (kind: InspectorKind) => `--insp-${kind}`;

/**
 * The column's left edge: drag to widen or narrow it (the main column gives
 * or takes the room), double-click for the kind's default. Each kind keeps
 * its own width in config.json (persist.ts); the app frame carries it as
 * `--insp-<kind>` so the main column, ⌘K and the toasts follow.
 */
function InspectorResize({ kind }: { kind: InspectorKind }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = ref.current?.closest<HTMLElement>(".app-frame");
    const saved = Number(readKey(widthKey(kind)));
    if (frame && Number.isFinite(saved) && saved > 0)
      frame.style.setProperty(widthVar(kind), `${Math.min(inspectorMax(), Math.max(INSPECTOR_MIN, saved))}px`);
  }, [kind]);
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const aside = handle.parentElement;
    const frame = handle.closest<HTMLElement>(".app-frame");
    if (!aside || !frame || e.button !== 0) return;
    e.preventDefault();
    const w0 = aside.getBoundingClientRect().width;
    const x0 = e.clientX;
    let width = Math.round(w0);
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "";
    aside.dataset.resizing = "";
    frame.classList.add("inspector-resizing");
    const move = (m: PointerEvent) => {
      width = Math.round(Math.min(inspectorMax(), Math.max(INSPECTOR_MIN, w0 + x0 - m.clientX)));
      frame.style.setProperty(widthVar(kind), `${width}px`);
    };
    const up = () => {
      delete handle.dataset.dragging;
      delete aside.dataset.resizing;
      frame.classList.remove("inspector-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      writeKey(widthKey(kind), width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const reset = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.closest<HTMLElement>(".app-frame")?.style.removeProperty(widthVar(kind));
    writeKey(widthKey(kind), null);
  };
  return (
    <div
      ref={ref}
      className="insp-resize"
      data-testid="insp-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the inspector"
      onPointerDown={start}
      onDoubleClick={reset}
    />
  );
}

/** The 42 px head row: the kind's title on the left, its buttons and × on the right. */
export function InspectorHead({
  children,
  tools,
  onClose,
  "data-testid": testid,
}: {
  children: ReactNode;
  tools?: ReactNode;
  onClose: () => void;
  "data-testid"?: string;
}) {
  return (
    <header className="insp-head" data-testid={testid} data-tauri-drag-region>
      {children}
      <span className="insp-gap" />
      {tools}
      <InspectorButton label="Close  esc" ariaLabel="Close" data-inspector-close onClick={onClose}>
        <CloseIcon size={10} />
      </InspectorButton>
    </header>
  );
}

/** A 24 px icon button in the head. Pressing it never takes the focus from the grid. */
export function InspectorButton({
  label,
  ariaLabel,
  onClick,
  disabled,
  children,
  ...rest
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
} & DataProps) {
  return (
    <button
      type="button"
      className="insp-icon"
      title={label}
      aria-label={ariaLabel}
      disabled={disabled}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * A full-window page's way out (Agents, Settings; 2026-10-17): first in its
 * head, where the eye starts, naming where it goes with Esc beside it.
 */
export function PageBack({ to, onBack }: { to: string; onBack: () => void }) {
  return (
    <button type="button" className="page-back" data-testid="page-back" title={`Back to ${to}  esc`} onClick={onBack}>
      <ChevronLeftIcon size={12} />
      <span className="page-back-to">{to}</span>
      <kbd>esc</kbd>
    </button>
  );
}

/**
 * A full-window page keeps the keys: when the focused control goes away
 * (a sheet closes, a confirm row turns back into its button) focus would
 * fall to the body, where Esc reaches nothing. It comes back to the page.
 */
export function usePageFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t = 0;
    const onOut = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (el.isConnected && (document.activeElement === document.body || document.activeElement === null)) el.focus({ preventScroll: true });
      });
    };
    // On the document, so focus dropped by an overlay over the page (the
    // shortcut sheet) comes back too. A focused node that is removed fires
    // no focusout, so removals inside the page are watched as well.
    document.addEventListener("focusout", onOut);
    const removed = new MutationObserver(onOut);
    removed.observe(el, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("focusout", onOut);
      removed.disconnect();
    };
  }, [ref]);
}
