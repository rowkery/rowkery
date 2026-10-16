import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dismissTip, noteTrigger, retireTip, useTip } from "./Tips";
import { listDatabases, type DatabaseInfo } from "./api";
import { useOutsideClose } from "./ConnectionSwitcher";
import { Floating } from "./Floating";
import { ChevronDownIcon, SearchIcon } from "./icons";
import { Presence, RollText, useGlideHover } from "./motion";
import { isMacPlatform } from "./platform";
import { commandTip } from "./commands";
import { useCursorIntoView, usePointerCursor } from "./listCursor";
import { filterByName } from "./nameFilter";
import { formatBytes } from "./types";

interface DatabaseSwitcherProps {
  windowId: string;
  database: string | null;
  /** The connection is named after this database: the chip shows only its ▾ (the name is beside it). */
  nameless?: boolean;
  /** The list is read from the server, so the chip waits for a connection. */
  connected: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `newWindow`: ⌘↵ opens the database in a new window instead. */
  onPick: (database: string, newWindow: boolean) => void;
}

/**
 * The database chip beside the connection chip. The list is fetched each time
 * it opens (one short session), so nothing is polled while it is closed.
 */
export function DatabaseSwitcher({
  windowId,
  database,
  nameless = false,
  connected,
  open,
  onOpenChange,
  onPick,
}: DatabaseSwitcherProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useOutsideClose(rootRef, open, () => onOpenChange(false), layerRef);
  const mac = isMacPlatform();
  // Each open counts toward the ⌘↵ tip (the third shows it); closing takes it away.
  useEffect(() => {
    if (open) noteTrigger("db-new-window");
    else dismissTip("db-new-window");
  }, [open]);

  return (
    <div data-testid="conn-switcher" className="conn-switcher db-switcher" ref={rootRef}>
      <button
        type="button"
        data-testid="db-chip"
        data-hint-cmd="switch-database"
        className={`conn-chip db-chip${open ? " open" : ""}${nameless ? " nameless" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={nameless && database ? `Database ${database}` : undefined}
        disabled={!connected && !database}
        title={commandTip("switch-database", nameless && database ? `${database} · Switch database` : "Switch database", mac)}
        onClick={() => onOpenChange(!open)}
      >
        {/* Rolls on a database change; the first name just appears. */}
        {nameless ? null : database ? (
          <RollText data-testid="conn-chip-name" className="conn-chip-name" text={database} />
        ) : (
          <span data-testid="conn-chip-name" className="conn-chip-name">Database</span>
        )}
        <ChevronDownIcon size={10} className="conn-chip-chevron" />
      </button>
      <Floating anchor={rootRef} layerRef={layerRef}>
      <Presence open={open}>
        <DatabaseList
          windowId={windowId}
          current={database}
          onClose={() => onOpenChange(false)}
          onPick={(name, newWindow) => {
            onOpenChange(false);
            // ⌘↵ / ⌘-click used: the tip that teaches it is done.
            if (newWindow) retireTip("db-new-window");
            if (newWindow || name !== database) onPick(name, newWindow);
          }}
        />
      </Presence>
      </Floating>
    </div>
  );
}

function DatabaseList({
  windowId,
  current,
  onClose,
  onPick,
}: {
  windowId: string;
  current: string | null;
  onClose: () => void;
  onPick: (name: string, newWindow: boolean) => void;
}) {
  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mac = isMacPlatform();

  // The ⌘↵ tip, once earned, stands in for this footer.
  const tip = useTip("db-picker");

  // Focused as it opens, like ⌘K: a key typed right after ⇧⌘D lands in the list.
  useLayoutEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    let live = true;
    listDatabases(windowId)
      .then((list) => {
        if (!live) return;
        setDbs(list);
        setCursor(Math.max(0, list.findIndex((d) => d.name === current)));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [windowId]);

  const matches = useMemo(() => filterByName(dbs ?? [], query, (d) => d.name), [dbs, query]);

  // Typing puts the cursor on the best match, so ↵ takes what was typed; an
  // empty filter puts it back on the current database.
  useEffect(() => {
    if (!dbs) return;
    setCursor(query.trim() ? 0 : Math.max(0, dbs.findIndex((d) => d.name === current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, dbs]);

  const listRef = useRef<HTMLUListElement>(null);
  useGlideHover(listRef, ".db-option");
  const listId = useId();
  useCursorIntoView(listRef, cursor, matches.length);
  const hover = usePointerCursor(setCursor);

  return (
    <div
      data-testid="db-popover"
      className="conn-popover db-popover"
      role="dialog"
      aria-label="Switch database"
      onKeyDown={(e) => {
        const mod = mac ? e.metaKey : e.ctrlKey;
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
          if (m) onPick(m.name, mod);
        }
      }}
    >
      <label className="conn-search">
        <SearchIcon size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Switch database…"
          aria-label="Filter databases"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={matches[cursor] ? `${listId}-${cursor}` : undefined}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ul data-testid="conn-list" className="conn-list" role="listbox" id={listId} aria-label="Databases" ref={listRef}>
        {error ? (
          <li className="conn-empty error">{error}</li>
        ) : dbs === null ? (
          <li className="conn-empty">Loading databases…</li>
        ) : matches.length === 0 ? (
          <li className="conn-empty">No matches</li>
        ) : (
          matches.map((d, i) => (
            <li key={d.name} id={`${listId}-${i}`} role="option" aria-selected={i === cursor} aria-current={d.name === current || undefined}>
              <button
                type="button"
                data-testid="db-option"
                className={`conn-option db-option${i === cursor ? " cursor" : ""}`}
                onMouseMove={hover(i)}
                onClick={(e) => onPick(d.name, mac ? e.metaKey : e.ctrlKey)}
              >
                <span className="db-check">{d.name === current ? "✓" : ""}</span>
                <span className="db-option-name">{d.name}</span>
                <span className="db-option-size">{formatBytes(d.size_bytes)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {tip ? (
        <div className="db-foot tip-line db-tip" data-tip={tip.id} role="status">
          {tip.text}
        </div>
      ) : (
        <div className="db-foot">
          <span>↵ Switch this window</span>
          <span>{mac ? "⌘↵" : "Ctrl+↵"} Open in new window</span>
        </div>
      )}
    </div>
  );
}
