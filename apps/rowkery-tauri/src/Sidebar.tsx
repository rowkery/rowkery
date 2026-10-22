import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  AgentIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  SettingsIcon,
  PartitionedIcon,
  PinIcon,
  RefreshIcon,
  SearchIcon,
  TableIcon,
  ViewIcon,
} from "./icons";
import { isMacPlatform } from "./platform";
import { useGlideHover } from "./motion";
import { commandTip } from "./commands";
import {
  filterSchemaTree,
  findTable,
  isView,
  type SidebarSchema,
  type SidebarTable,
} from "./schemaTree";
import { formatRowCount } from "./types";
import { firstLine } from "./comments";
import { readKey, writeKey } from "./persist";
import { GridMenu, useContextMenu } from "./GridMenu";
import { panelRowMenu } from "./contextMenus";
import { showToast } from "./notify";
import { setPresenting, usePresenting } from "./presenting";
import { updateWaiting, useUpdatePref, useUpdateState, type UpdateState } from "./updates";
import type { SettingsSection } from "./SettingsPage";

interface SidebarProps {
  connectionId: string | null;
  schemas: SidebarSchema[];
  connecting: boolean;
  /** The connection failed: Couldn't connect shows in the main column
      (EmptyWindow.tsx's ConnectFailed); the list says so in one line. */
  failed?: boolean;
  selectedKey: string | null;
  /** `keep`: ⌘-click or double-click, so the table gets a tab of its own. */
  onOpenTable: (table: SidebarTable, keep?: boolean) => void;
  /** A row's menu: its Structure (⌥⌘2), and its name at the editor's caret (⌥↵ on the row too). */
  onTableStructure?: (table: SidebarTable) => void;
  onInsertName?: (table: SidebarTable) => void;
  /** A table's menu: Import CSV… into it. */
  onImportCsv?: (table: SidebarTable) => void;
  /** The pointer rests on a row's name (null: it left), for hover prefetch. */
  onHoverTable?: (table: SidebarTable | null) => void;
  /** Reloads the schema (the refresh button at the end of the top row, ⌘R). */
  onRefresh?: () => void;
  /** A reload asked for by hand is running: the button spins. */
  refreshing?: boolean;
  /** The top row: the connection and database switchers. */
  head?: ReactNode;
  /** The head's mono line: where the connection points (host:port/db, a SQLite file). */
  sub?: ReactNode;
  /** After it: the connection's state and how long it took to connect. */
  status?: ReactNode;
  /** The panel's `…` (ZoneMenu), after the refresh button. */
  menu?: ReactNode;
  /** On the mono line after the latency: the environment tag. */
  envTag?: ReactNode;
  /** Under the hint, past a rule: Agents, Appearance, Help (`SidebarFoot`). */
  foot?: ReactNode;
  /** The panel's key strip, under the filter box. */
  keyStrip?: ReactNode;
}

function loadPins(connectionId: string | null): string[] {
  if (!connectionId) return [];
  const parsed = readKey(`rowkery.pins.${connectionId}`);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

function savePins(connectionId: string | null, pins: string[]) {
  if (!connectionId) return;
  writeKey(`rowkery.pins.${connectionId}`, pins);
}

export const Sidebar = forwardRef<HTMLInputElement, SidebarProps>(
  function Sidebar(
    {
      connectionId,
      schemas,
      connecting,
      failed = false,
      selectedKey,
      onOpenTable,
      onTableStructure,
      onInsertName,
      onImportCsv,
      onHoverTable,
      onRefresh,
      refreshing = false,
      menu,
      head,
      sub,
      status,
      envTag,
      foot,
      keyStrip,
    },
    filterRef,
  ) {
    const [filter, setFilter] = useState("");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [pins, setPins] = useState<string[]>(() => loadPins(connectionId));
    // One highlight glides between the rows under the pointer (motion.tsx).
    const scrollRef = useRef<HTMLDivElement>(null);
    useGlideHover(scrollRef, ".sb-row");

    useEffect(() => {
      setPins(loadPins(connectionId));
      setFilter("");
      setExpanded(new Set());
    }, [connectionId]);

    const visible = useMemo(
      () => filterSchemaTree(schemas, filter),
      [schemas, filter],
    );
    const filtering = filter.trim().length > 0;

    const pinned = useMemo(
      () =>
        pins
          .map((key) => findTable(visible, key))
          .filter((t): t is SidebarTable => t !== undefined),
      [pins, visible],
    );

    const togglePin = (key: string) => {
      const next = pins.includes(key)
        ? pins.filter((k) => k !== key)
        : [...pins, key];
      setPins(next);
      savePins(connectionId, next);
    };

    const toggleSet = (
      setter: Dispatch<SetStateAction<Set<string>>>,
      key: string,
    ) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });

    const single = schemas.length === 1 ? schemas[0] : null;
    // Rows call the latest handler; the list itself only re-renders when the
    // tree, filter, pins, folding or selection change, not on every render of
    // the window (⌘K opening, a query's clock), which a 2,000-table schema
    // would otherwise pay for each time.
    const openRef = useRef(onOpenTable);
    openRef.current = onOpenTable;
    const insertRef = useRef(onInsertName);
    insertRef.current = onInsertName;
    const hoverRef = useRef(onHoverTable);
    hoverRef.current = onHoverTable;

    // Right-click a row: open it, its Structure, its name, pin it.
    const rowMenu = useContextMenu<SidebarTable>();
    const pickRow = (id: string) => {
      const t = rowMenu.target;
      if (!t) return;
      if (id === "open") onOpenTable(t);
      else if (id === "open-tab") onOpenTable(t, true);
      else if (id === "structure") onTableStructure?.(t);
      else if (id === "insert") onInsertName?.(t);
      else if (id === "import-csv") onImportCsv?.(t);
      else if (id === "pin") togglePin(t.key);
      else if (id === "copy-name")
        navigator.clipboard.writeText(t.name).then(
          () => showToast("Copied", t.name),
          () => showToast("Couldn't copy", undefined, "error"),
        );
    };

    const renderRow = (t: SidebarTable, depth: number, inPinned: boolean) => {
      const isParent = t.partitions.length > 0;
      const open = isParent && !inPinned && (filtering || expanded.has(t.key));
      const isPinned = pins.includes(t.key);
      return (
        <li key={`${inPinned ? "pin:" : ""}${t.key}`}>
          <div
            data-table={t.key}
            className={`sb-row${t.key === selectedKey ? " selected" : ""}${isParent && !inPinned ? " has-disclosure" : ""}`}
            data-selected={t.key === selectedKey ? "" : undefined}
            style={depth ? { paddingLeft: 10 + depth * 18 } : undefined}
          >
            <button
              type="button"
              data-testid="sb-row-main"
              className="sb-row-main"
              title={[`${t.schema}.${t.name}`, firstLine(t.table.comment)].filter(Boolean).join("\n")}
              onClick={(e) => openRef.current(t, e.metaKey || e.ctrlKey)}
              onDoubleClick={() => openRef.current(t, true)}
              onMouseEnter={() => hoverRef.current?.(t)}
              onMouseLeave={() => hoverRef.current?.(null)}
              onContextMenu={(e) => rowMenu.open(e, t)}
              onKeyDown={(e) => {
                // ⌥↵ on a focused row, as in ⌘K: its name at the editor's caret.
                if (e.key === "Enter" && e.altKey && !e.metaKey && !e.ctrlKey && insertRef.current) {
                  e.preventDefault();
                  insertRef.current(t);
                }
              }}
            >
              {isParent ? (
                <PartitionedIcon className="sb-icon" />
              ) : t.table.kind === "view" ||
                t.table.kind === "materialized_view" ? (
                <ViewIcon className="sb-icon" />
              ) : (
                <TableIcon className="sb-icon" />
              )}
              <span className="sb-name">{t.name}</span>
              {t.table.kind === "materialized_view" && (
                <span data-testid="sb-badge" className="sb-badge" title="Materialized view">
                  mat
                </span>
              )}
              {isParent && !inPinned && (
                <span data-testid="sb-badge" className="sb-badge">{t.partitions.length} parts</span>
              )}
              <span className="sb-meta" data-rows={t.rows ?? undefined}>
                {formatRowCount(t.rows)}
              </span>
            </button>
            {isParent && !inPinned && (
              <button
                type="button"
                className={`sb-disclosure${open ? " open" : ""}`}
                aria-label={open ? "Hide partitions" : "Show partitions"}
                aria-expanded={open}
                onClick={() => toggleSet(setExpanded, t.key)}
              >
                <ChevronDownIcon size={10} />
              </button>
            )}
            <button
              type="button"
              data-testid="sb-pin"
              className={`sb-pin${isPinned ? " on" : ""}`}
              aria-label={isPinned ? `Unpin ${t.name}` : `Pin ${t.name}`}
              aria-pressed={isPinned}
              onClick={() => togglePin(t.key)}
            >
              <PinIcon size={11} filled={isPinned} />
            </button>
          </div>
          {open && (
            <ul className="sb-list">
              {t.partitions.map((p) => renderRow(p, depth + 1, inPinned))}
            </ul>
          )}
        </li>
      );
    };

    const section = (
      key: string,
      label: string,
      count: number,
      rows: SidebarTable[],
      inPinned = false,
    ) => {
      const isCollapsed = collapsed.has(key) && !filtering;
      return (
        <section data-testid="sb-section" className="sb-section" key={key} data-section-key={key}>
          <button
            type="button"
            className="sb-section-header"
            aria-expanded={!isCollapsed}
            onClick={() => toggleSet(setCollapsed, key)}
          >
            <ChevronDownIcon
              size={10}
              className={`sb-chevron${isCollapsed ? " collapsed" : ""}`}
            />
            <span data-testid="sb-section-label" className="sb-section-label">{label}</span>
            <span data-testid="sb-section-count" className="sb-section-count">{count}</span>
          </button>
          {!isCollapsed && (
            <ul className="sb-list">
              {rows.map((t) => renderRow(t, 0, inPinned))}
            </ul>
          )}
        </section>
      );
    };

    const list = useMemo(
      () => (
        <>
          {pinned.length > 0 &&
            section("pinned", "Pinned", pinned.length, pinned, true)}
          {visible.flatMap((s) => [
            s.tables.length > 0 &&
              section(
                s.key,
                single ? "Tables" : s.schema,
                s.count,
                s.tables,
              ),
            s.views.length > 0 &&
              section(
                `${s.key}:views`,
                single ? "Views" : `${s.schema} views`,
                s.views.length,
                s.views,
              ),
          ])}
        </>
      ),
      // `section` and `renderRow` read only these (and `openRef`, `insertRef`, `rowMenu.open`).
      [pinned, visible, single, collapsed, expanded, pins, selectedKey, filtering],
    );

    return (
      <aside data-testid="sidebar" className="sidebar" data-empty={connectionId ? undefined : ""} data-failed={failed || undefined}>
        <div data-testid="sb-head" className="sb-head" data-tauri-drag-region>
          <div data-testid="sb-head-switch" className="sb-head-switch">{head}</div>
          {menu}
        </div>
        {(sub || status || onRefresh || envTag) && (
          // Under the name: where it points (mono, with latency, env and ↻).
          // Safe mode and MCP moved to the title bar (Paper, 2026-10-13).
          <div data-testid="sb-head-sub" className="sb-head-sub" data-tauri-drag-region>
            <div className="sb-head-line" data-tauri-drag-region>
              {sub}
              {sub && status && <span className="sb-head-dot" aria-hidden />}
              {status}
              {envTag}
              <span className="sb-head-sub-gap" data-tauri-drag-region />
              {onRefresh && (
                <button
                  type="button"
                  data-testid="sb-refresh"
                  data-hint-cmd="refresh-schema"
                  className="sb-refresh"
                  data-spinning={refreshing || undefined}
                  title={commandTip("refresh-schema", "Reload tables and columns")}
                  aria-label="Refresh schema"
                  disabled={refreshing}
                  onClick={onRefresh}
                >
                  <RefreshIcon size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="sb-body">
          <label data-testid="sb-filter" className="sb-filter">
            <SearchIcon size={13} />
            <input
              ref={filterRef}
              value={filter}
              placeholder="Filter tables"
              aria-label="Filter tables"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  e.currentTarget.blur();
                }
              }}
            />
            {!filter && <kbd className="sb-kbd">/</kbd>}
          </label>
          {keyStrip}

          {/* A new schema (connect, database change) remounts the list, which
              fades it in and starts it at the top. */}
          <div
            ref={scrollRef}
            data-testid="sb-scroll"
            className="sb-scroll"
            key={`${connectionId}:${schemas[0]?.database ?? ""}:${schemas.length > 0}`}
          >
            {schemas.length === 0 ? (
              // Couldn't connect folds the column to its head (styles/connect-to-start.css).
              failed ? null : (
                <div className="sb-empty">
                  {connecting
                    ? "Loading schema…"
                    : connectionId
                      ? "No tables"
                      : "Pick a connection to start"}
                </div>
              )
            ) : visible.length === 0 ? (
              <div className="sb-empty">No matches</div>
            ) : (
              list
            )}
          </div>
        </div>
        {foot}
        <GridMenu
          name="panel-row"
          label="Table"
          at={rowMenu.at}
          items={panelRowMenu({
            pinned: !!rowMenu.target && pins.includes(rowMenu.target.key),
            mac: isMacPlatform(),
            importable: !!onImportCsv && !!rowMenu.target && !isView(rowMenu.target),
          })}
          onPick={pickRow}
          onClose={rowMenu.close}
        />
      </aside>
    );
  },
);

/**
 * The schema column's foot (2026-10-13, reordered 2026-10-17): past a rule,
 * one row of 28 px icon buttons under one glide hover; the name and key are
 * in each tooltip. On the left, Agents (a green dot while this connection is
 * shared, the count of proposed changes while any wait) and Presenting
 * (orange while on: hides sensitive columns and the host). On the right, the
 * orange update button while a newer Rowkery waits (opens Settings >
 * Updates) and Settings. Appearance and Keyboard shortcuts left the foot
 * (2026-10-17): both are in Settings, and nobody changes them often.
 */
export function SidebarFoot({
  mcpOn,
  agentsOpen,
  proposals = 0,
  onAgents,
  settingsOpen = false,
  onSettings,
}: {
  mcpOn: boolean;
  agentsOpen: boolean;
  /** Changes agents proposed that wait: a count on the button. */
  proposals?: number;
  onAgents: () => void;
  settingsOpen?: boolean;
  onSettings?: (section?: SettingsSection) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGlideHover(ref, ".sb-foot-btn");
  const mac = isMacPlatform();
  const presenting = usePresenting();
  const update = useUpdateState();
  const pref = useUpdatePref();
  const waiting = updateWaiting(update, pref);
  // The Agents page opens on the oldest waiting proposal, so the count is the way in.
  const review = proposals > 0 && !agentsOpen;
  return (
    <div data-testid="sb-foot-rows" className="sb-foot-rows" ref={ref}>
      <button
        type="button"
        className="sb-foot-btn"
        data-testid="sb-agents"
        data-hint-cmd="agents"
        data-live={mcpOn ? "" : undefined}
        data-on={agentsOpen ? "" : undefined}
        aria-pressed={agentsOpen}
        aria-label="Agents"
        title={
          review
            ? `Review ${proposals === 1 ? "a proposed change" : `${proposals} proposed changes`}`
            : commandTip("agents", agentsOpen ? "Back to the window" : "Agents", mac)
        }
        onClick={onAgents}
      >
        <AgentIcon size={14} />
        {review ? (
          <span className="sb-agents-count" data-testid="sb-proposals">
            {proposals}
          </span>
        ) : (
          mcpOn && <span className="sb-agents-dot" aria-label="Shared with agents" />
        )}
      </button>
      <button
        type="button"
        className="sb-foot-btn"
        data-testid="sb-presenting"
        data-hint-cmd="presenting"
        data-on={presenting ? "" : undefined}
        aria-pressed={presenting}
        aria-label="Presenting"
        title={presenting ? "Stop presenting" : "Start presenting"}
        onClick={() => setPresenting(!presenting)}
      >
        {presenting ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </button>
      <span className="sb-foot-gap" />
      {waiting && onSettings && (
        <button
          type="button"
          className="sb-foot-btn sb-update"
          data-testid="sb-update"
          data-phase={update.phase}
          aria-label={updateLabel(update)}
          title={updateLabel(update)}
          onClick={() => onSettings("updates")}
        >
          <DownloadIcon size={14} />
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          className="sb-foot-btn"
          data-testid="sb-settings"
          data-hint-cmd="settings"
          data-on={settingsOpen ? "" : undefined}
          aria-pressed={settingsOpen}
          aria-label="Settings"
          title={commandTip("settings", "Settings", mac)}
          onClick={() => onSettings()}
        >
          <SettingsIcon size={14} />
        </button>
      )}
    </div>
  );
}

/** The update button's name: what waits, and that it opens Settings. */
function updateLabel(s: UpdateState): string {
  if (s.phase === "downloading") return `Downloading Rowkery ${s.version}`;
  if (s.phase === "ready") return `Rowkery ${s.version} is ready · restart in Settings`;
  if (s.phase === "available") return `Rowkery ${s.version} is out · download in Settings`;
  return "Updates";
}
