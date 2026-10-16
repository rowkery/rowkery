import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CommandIcon,
  DatabaseIcon,
  PlusIcon,
  HistoryIcon,
  SearchIcon,
  TableIcon,
} from "./icons";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  GROUP_PREFIX,
  parseScope,
  pastedItem,
  searchPalette,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem,
} from "./paletteIndex";
import { Presence, useGlideHover } from "./motion";
import { isMacPlatform } from "./platform";
import { Keys } from "./Keys";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  groups: Record<PaletteGroup, PaletteItem[]>;
  /** Groups listed before anything is typed. */
  emptyGroups: PaletteGroup[];
  connectionName: string | null;
  onPick: (item: PaletteItem, mode: PickMode) => void;
}

/** ↵ opens, ⌥↵ inserts into the editor, ⌘↵ opens a table's Structure. */
export type PickMode = "open" | "insert" | "structure";

const ICONS: Record<PaletteGroup, (p: { size?: number }) => ReactNode> = {
  tables: TableIcon,
  queries: HistoryIcon,
  connections: DatabaseIcon,
  commands: CommandIcon,
};

/** What ↵ does, per group, for the row and footer hints. */
const ENTER_VERB: Record<PaletteGroup, string> = {
  tables: "Browse",
  queries: "Open",
  connections: "Switch",
  commands: "Run",
};

const INSERTABLE = new Set<PaletteGroup>(["tables", "queries"]);
const HAS_STRUCTURE = new Set<PaletteGroup>(["tables"]);

function Highlighted({ text, marks }: { text: string; marks: number[] }) {
  if (marks.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let i = 0;
  let m = 0;
  while (i < text.length) {
    const hit = m < marks.length && marks[m] === i;
    let j = i;
    if (hit) {
      while (m < marks.length && marks[m] === j) {
        m++;
        j++;
      }
      out.push(<mark key={i}>{text.slice(i, j)}</mark>);
    } else {
      const next = m < marks.length ? marks[m] : text.length;
      out.push(text.slice(i, next));
      j = next;
    }
    i = j;
  }
  return <>{out}</>;
}

/** Mounted only while open, so every ⌘K starts from an empty query. */
export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Presence open={props.open}>
      <PaletteBody {...props} />
    </Presence>
  );
}

function PaletteBody({
  onClose,
  groups,
  emptyGroups,
  connectionName,
  onPick,
}: CommandPaletteProps) {
  const [raw, setRaw] = useState("");
  const [tabScope, setTabScope] = useState<PaletteGroup | null>(null);
  const [cursor, setCursor] = useState(0);
  // Focus stays in the search field; VoiceOver reads the cursor's row through it.
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useGlideHover(listRef, ".cp-row");
  const mac = isMacPlatform();
  const alt = mac ? "⌥" : "Alt+";
  const modKey = mac ? "⌘" : "Ctrl+";

  useLayoutEffect(() => inputRef.current?.focus(), []);

  const { scope: typedScope, query } = parseScope(raw);
  const scope = typedScope ?? tabScope;

  const sections = useMemo(
    () => searchPalette(groups, query, scope, emptyGroups),
    [groups, query, scope, emptyGroups],
  );

  // A pasted connection string or SQLite path leads, above every group.
  const lead = useMemo((): PaletteHit | null => {
    const it = pastedItem(raw);
    return it && { item: it, score: Infinity, marks: [] };
  }, [raw]);

  const flat = useMemo(() => {
    const rows: PaletteHit[] = lead ? [lead] : [];
    for (const s of sections) rows.push(...s.hits);
    return rows;
  }, [sections, lead]);

  useEffect(() => setCursor(0), [query, scope]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${cursor}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, sections]);

  const current = flat[Math.min(cursor, flat.length - 1)];

  const cycleScope = (dir: 1 | -1) => {
    // All → Tables → Recent queries → … → Commands → All.
    const order: (PaletteGroup | null)[] = [null, ...GROUP_ORDER];
    const at = order.indexOf(scope);
    const next = order[(at + dir + order.length) % order.length];
    if (typedScope) setRaw(query);
    setTabScope(next);
  };

  const pick = (
    hit: PaletteHit | undefined,
    e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => {
    if (!hit) return;
    const group = hit.item.group;
    const mod = mac ? e.metaKey : e.ctrlKey;
    const mode: PickMode =
      e.altKey && INSERTABLE.has(group)
        ? "insert"
        : mod && HAS_STRUCTURE.has(group)
          ? "structure"
          : "open";
    onClose();
    onPick(hit.item, mode);
  };

  let row = lead ? 1 : 0;

  return (
    <div
      data-testid="cp-scrim"
      className="cp-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="cp-panel"
        className="cp-panel"
        role="dialog"
        aria-label="Command palette"
        onKeyDown={(e) => {
          const ctrlOnly = e.ctrlKey && !e.metaKey;
          if (e.key === "Escape") {
            e.preventDefault();
            if (raw) setRaw("");
            else if (tabScope) setTabScope(null);
            else onClose();
          } else if (e.key === "ArrowDown" || (ctrlOnly && e.key === "n")) {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, flat.length - 1));
          } else if (e.key === "ArrowUp" || (ctrlOnly && e.key === "p")) {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "PageDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 8, flat.length - 1));
          } else if (e.key === "PageUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 8, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(current, e);
          } else if (e.key === "Tab") {
            e.preventDefault();
            cycleScope(e.shiftKey ? -1 : 1);
          } else if (e.key === "Backspace" && raw === "" && tabScope) {
            e.preventDefault();
            setTabScope(null);
          }
          // A key ⌘K consumed (Ctrl+N moves the cursor) goes no further: the
          // window's own handlers never see it (Ctrl+N is New connection there).
          if (e.defaultPrevented) e.stopPropagation();
        }}
      >
        <label data-testid="cp-search" className="cp-search">
          <SearchIcon size={16} />
          {tabScope && !typedScope && (
            <span data-testid="cp-scope" className="cp-scope">{GROUP_LABEL[tabScope]}</span>
          )}
          <input
            ref={inputRef}
            value={raw}
            placeholder={
              connectionName
                ? "Jump to a table, query or command…"
                : "Search commands and connections…"
            }
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? `${listId}-${cursor}` : undefined}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setRaw(e.target.value)}
          />
          <kbd className="cp-kbd">esc</kbd>
        </label>
        <div className="cp-list" ref={listRef} role="listbox" id={listId} aria-label="Results">
          {lead && (
            <button
              type="button"
              role="option"
              id={`${listId}-0`}
              aria-selected={cursor === 0}
              data-row={0}
              data-item={lead.item.id}
              data-pasted={lead.item.target.kind}
              data-testid="cp-row"
              className={`cp-row cp-lead${cursor === 0 ? " active" : ""}`}
              onMouseMove={() => {
                if (cursor !== 0) setCursor(0);
              }}
              onClick={(e) => pick(lead, e)}
            >
              <span className="cp-icon cp-icon-connections">
                <PlusIcon size={14} />
              </span>
              <span data-testid="cp-label" className="cp-label">
                {lead.item.label}
                <span className="cp-detail">{lead.item.detail}</span>
              </span>
              <kbd className="cp-kbd">↵</kbd>
            </button>
          )}
          {sections.length === 0 && !lead && (
            <div className="cp-empty">
              {query || scope ? "No matches" : "Type to search"}
            </div>
          )}
          {sections.map((s) => {
            const Icon = ICONS[s.group];
            return (
              <Fragment key={s.group}>
                <div data-testid="cp-group" className="cp-group" data-group={s.group}>
                  {GROUP_LABEL[s.group]}
                  {GROUP_PREFIX[s.group] && (
                    <span
                      className="cp-prefix"
                      data-prefix={GROUP_PREFIX[s.group]}
                      title={`Type ${GROUP_PREFIX[s.group]} to search only ${GROUP_LABEL[s.group].toLowerCase()}`}
                    >
                      {GROUP_PREFIX[s.group]}
                    </span>
                  )}
                </div>
                {s.hits.map((hit) => {
                  const i = row++;
                  const active = i === cursor;
                  const it = hit.item;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      role="option"
                      id={`${listId}-${i}`}
                      aria-selected={active}
                      data-row={i}
                      data-item={it.id}
                      data-testid="cp-row"
                      className={`cp-row${active ? " active" : ""}`}
                      onMouseMove={() => {
                        if (cursor !== i) setCursor(i);
                      }}
                      onClick={(e) => pick(hit, e)}
                    >
                      <span className={`cp-icon cp-icon-${s.group}`}>
                        <Icon size={14} />
                      </span>
                      <span data-testid="cp-label" className="cp-label">
                        <Highlighted text={it.label} marks={hit.marks} />
                        {it.detail && (
                          <span className="cp-detail">{it.detail}</span>
                        )}
                      </span>
                      {it.meta && <span className="cp-meta">{it.meta}</span>}
                      {active && INSERTABLE.has(s.group) ? (
                        <span className="cp-actions">
                          <span className="cp-kbd">
                            ↵ {ENTER_VERB[s.group]}
                          </span>
                          {HAS_STRUCTURE.has(s.group) && (
                            <span className="cp-kbd">{modKey}↵ Structure</span>
                          )}
                          <span className="cp-kbd">{alt}↵ Insert</span>
                        </span>
                      ) : (
                        it.keys && (
                          <kbd className="cp-kbd" data-keys>
                            <Keys text={it.keys} />
                          </kbd>
                        )
                      )}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
        <div className="cp-footer">
          <span>↑↓ Navigate</span>
          <span>↵ {current && current !== lead ? ENTER_VERB[current.item.group] : "Open"}</span>
          {current && HAS_STRUCTURE.has(current.item.group) && (
            <span>{modKey}↵ Structure</span>
          )}
          {current && INSERTABLE.has(current.item.group) && (
            <span>{alt}↵ Insert</span>
          )}
          <span>⇥ Filter by type</span>
          <span className="cp-footer-spacer" />
          {connectionName && (
            <span className="cp-footer-conn">{connectionName}</span>
          )}
        </div>
      </div>
    </div>
  );
}
