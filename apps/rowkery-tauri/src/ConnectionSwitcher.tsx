import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EngineTile } from "./engines";
import { EnvTag } from "./EnvTag";
import { pickerGroup, pinnedFirst, useConnectionPins } from "./connectionPins";
import { ChevronDownIcon, PencilIcon, PinIcon, PlusIcon, SearchIcon } from "./icons";
import { useCursorIntoView, usePointerCursor } from "./listCursor";
import { Presence, useGlideHover } from "./motion";
import { Floating } from "./Floating";
import { isMacPlatform } from "./platform";
import { commandTip } from "./commands";
import type { ConnectionRecord } from "./types";
import { connectionSubtitle } from "./types";
import { connectionLine, usePresenting } from "./presenting";
import { keysFor } from "./commands";
import { Keys } from "./Keys";

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

function dotClass(active: boolean, state: ConnectionState) {
  if (!active) return "conn-dot";
  return `conn-dot ${state}`;
}

function stateLabel(state: ConnectionState) {
  return state === "connected"
    ? "Connected"
    : state === "connecting"
      ? "Connecting…"
      : state === "error"
        ? "Failed"
        : "";
}

interface ConnectionPickerProps {
  connections: ConnectionRecord[];
  /** The current window's connection, marked with its state. */
  activeId: string | null;
  state: ConnectionState;
  /** Connections open in some window get a green dot. */
  openIds?: Set<string>;
  placeholder: string;
  className?: string;
  onPick: (id: string) => void;
  onNewConnection: () => void;
  /** Opens the edit sheet (pencil on hover, ⌘E on the highlighted row). */
  onEdit: (id: string) => void;
  onClose: () => void;
}

/** Filterable connection list shared by the chip and the new-window button. */
export function ConnectionPicker({
  connections,
  activeId,
  state,
  openIds,
  placeholder,
  className,
  onPick,
  onNewConnection,
  onEdit,
  onClose,
}: ConnectionPickerProps) {
  const [query, setQuery] = useState("");
  const presenting = usePresenting();
  const { pins, toggle: togglePin } = useConnectionPins();
  const ordered = useMemo(() => pinnedFirst(connections, pins), [connections, pins]);
  const [cursor, setCursor] = useState(() =>
    Math.max(0, ordered.findIndex((c) => c.id === activeId)),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = ordered.map((c) => ({ c }));
    if (!q) return all;
    return all.filter(
      ({ c }) =>
        c.name.toLowerCase().includes(q) ||
        c.environment === q ||
        connectionSubtitle(c).toLowerCase().includes(q),
    );
  }, [ordered, query]);

  // Focused as it opens, like ⌘K: a key typed right after ⇧⌘O (↵, or a
  // name's first letter) lands in the list, not the page.
  useLayoutEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  const listRef = useRef<HTMLUListElement>(null);
  useGlideHover(listRef, ".conn-option");
  const listId = useId();
  useCursorIntoView(listRef, cursor, matches.length);
  const hover = usePointerCursor(setCursor);
  const mac = isMacPlatform();

  return (
    <div
      data-testid="conn-popover"
      className={`conn-popover${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-label={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const m = matches[cursor];
          if (m) onPick(m.c.id);
        } else if (
          e.key.toLowerCase() === "e" &&
          (mac ? e.metaKey : e.ctrlKey) &&
          !e.shiftKey &&
          !e.altKey
        ) {
          e.preventDefault();
          const m = matches[cursor];
          if (m) onEdit(m.c.id);
        }
      }}
    >
      <label className="conn-search">
        <SearchIcon size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          aria-label="Filter connections"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={matches[cursor] ? `${listId}-${cursor}` : undefined}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul data-testid="conn-list" className="conn-list" role="listbox" id={listId} aria-label="Connections" ref={listRef}>
        {matches.length === 0 && (
          <li className="conn-empty">
            {connections.length === 0 ? "No saved connections" : "No matches"}
          </li>
        )}
        {matches.map(({ c }, i) => {
          const isActive = c.id === activeId;
          const isOpen = openIds?.has(c.id) ?? false;
          const isPinned = pins.includes(c.id);
          // Pinned rows come first under a "Pinned" heading, then the sample
          // under "Sample", then a divider before the rest.
          const group = pickerGroup(c, pins);
          const prev = i > 0 ? pickerGroup(matches[i - 1].c, pins) : null;
          const heading = group !== prev && group !== "rest" ? (group === "pinned" ? "Pinned" : "Sample") : null;
          const divider = group === "rest" && prev !== null && prev !== "rest";
          return (
            <Fragment key={c.id}>
              {heading && (
                <li data-testid="conn-section" className="conn-section" role="presentation" data-section={group}>
                  {heading}
                </li>
              )}
              {divider && <li data-testid="conn-divider" className="conn-divider" role="separator" />}
              <li
                className="conn-row"
                id={`${listId}-${i}`}
                role="option"
                data-conn-id={c.id}
                title={group === "sample" ? `A bundled SQLite file, copied to this ${isMacPlatform() ? "Mac" : "computer"}. Delete it when you are done.` : undefined}
                aria-selected={i === cursor}
                onMouseMove={hover(i)}
              >
                <button
                  type="button"
                  className={`conn-option${i === cursor ? " cursor" : ""}`}
                  onClick={() => onPick(c.id)}
                >
                  <EngineTile kind={c.kind}>
                    <span
                      className={
                        isActive
                          ? dotClass(true, state)
                          : dotClass(isOpen, "connected")
                      }
                    />
                  </EngineTile>
                  <span className="conn-option-text">
                    <span className="conn-option-title">
                      <span data-testid="conn-option-name" className="conn-option-name">{c.name}</span>
                      <EnvTag env={c.environment} />
                    </span>
                    <span className="conn-option-sub">{connectionLine(c, presenting)}</span>
                  </span>
                  {isActive && (
                    <span className="conn-option-state">{stateLabel(state)}</span>
                  )}
                </button>
                <button
                  type="button"
                  data-testid="conn-pin"
                  className={`conn-row-btn conn-pin${isPinned ? " on" : ""}`}
                  aria-label={isPinned ? `Unpin ${c.name}` : `Pin ${c.name}`}
                  aria-pressed={isPinned}
                  title={isPinned ? "Unpin" : "Pin to top"}
                  tabIndex={-1}
                  onClick={() => {
                    // The row jumps to its new place; keep the cursor on it.
                    const next = togglePin(c.id);
                    const shown = new Set(matches.map((m) => m.c.id));
                    const moved = pinnedFirst(connections, next).filter((m) =>
                      shown.has(m.id),
                    );
                    setCursor(moved.findIndex((m) => m.id === c.id));
                  }}
                >
                  <PinIcon size={12} filled={isPinned} />
                </button>
                <button
                  type="button"
                  data-testid="conn-edit"
                  className="conn-row-btn conn-edit"
                  aria-label={`Edit ${c.name}`}
                  title={`Edit this connection  ${mac ? "⌘E" : "Ctrl+E"}`}
                  tabIndex={-1}
                  onClick={() => onEdit(c.id)}
                >
                  <PencilIcon size={12} />
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <button type="button" className="conn-new" onClick={onNewConnection}>
        <PlusIcon size={12} />
        <span className="conn-new-label">New connection…</span>
        <kbd className="conn-option-key"><Keys text={keysFor("new-connection", mac)} /></kbd>
      </button>
    </div>
  );
}

/** Closes `onClose` on a mousedown outside `ref` while `open`. */
export function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  /** A portalled popover (Floating): clicks in it are inside too. */
  layer?: React.RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !layer?.current?.contains(t)) onCloseRef.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, ref, layer]);
}

interface ConnectionSwitcherProps {
  connections: ConnectionRecord[];
  activeId: string | null;
  state: ConnectionState;
  openIds: Set<string>;
  open: boolean;
  /** The chevron ends the tab, so it goes on the last part shown. */
  chevron?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onNewConnection: () => void;
  onEdit: (id: string) => void;
}

/**
 * The connection name on the active window tab, and its picker. The tab's
 * leading dot carries the environment and connection state.
 */
export function ConnectionSwitcher({
  connections,
  activeId,
  state,
  openIds,
  open,
  chevron = true,
  onOpenChange,
  onSelect,
  onNewConnection,
  onEdit,
}: ConnectionSwitcherProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const active = connections.find((c) => c.id === activeId) ?? null;
  const layerRef = useRef<HTMLDivElement>(null);
  useOutsideClose(rootRef, open, () => onOpenChange(false), layerRef);

  return (
    <div data-testid="conn-switcher" className="conn-switcher" ref={rootRef}>
      <button
        type="button"
        data-testid="conn-chip"
        data-hint-cmd="switch-connection"
        className={`conn-chip${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={commandTip("switch-connection", "Switch connection")}
        onClick={() => onOpenChange(!open)}
      >
        {/* A window with no connection shows no chip (Paper, 2026-10-10:
            Connect to start is the whole screen); ⇧⌘O still opens its picker. */}
        <span data-testid="conn-chip-name" className={`conn-chip-name${active ? "" : " dim"}`} data-connect-to-start={active ? undefined : ""}>
          {active ? active.name : "Connect to start"}
        </span>
        {chevron && <ChevronDownIcon size={10} className="conn-chip-chevron" />}
      </button>

      <Floating anchor={rootRef} layerRef={layerRef}>
      <Presence open={open}>
        <ConnectionPicker
          connections={connections}
          activeId={activeId}
          state={state}
          openIds={openIds}
          placeholder="Switch connection…"
          onPick={(id) => {
            onOpenChange(false);
            if (id !== activeId || state !== "connected") onSelect(id);
          }}
          onNewConnection={onNewConnection}
          onEdit={onEdit}
          onClose={() => onOpenChange(false)}
        />
      </Presence>
      </Floating>
    </div>
  );
}
