import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  COMMANDS,
  GESTURES,
  SHEET_SECTIONS,
  chordFor,
  formatChord,
  gestureKeys,
  keysFor,
  sheetSection,
  type CommandState,
  type SheetSection,
} from "./commands";
import { KEYMAPS, KEYMAP_CHORDS, setKeymap, useKeymap } from "./keymaps";
import { isMacPlatform } from "./platform";
import { useUsedKeys } from "./usedKeys";
import "./ShortcutsSheet.css";
import { Keys } from "./Keys";

interface Row {
  id: string;
  title: string;
  keys: string;
  hay: string;
  /** A command: it has a used dot and counts in "Used n of m". */
  command: boolean;
  /** The keymap moved this chord. */
  remapped: boolean;
}

/**
 * Keyboard shortcuts (⇧⌘/; ? in the grid or panel; Help > Keyboard
 * Shortcuts; ⌘K): every command with a key, read from the one registry in
 * commands.ts under the active keymap, so it can't drift from ⌘K, the menu
 * bar or the tooltips, plus the gestures that aren't commands. Sections
 * follow the menu bar, then the zones. A shortcut you have pressed reads
 * bright with a filled dot; "Used n of m" counts them (usedKeys.ts). The
 * keymap picker swaps only the chords that collide with TablePlus or DataGrip
 * habits. Type to filter; Esc clears, then closes.
 */
export function ShortcutsSheet({ onClose, onNotices }: { onClose: () => void; onNotices: () => void }) {
  const mac = isMacPlatform();
  const keymap = useKeymap();
  const used = useUsedKeys();
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [spy, setSpy] = useState<SheetSection | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const by = new Map<SheetSection, Row[]>(SHEET_SECTIONS.map((s) => [s, []]));
    for (const c of COMMANDS) {
      const chord = chordFor(c, keymap);
      // A key the grid or panel handles itself reads as its gesture row.
      if (!chord || c.planned || GESTURES.some((g) => g.id === c.id)) continue;
      // Titles that read the state (Show / Hide sidebar) show their default.
      const title = typeof c.title === "function" ? c.title({ sidebarHidden: false } as CommandState) : c.title;
      const keys = formatChord(chord, mac);
      by.get(sheetSection(c))!.push({
        id: c.id,
        title,
        keys,
        hay: [title, keys, ...(c.synonyms ?? [])].join(" ").toLowerCase(),
        command: true,
        remapped: !!KEYMAP_CHORDS[keymap][c.id],
      });
    }
    for (const g of GESTURES) {
      const keys = gestureKeys(g, mac);
      by.get(g.section)!.push({
        id: g.id,
        title: g.title,
        keys,
        hay: `${g.title} ${keys}`.toLowerCase(),
        command: false,
        remapped: false,
      });
    }
    return SHEET_SECTIONS.map((name) => ({ name, rows: by.get(name)! })).filter((s) => s.rows.length > 0);
  }, [keymap, mac]);

  const commandRows = sections.flatMap((s) => s.rows.filter((r) => r.command));
  const usedCount = commandRows.filter((r) => (used[r.id] ?? 0) > 0).length;

  const q = query.trim().toLowerCase();
  const shown = q
    ? sections.map((s) => ({ ...s, rows: s.rows.filter((r) => r.hay.includes(q)) })).filter((s) => s.rows.length > 0)
    : sections;

  // A section jumped to near the end can't reach the top; it stays lit
  // while it is in view.
  const jumped = useRef<SheetSection | null>(null);
  const jump = (name: SheetSection) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-section="${name}"]`);
    if (el && listRef.current) listRef.current.scrollTop = el.offsetTop;
    jumped.current = name;
    setSpy(name);
  };
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const target = jumped.current && list.querySelector<HTMLElement>(`[data-section="${jumped.current}"]`);
    if (target && target.offsetTop >= list.scrollTop - 4 && target.offsetTop < list.scrollTop + list.clientHeight) return;
    jumped.current = null;
    let current: SheetSection | null = null;
    for (const el of list.querySelectorAll<HTMLElement>("[data-section]")) {
      if (el.offsetTop <= list.scrollTop + 4) current = el.dataset.section as SheetSection;
    }
    setSpy(current);
  };
  const activeAnchor = spy ?? shown[0]?.name ?? null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (pickerOpen) setPickerOpen(false);
    else if (query) setQuery("");
    else onClose();
  };
  const filterRef = useRef<HTMLInputElement>(null);

  const keymapLabel = KEYMAPS.find((k) => k.id === keymap)?.label ?? "Rowkery";
  const openKey = keysFor("keyboard-shortcuts", mac);

  return (
    <div
      className="ks-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ks-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-shortcuts
        data-keymap={keymap}
        onKeyDown={onKeyDown}
      >
        <div className="ks-head sheet-head">
          <h2 className="ks-title sheet-title">Keyboard shortcuts</h2>
          <input
            ref={filterRef}
            autoFocus
            data-testid="ks-filter"
            className="ks-filter"
            value={query}
            placeholder="Search"
            spellCheck={false}
            aria-label="Search shortcuts"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="ks-keymap">
            <button
              type="button"
              className="ks-keymap-btn"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              data-keymap-picker
              title="Swaps only the chords that collide with that app's habits"
              onClick={() => setPickerOpen((o) => !o)}
            >
              Keymap: {keymapLabel} <span className="ks-caret">▾</span>
            </button>
            {pickerOpen && (
              <div className="ks-keymap-menu" role="menu" aria-label="Keymap">
                {KEYMAPS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={k.id === keymap}
                    className="ks-keymap-item"
                    data-keymap-option={k.id}
                    onClick={() => {
                      setKeymap(k.id);
                      setPickerOpen(false);
                      // Keep the keyboard in the sheet (typing, Esc).
                      filterRef.current?.focus();
                    }}
                  >
                    <span className="ks-check">{k.id === keymap ? "✓" : ""}</span>
                    {k.label}
                    <span className="ks-keymap-n">
                      {k.id === "rowkery" ? "" : `${Object.keys(KEYMAP_CHORDS[k.id]).length} keys differ`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="sheet-esc" title="Close  esc" onClick={onClose}>
            esc
          </button>
        </div>
        <p className="ks-used" data-used-count={usedCount} data-used-total={commandRows.length}>
          Used {usedCount} of {commandRows.length}
        </p>
        <nav className="ks-anchors" aria-label="Sections">
          {shown.map((s) => (
            <button
              key={s.name}
              type="button"
              className="ks-anchor"
              data-anchor={s.name}
              data-on={s.name === activeAnchor ? "" : undefined}
              onClick={() => jump(s.name)}
            >
              {s.name}
            </button>
          ))}
        </nav>
        <div data-testid="ks-list" className="ks-list" ref={listRef} onScroll={onScroll}>
          {shown.map((s) => (
            <section key={s.name} className="ks-section" data-section={s.name}>
              <h3 className="ks-section-title sheet-label">{s.name}</h3>
              <ul className="ks-rows">
                {s.rows.map((r) => {
                  const isUsed = r.command && (used[r.id] ?? 0) > 0;
                  return (
                    <li
                      key={r.id}
                      className="ks-row"
                      data-shortcut={r.id}
                      data-keys={r.keys}
                      data-used={isUsed ? "" : undefined}
                      data-static={r.command ? undefined : ""}
                      data-remapped={r.remapped ? "" : undefined}
                    >
                      <kbd data-testid="ks-keys" className="ks-keys"><Keys text={r.keys} /></kbd>
                      <span data-testid="ks-label" className="ks-label">{r.title}</span>
                      {r.command && <span data-testid="ks-dot" className="ks-dot" aria-label={isUsed ? "Used" : "Not used yet"} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {shown.length === 0 && <p className="ks-empty">No shortcut matches</p>}
        </div>
        <p className="ks-foot">
          esc close · {openKey} opens this anywhere · ? in the grid and panel · every command is in{" "}
          {keysFor("command-palette", mac)}
          <button type="button" className="ks-notices" data-testid="ks-notices" onClick={onNotices}>
            Third-party notices
          </button>
        </p>
      </div>
    </div>
  );
}
