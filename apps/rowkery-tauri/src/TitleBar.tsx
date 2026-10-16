import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { ENGINES } from "./engines";
import { PenguinMark } from "./PenguinMark";
import { GridMenu, useContextMenu } from "./GridMenu";
import { railTileMenu } from "./contextMenus";
import { CloseIcon, PlusIcon, SearchIcon, WarningIcon } from "./icons";
import { useGlideHover } from "./motion";
import { isMacPlatform } from "./platform";
import { commandTip, keysFor } from "./commands";
import { useTabReorder } from "./tabReorder";
import { WindowControls } from "./WindowControls";
import { CONNECTION_ENVS, type ConnectionRecord } from "./types";
import type { WindowSession } from "./Workspace";
import { Keys } from "./Keys";

interface TitleBarProps {
  windows: WindowSession[];
  activeId: string;
  connections: ConnectionRecord[];
  /** Connections an agent read through MCP in the last minute: a small tag on their tabs. */
  mcpRecent?: ReadonlySet<string>;
  /** Windows out of sight with queries still running: their tab spins. */
  busy: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** A tab was dragged from `from` to `to` (indexes into `windows`). */
  onReorder: (from: number, to: number) => void;
  /** + (and ⌘T): a new empty window, which shows Connect to start. */
  onNewWindow: () => void;
  /** A tab's MCP tag: the Agents page. */
  onAgents: () => void;
  /** ⌘K. */
  onSearch: () => void;
  /** The shown window portals its Safe mode and MCP buttons here while it is connected. */
  toolsRef: Ref<HTMLDivElement>;
  /** A row of a tab's right-click menu (`railTileMenu`); the tab is selected first. */
  onTilePick: (windowId: string, id: string) => void;
}

/**
 * The title bar (Paper, 2026-10-13): 48 px of --bar with a rule under it.
 * Left, the traffic lights and one 28 px pill per window (the engine's logo
 * or the penguin, the connection's name, its environment dot, × on hover and
 * on the shown one), then + for a new window. Right, the shown window's
 * Safe mode and MCP (only while connected) and ⌘K. The theme lives in the
 * schema column's foot (2026-10-13), not here. Drag the pills to reorder; ⌘1–9 follow the order. The bar drags the
 * window.
 */
export function TitleBar({
  windows,
  activeId,
  connections,
  mcpRecent,
  busy,
  onSelect,
  onClose,
  onReorder,
  onNewWindow,
  onAgents,
  onSearch,
  toolsRef,
  onTilePick,
}: TitleBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const mac = isMacPlatform();
  useGlideHover(trackRef, ".win-tab:not([data-on]), .win-add");
  const byId = new Map(connections.map((c) => [c.id, c]));
  // Right-click a tab: what its window can do, with the keys that do it.
  const tileMenu = useContextMenu<WindowSession>();
  const menuWindow = tileMenu.target;
  const menuConn = menuWindow?.connectionId ? byId.get(menuWindow.connectionId) : undefined;

  // Pressing a tab selects it, so the dragged tab is always the shown one.
  const drag = useTabReorder({
    track: trackRef,
    keys: windows.map((w) => w.id),
    onReorder,
    axis: "x",
    onStart: (id) => {
      if (id !== activeId) onSelect(id);
    },
  });

  return (
    <header data-testid="titlebar" className="titlebar" data-tauri-drag-region>
      <WindowControls />
      <div data-testid="win-tabs" className="win-tabs" data-close-scope="connection" ref={trackRef} role="tablist" aria-label="Windows">
        {windows.map((w, i) => {
          const conn = w.connectionId ? byId.get(w.connectionId) : undefined;
          const env = conn?.environment ?? undefined;
          const envLabel = CONNECTION_ENVS.find((e) => e.value === env)?.label;
          const name = conn?.name ?? "New window";
          const engine = conn ? ENGINES[conn.kind] : null;
          const agent = !!conn && !!mcpRecent?.has(conn.id);
          const running = busy.has(w.id);
          const title = [
            name,
            w.database,
            envLabel,
            agent ? "an agent read it in the last minute" : null,
            w.state === "error" ? "couldn't connect" : null,
            running ? "queries running" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              key={w.id}
              role="tab"
              aria-selected={w.id === activeId}
              aria-label={name}
              data-testid="win-tab"
              data-hint-win={i < 9 ? i + 1 : undefined}
              className="win-tab"
              data-on={w.id === activeId ? "" : undefined}
              data-empty={conn ? undefined : ""}
              data-env={env}
              data-reorder-key={w.id}
              title={i < 9 ? `${title}  ${mac ? "⌘" : "Ctrl+"}${i + 1}` : title}
              style={engine ? ({ "--engine": engine.color } as CSSProperties) : undefined}
              onPointerDown={(e: ReactPointerEvent<HTMLElement>) => drag(w.id)(e)}
              onMouseDown={(e) => {
                if (e.button === 0) onSelect(w.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(w.id);
              }}
              onContextMenu={(e) => {
                if (w.id !== activeId) onSelect(w.id);
                tileMenu.open(e, w);
              }}
            >
              <span data-testid="win-icon" className="win-icon">
                {engine ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                    <path d={engine.logo} fill="currentColor" />
                  </svg>
                ) : (
                  <PenguinMark size={14} className="win-penguin" />
                )}
              </span>
              <span data-testid="win-name" className="win-name">
                {name}
              </span>
              {w.state === "connecting" || running ? (
                <span data-testid="win-mark" data-kind="spin" className="win-mark win-spin" aria-label={running ? "Queries running" : "Connecting"} />
              ) : w.state === "error" ? (
                <span data-testid="win-mark" data-kind="warn" className="win-mark win-warn">
                  <WarningIcon size={9} />
                </span>
              ) : env ? (
                <span data-testid="win-mark" data-kind="env" className="win-mark win-env" />
              ) : null}
              {agent && (
                <button
                  type="button"
                  data-testid="win-mcp"
                  className="win-mcp"
                  data-no-drag
                  aria-label="Read by an agent in the last minute. Open Agents"
                  title="An agent read it in the last minute · Agents"
                  tabIndex={-1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAgents();
                  }}
                >
                  MCP
                </button>
              )}
              <button
                type="button"
                className="win-close"
                data-no-drag
                aria-label={`Close ${name}`}
                title={commandTip("close-window", "Close window", mac)}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onClose(w.id)}
              >
                <CloseIcon size={9} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          data-testid="win-add"
          data-hint-cmd="new-window"
          className="win-add"
          aria-label="New window"
          title={commandTip("new-window", "Open a new window", mac)}
          onClick={onNewWindow}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      <span className="titlebar-gap" data-tauri-drag-region />
      <div className="titlebar-tools">
        <div data-testid="titlebar-conn" className="titlebar-conn" ref={toolsRef} />
        <button
          type="button"
          data-testid="search-cap"
          className="search-cap"
          title={commandTip("command-palette", "Search tables, queries and commands", mac)}
          aria-label="Search"
          data-keys-for="command-palette"
          onClick={onSearch}
        >
          <SearchIcon size={13} />
          <span className="search-cap-label">
            Search<span className="search-cap-more"> tables, commands</span>
          </span>
          <kbd data-testid="search-cap-key" className="search-cap-key">
            <Keys text={keysFor("command-palette", mac).replace("+", " ")} />
          </kbd>
        </button>
      </div>
      <GridMenu
        name="win-tab"
        label="Window"
        at={tileMenu.at}
        items={railTileMenu({
          hasConnection: !!menuConn,
          connected: menuWindow?.state === "connected",
          postgres: menuConn?.kind === "postgres",
        })}
        onPick={(id) => menuWindow && onTilePick(menuWindow.id, id)}
        onClose={tileMenu.close}
      />
    </header>
  );
}
