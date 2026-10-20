import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rowKeys, type MenuRow } from "./contextMenus";
import { Presence, useGlideHover } from "./motion";
import { isMacPlatform } from "./platform";
import "./GridMenu.css";
import { Keys } from "./Keys";
import { TYPE_SELECT_PAUSE_MS, typeSelect } from "./typeSelect";

/** A menu row; its key comes from `command` (commands.ts), never typed here. */
export type GridMenuItem = MenuRow;

interface Props {
  /** Where the pointer was right-clicked; null when closed. */
  at: { x: number; y: number } | null;
  items: GridMenuItem[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** A dim line under the rows. */
  footer?: string;
  /** Names the menu for proofs (`data-menu`). */
  name?: string;
  /** What VoiceOver calls the menu ("Cell", "Tab"). */
  label: string;
}

/** Keeps the menu this far from the window's edges. */
const EDGE = 8;

/**
 * The app's one HTML menu: right-click menus on the grid, panel rows, tabs,
 * window pills and chips, and the pickers that drop from a control (safe mode,
 * page size, history). Keys sit right-aligned, read from the registry. HTML
 * rather than native, so each pick runs inside a click and the clipboard
 * accepts the write (WebKit refuses `clipboard.writeText` outside a user
 * gesture). ↑↓ move, typing a row's first letters moves to it, ↵ picks,
 * Esc, a click outside, a scroll or blur close.
 */
export function GridMenu({ at, items, onPick, onClose, footer, name, label }: Props) {
  return createPortal(
    <Presence open={!!at}>
      {at && (
        <MenuPanel at={at} items={items} onPick={onPick} onClose={onClose} footer={footer} name={name} label={label} />
      )}
    </Presence>,
    document.body,
  );
}

/** Opens a right-click menu at the pointer: `open(e)` as `onContextMenu`, `at` for `GridMenu`. */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; target: T } | null>(null);
  // Stable, so the open menu doesn't rebind its listeners on every render.
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback(
    (e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, target: T) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ at: { x: e.clientX, y: e.clientY }, target });
    },
    [],
  );
  return { at: menu?.at ?? null, target: menu?.target, open, close };
}

function MenuPanel({
  at,
  items,
  onPick,
  onClose,
  footer,
  name,
  label,
}: {
  at: { x: number; y: number };
  items: GridMenuItem[];
  onPick: (id: string) => void;
  onClose: () => void;
  footer?: string;
  name?: string;
  label: string;
}) {
  const choice = items.some((i) => i.checked !== undefined);
  const mac = isMacPlatform();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; maxH?: number }>(at);
  const [cursor, setCursor] = useState(-1);
  // The pointer's row is the cursor too (↵ picks it), but its fill is the
  // glide highlight; only a cursor the arrows moved paints its own.
  const [keyed, setKeyed] = useState(false);
  useGlideHover(ref, ".grid-menu-item");
  // Focus stays on the menu; VoiceOver reads the cursor's row through aria-activedescendant.
  const idBase = useId();
  /** What had focus when the menu opened. */
  const opener = useRef<HTMLElement | null>(null);
  /** Letters typed for type-to-select, and when the last one came. */
  const typed = useRef({ text: "", at: 0 });

  // Open at the pointer; flip left or up when it would leave the window. A
  // long list (a wide table's columns) stops at min(420 px, the room on its
  // side) and scrolls itself (2026-10-13).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width } = el.getBoundingClientRect();
    const height = el.scrollHeight;
    const below = window.innerHeight - at.y - EDGE;
    const above = at.y - EDGE;
    const up = height > below && above > below;
    const maxH = Math.min(420, up ? above : below);
    const h = Math.min(height, maxH);
    setPos({
      x: at.x + width + EDGE > window.innerWidth ? Math.max(EDGE, at.x - width) : at.x,
      y: up ? Math.max(EDGE, at.y - h) : at.y,
      maxH,
    });
    if (!opener.current && document.activeElement instanceof HTMLElement && !el.contains(document.activeElement))
      opener.current = document.activeElement;
    el.focus({ preventScroll: true });
    setCursor(-1);
  }, [at]);

  // A long list scrolls to follow the keyboard's cursor.
  useEffect(() => {
    if (keyed && cursor >= 0)
      ref.current?.querySelectorAll(".grid-menu-item")[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor, keyed]);

  // Closing hands the keyboard back to what had it (the grid, a tab), like a
  // native menu, unless a pick moved focus somewhere on purpose.
  useEffect(
    () => () => {
      const back = opener.current;
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
    },
    [],
  );

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    // A wheel over the menu scrolls the menu (and stops at its edges); one
    // anywhere else closes it without moving what it points at (2026-10-13:
    // the grid used to scroll behind an open column list).
    const onWheel = (e: WheelEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [onClose]);

  // Hand the keyboard back as the menu closes, not once its exit animation
  // ends: until then the closing menu held focus and swallowed keys (⌘K
  // right after Esc did nothing). A pick that moved focus keeps it there.
  const close = () => {
    const back = opener.current;
    if (back?.isConnected && ref.current?.contains(document.activeElement)) back.focus({ preventScroll: true });
    onClose();
  };
  const pick = (id: string) => {
    onPick(id);
    close();
  };

  return (
    <div
      ref={ref}
      className={`grid-menu${choice ? " grid-menu-choice" : ""}`}
      data-menu={name}
      role="menu"
      aria-label={label}
      aria-activedescendant={cursor >= 0 && items[cursor] ? `${idBase}-${cursor}` : undefined}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, maxHeight: pos.maxH }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // React bubbles portal events to the grid: keep its arrows and Esc to the menu.
        e.stopPropagation();
        if (e.key === "Escape") {
          // preventDefault also keeps a running query from being cancelled.
          e.preventDefault();
          close();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setKeyed(true);
          setCursor((c) => (c < 0 ? (step > 0 ? 0 : items.length - 1) : (c + step + items.length) % items.length));
        } else if (e.key === "Enter" && cursor >= 0) {
          e.preventDefault();
          const item = items[cursor];
          if (item) pick(item.id);
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // Type-to-select, like a Mac menu. A space only counts mid-word ("more than").
          const now = performance.now();
          const fresh = now - typed.current.at > TYPE_SELECT_PAUSE_MS;
          if (e.key === " " && (fresh || !typed.current.text)) return;
          e.preventDefault();
          typed.current = { text: (fresh ? "" : typed.current.text) + e.key, at: now };
          setKeyed(true);
          setCursor(typeSelect(items.map((i) => i.label), cursor, typed.current.text));
        }
      }}
    >
      {items.map((item, i) => {
        const keys = rowKeys(item, mac);
        return [
          item.separated && i > 0 && <div key={`${item.id}:sep`} data-testid="grid-menu-sep" className="grid-menu-sep" role="separator" />,
          <button
            key={item.id}
            id={`${idBase}-${i}`}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            data-item={item.id}
            data-keys={keys}
            className={`grid-menu-item${i === cursor ? " is-cursor" : ""}${i === cursor && keyed ? " is-key" : ""}`}
            onMouseEnter={() => {
              setCursor(i);
              setKeyed(false);
            }}
            onMouseLeave={() => setCursor(-1)}
            onClick={() => pick(item.id)}
          >
            {choice && <span className="grid-menu-check">{item.checked ? "✓" : ""}</span>}
            <span data-testid="grid-menu-label" className="grid-menu-label">
              {item.label}
              {item.gloss && <span className="grid-menu-gloss"> {item.gloss}</span>}
            </span>
            {keys ? <kbd><Keys text={keys} /></kbd> : item.hint && <span data-testid="grid-menu-hint" className="grid-menu-hint">{item.hint}</span>}
          </button>,
        ];
      })}
      {footer && <div data-testid="grid-menu-footer" className="grid-menu-footer">{footer}</div>}
    </div>
  );
}
