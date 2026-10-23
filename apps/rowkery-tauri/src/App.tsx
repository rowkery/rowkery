import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  closeWindow,
  forgetConnectionSecrets,
  chooseFile,
  explainConnectError,
  listConnections,
  openSample,
  probeConnection,
  readClipboardText,
  openWindow,
  pingIdle,
  reloadWindowSchema,
  tableCounts,
  saveConnection,
  sqliteFileExists,
  takeOpenLink,
  TEST_PG_CONNECTION,
  TEST_PG_SECRETS,
  type LocalServer,
} from "./api";
import { parsePostgresUrl } from "./connectionUrl";
import { CatalogUpdates, type CatalogUpdate } from "./catalogUpdates";
import { applyTableCounts } from "./rowCounts";
import { ConnectionSwitcher } from "./ConnectionSwitcher";
import { DatabaseSwitcher } from "./DatabaseSwitcher";
import { NewConnectionSheet } from "./NewConnectionSheet";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { NoticesSheet } from "./NoticesSheet";
import { AgentSharing } from "./AgentSharing";
import { AgentsInbox } from "./AgentsInbox";
import { pollProposals, proposalTable, useProposals } from "./proposals";
import { McpConnectSheet } from "./McpConnectSheet";
import { clientLabel, mcpShared, mcpStats, mcpTagLive, pollMcp, recentConnections, useMcpEntries, verdictOf } from "./mcpActivity";
import { useKeymap } from "./keymaps";
import { ReportSheet } from "./ReportSheet";
import type { ReportContext } from "./report";
import { Presence } from "./motion";
import { isMacPlatform } from "./platform";
import { hasPendingUndo, liveOffer, showOfferToast, showToast, showUndoToast } from "./notify";
import { readKey, writeKey } from "./persist";
import { endSpanAfterPaint, flushTimings, mark, markOnce, startSpan } from "./timings";
import { ToastHost } from "./Toast";
import {
  CONNECTION_ENVS,
  SAFE_MODES,
  type ConnectionEnv,
  type ConnectionRecord,
  type MaskedColumns,
  type McpAccess,
  type SafeMode,
} from "./types";
import { defaultAccess } from "./mcpAccess";
import { moveItem } from "./tabReorder";
import { planSqliteOpen } from "./sqliteOpen";
import { TitleBar } from "./TitleBar";
import { FIRST_CHECK_MS, RECHECK_MS, lookForUpdate, watchIdleInstall } from "./updates";
import { SettingsPage, type SettingsSection } from "./SettingsPage";
import { CmdHints } from "./CmdHints";
import { loadWindows, saveWindows, type SavedTab } from "./windowStore";
import { Workspace } from "./Workspace";
import type { WindowActions, WindowSession } from "./windowSession";
import "./App.css";
// The shell's styles, after App.css's tokens and layout, in this order: the
// cascade depends on it, so they stay here rather than beside their components.
import "./styles/titlebar.css";
import "./styles/connection-switcher.css";
import "./styles/window-tabs.css";
import "./styles/windows.css";
import "./styles/schema-panel.css";
import "./styles/main-column.css";
import "./styles/sql-editor.css";
import "./styles/palette.css";
import "./styles/toast.css";
import "./styles/table-tabs.css";
import "./styles/connect-to-start.css";
import "./styles/scrollbars.css";
import "./styles/sheets.css";

const PROOFS = new Set(["query-cancel", "1", "latency"]);

/** Connections deleted whose keychain entries wait for the Undo toast to go. */
const PENDING_DELETE_KEY = "rowkery.pendingDelete";
function pendingDeletes(): string[] {
  const v = readKey(PENDING_DELETE_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function blankWindow(
  id: string,
  connectionId: string | null = null,
  database: string | null = null,
): WindowSession {
  return {
    id,
    connectionId,
    database,
    state: "idle",
    schema: null,
    serverVersion: null,
    connectMs: null,
    error: null,
    schemaAt: null,
    refreshing: false,
  };
}

const SIDEBAR_KEY = "rowkery.sidebarHidden";

function loadSidebarHidden(): boolean {
  // Old builds stored "1" / "0" (JSON-parsed to 1 / 0).
  const v = readKey(SIDEBAR_KEY);
  return v === 1 || v === "1" || v === true;
}

function saveSidebarHidden(hidden: boolean) {
  writeKey(SIDEBAR_KEY, hidden ? 1 : 0);
}

/** The schema panel's width: dragged between 240 and 360 px, saved in config.json. */
const PANEL_KEY = "rowkery.panelWidth";
export const PANEL_MIN = 240;
export const PANEL_MAX = 360;
/** Where the panel starts, and where a double-click on its edge returns it (Paper). */
export const PANEL_DEFAULT = 264;
const clampPanel = (w: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));
function loadPanelWidth(): number {
  const v = Number(readKey(PANEL_KEY));
  return Number.isFinite(v) && v > 0 ? clampPanel(v) : PANEL_DEFAULT;
}

type Popover = "connection" | "database" | null;

/** Where typing goes: ⌘V there pastes text, not a connection. */
function isTextField(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** The sample's first tab: the lesson as comments, and a statement that has already run. */
function gettingStartedTab(): SavedTab {
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";
  return {
    kind: "query",
    title: "Getting started",
    sql: [
      "-- Rowkery sample. Six tables, one view. Yours to change.",
      `-- ${mod}↵ runs the statement under the caret.`,
      `-- Click a table on the left to browse it. ${mod}K finds any`,
      "-- table, query or command.",
      "SELECT name, city, opened_on",
      "FROM kiosks ORDER BY opened_on DESC;",
      "",
      `-- Your own database: ${mod}N, or paste a postgres:// URL.`,
      `-- ${mod}K "Reset the sample database" puts this file back.`,
      "",
    ].join("\n"),
  };
}

function App() {
  const proofEnv = import.meta.env.VITE_ROWKERY_AUTO_PROOF as string | undefined;
  const proof = proofEnv && PROOFS.has(proofEnv) ? proofEnv : undefined;
  // The latency proof measures a normal launch: it keeps and restores windows.
  const freshWindows = !!proof && proof !== "latency";
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [windows, setWindows] = useState<WindowSession[]>(() => {
    const saved = freshWindows ? null : loadWindows();
    return saved
      ? saved.windows.map((w, i) => blankWindow(`w${i + 1}`, w.connectionId, w.database))
      : [blankWindow("w1", proof ? TEST_PG_CONNECTION.id : null)];
  });
  const [activeWindowId, setActiveWindowId] = useState(() => {
    const saved = freshWindows ? null : loadWindows();
    return saved ? `w${saved.active + 1}` : "w1";
  });
  const nextWindowNo = useRef(windows.length + 1);
  /** Each window's tabs as last reported, saved with the windows. */
  const tabsByWindow = useRef(
    new Map<string, { tabs: SavedTab[]; active: number }>(
      proof
        ? []
        : (loadWindows()?.windows ?? []).flatMap((w, i) =>
            w.tabs ? [[`w${i + 1}`, { tabs: w.tabs, active: w.activeTab ?? 0 }]] : [],
          ),
    ),
  );
  const restoredTabs = useRef(new Map(tabsByWindow.current));
  /** No windows were saved: a first launch (or every window was closed). */
  const launchedEmpty = useRef<boolean | null>(null);
  if (launchedEmpty.current === null) launchedEmpty.current = !freshWindows && !loadWindows();
  /** Windows whose shown tab runs once they connect (the sample's Getting started). */
  const runOnConnect = useRef(new Set<string>());
  /** Latest open request per window, so a slow connect can't land late. */
  const openSeq = useRef(new Map<string, number>());
  const [loaded, setLoaded] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [newConnOpen, setNewConnOpen] = useState(false);
  /** Set while the sheet edits a saved connection instead of creating one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** ⇧⌘/, the schema column's Help button, Help > Keyboard Shortcuts. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Help > Third-party Notices, ⌘K, the shortcut sheet's foot. */
  const [noticesOpen, setNoticesOpen] = useState(false);
  /** Running tabs per window, for the window pill's status. */
  const [runningByWindow, setRunningByWindow] = useState<Record<string, number>>({});
  const onRunningChange = useCallback((windowId: string, running: number) => {
    setRunningByWindow((prev) => (prev[windowId] === running ? prev : { ...prev, [windowId]: running }));
  }, []);
  const runningRef = useRef(runningByWindow);
  runningRef.current = runningByWindow;
  /** Queries running in every window: an update's Restart waits for them. */
  const runningQueries = useCallback(
    () => Object.values(runningRef.current).reduce((sum, n) => sum + n, 0),
    [],
  );
  /** Help > Report an Issue…, with what the window knew when it was asked. */
  const [report, setReport] = useState<ReportContext | null>(null);
  /** The Agents page (proposals and the log) in place of the main column; null while the window shows. */
  /** The Agents page; `proposal` picks that one (a card's Review in Rowkery). */
  const [agents, setAgents] = useState<{ initial: "proposals" | "activity"; proposal?: string } | null>(null);
  /** The Settings page in place of the main column (⌘,, the foot's gear); null while the window shows. */
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  /**
   * Settings › Agents: Connect an agent open under its head, and the
   * connection whose Edit access is open (`fill`: opened by turning sharing
   * on, so it ticks the own database's tables).
   */
  const [sharing, setSharing] = useState<{ connect: boolean; edit: string | null; fill: boolean }>({
    connect: false,
    edit: null,
    fill: false,
  });
  const proposals = useProposals();
  /** Connect an agent as a sheet, over the connection sheet (unsaved edits stay). */
  const [connectOpen, setConnectOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const frameRef = useRef<HTMLDivElement>(null);
  const macOverlay = isMacPlatform();
  // A keymap change re-renders every tooltip and keycap (keysFor).
  useKeymap();

  const activeWindow =
    windows.find((w) => w.id === activeWindowId) ?? windows[0];
  const activeConnection =
    connections.find((c) => c.id === activeWindow?.connectionId) ?? null;
  const openIds = useMemo(
    () =>
      new Set(
        windows
          .filter((w) => w.connectionId && w.state === "connected")
          .map((w) => w.connectionId as string),
      ),
    [windows],
  );

  const patchWindow = useCallback(
    (id: string, patch: Partial<WindowSession>) =>
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w))),
    [],
  );

  const refreshConnections = useCallback(async () => {
    const dto = await listConnections();
    setConnections(dto.connections);
    return dto.connections;
  }, []);

  useEffect(() => {
    void (async () => {
      let list = await refreshConnections();
      // Proof builds only: a real first launch shows the empty state and
      // writes nothing (no record, no keychain entry). Core's first run has
      // already added the sample database, so look for the proof's own.
      if (proof && !list.some((c) => c.id === TEST_PG_CONNECTION.id)) {
        await saveConnection(TEST_PG_CONNECTION, TEST_PG_SECRETS);
        list = await refreshConnections();
      }
      // Drop restored windows whose connection was deleted.
      const ids = new Set(list.map((c) => c.id));
      setWindows((prev) => {
        const kept = prev.map((w) =>
          w.connectionId && !ids.has(w.connectionId) ? blankWindow(w.id) : w,
        );
        return kept;
      });
      // First launch: core wrote the sample database; open it with its
      // Getting started tab, whose statement runs as the window connects.
      const sample = list.find((c) => c.kind === "sqlite" && c.sample);
      if (launchedEmpty.current && sample && list.length === 1) {
        const id = `w${nextWindowNo.current++}`;
        const seeded = { tabs: [gettingStartedTab()], active: 0 };
        restoredTabs.current.set(id, seeded);
        tabsByWindow.current.set(id, seeded);
        runOnConnect.current.add(id);
        setWindows([blankWindow(id, sample.id)]);
        setActiveWindowId(id);
      }
      setLoaded(true);
      // Deletes whose Undo toast didn't outlive the last run: finish them.
      const pending = pendingDeletes();
      if (pending.length) {
        writeKey(PENDING_DELETE_KEY, []);
        for (const gone of pending) {
          if (!ids.has(gone)) void forgetConnectionSecrets(gone).catch(() => {});
        }
      }
    })();
  }, [refreshConnections]);

  // The quiet update check: once the first query has had its turn, then every
  // few hours. Rust answers "off" in dev builds and proof runs (updates.rs).
  useEffect(() => {
    if (!loaded || !("__TAURI_INTERNALS__" in window)) return;
    const quiet = () => void lookForUpdate(false, runningQueries);
    const first = window.setTimeout(quiet, FIRST_CHECK_MS);
    const again = window.setInterval(quiet, RECHECK_MS);
    const idle = watchIdleInstall(runningQueries);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
      idle();
    };
  }, [loaded, runningQueries]);

  /**
   * A cached catalog shows at once (sidebar spinner on); core then checks the
   * live one and confirms it, replaces it, or reports the connection failed.
   */
  const catalogUpdates = useRef(new CatalogUpdates());
  const applyCatalogUpdate = useCallback(
    (u: CatalogUpdate | null) => {
      if (!u) return;
      if (u.kind === "confirmed") patchWindow(u.window_id, { refreshing: false });
      else if (u.kind === "replaced")
        patchWindow(u.window_id, {
          schema: u.catalog,
          serverVersion: u.server_version ?? null,
          schemaAt: Date.now(),
          refreshing: false,
        });
      else
        patchWindow(u.window_id, {
          state: "error",
          error: u.error,
          schema: null,
          refreshing: false,
        });
    },
    [patchWindow],
  );
  useEffect(() => {
    const onUpdate = (e: Event) =>
      applyCatalogUpdate(catalogUpdates.current.receive((e as CustomEvent<CatalogUpdate>).detail));
    window.addEventListener("rowkery:catalog-update", onUpdate);
    return () => window.removeEventListener("rowkery:catalog-update", onUpdate);
  }, [applyCatalogUpdate]);

  /**
   * SQLite counts rows after the catalog is shown (counting was most of what
   * introspection cost): fill them in when they come, unless the window
   * moved on meanwhile.
   */
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const fillCounts = useCallback(async (windowId: string, connectionId: string, seq: number) => {
    if (connectionsRef.current.find((c) => c.id === connectionId)?.kind !== "sqlite") return;
    try {
      const counts = await tableCounts(windowId);
      if (openSeq.current.get(windowId) !== seq || !counts.length) return;
      setWindows((prev) =>
        prev.map((w) => (w.id === windowId && w.schema ? { ...w, schema: applyTableCounts(w.schema, counts) } : w)),
      );
    } catch {
      // Counts are a nicety; the sidebar shows none.
    }
  }, []);
  const fillCountsRef = useRef(fillCounts);
  fillCountsRef.current = fillCounts;

  /** Points a window at a connection (and database), loading its schema. */
  const connectWindow = useCallback(
    async (windowId: string, connectionId: string, database?: string | null) => {
      const seq = (openSeq.current.get(windowId) ?? 0) + 1;
      openSeq.current.set(windowId, seq);
      catalogUpdates.current.forget(windowId);
      patchWindow(windowId, {
        connectionId,
        database: database ?? null,
        state: "connecting",
        schema: null,
        serverVersion: null,
        error: null,
      });
      const started = performance.now();
      try {
        const opened = await openWindow(windowId, connectionId, database);
        if (openSeq.current.get(windowId) !== seq) return;
        mark("socket-warm", {
          window: windowId,
          open_ms: Math.round(performance.now() - started),
        });
        patchWindow(windowId, {
          database: opened.database,
          schema: opened.catalog,
          serverVersion: opened.server_version ?? null,
          state: "connected",
          connectMs: performance.now() - started,
          schemaAt: Date.now(),
          refreshing: !!opened.cached,
        });
        if (opened.cached)
          applyCatalogUpdate(catalogUpdates.current.expect(windowId, opened.open_seq));
        void fillCountsRef.current(windowId, connectionId, seq);
      } catch (e) {
        if (openSeq.current.get(windowId) !== seq) return;
        mark("socket-failed", { window: windowId, error: String(e) });
        void flushTimings();
        patchWindow(windowId, { state: "error", error: String(e) });
      }
    },
    [patchWindow, applyCatalogUpdate],
  );

  /**
   * Reloads a connected window's schema without blanking the one it shows.
   * Not through `openWindow`: that re-points the window, which closes its
   * query tabs' sessions and any transaction open in them.
   */
  const refreshing = useRef(new Map<string, boolean>()); // window → asked again
  const announce = useRef(new Set<string>()); // windows whose reload was asked for by hand
  const refreshSchema = useCallback(
    async (windowId: string, manual = false) => {
      const w = windowsRef.current.find((x) => x.id === windowId);
      if (!w?.connectionId || w.state !== "connected") return;
      if (manual) announce.current.add(windowId);
      // DDL that lands mid-reload may miss its snapshot: go again after.
      if (refreshing.current.has(windowId)) {
        refreshing.current.set(windowId, true);
        return;
      }
      const seq = openSeq.current.get(windowId) ?? 0;
      let spinning = false;
      try {
        do {
          refreshing.current.set(windowId, false);
          if (!spinning && announce.current.has(windowId)) {
            spinning = true;
            patchWindow(windowId, { refreshing: true });
          }
          const catalog = await reloadWindowSchema(windowId);
          // A connect or switch started meanwhile wins.
          if (openSeq.current.get(windowId) !== seq) return;
          patchWindow(windowId, { schema: catalog, schemaAt: Date.now() });
          void fillCountsRef.current(windowId, w.connectionId, seq);
        } while (refreshing.current.get(windowId));
        if (announce.current.has(windowId)) showToast("Schema refreshed");
      } catch (e) {
        // Keep the schema we have; the next reload may work.
        if (announce.current.has(windowId))
          showToast("Couldn't refresh schema", String(e), "error");
      } finally {
        refreshing.current.delete(windowId);
        announce.current.delete(windowId);
        if (spinning) patchWindow(windowId, { refreshing: false });
      }
    },
    [patchWindow],
  );

  // Windows connect when first shown, so restored windows cost nothing until
  // you look at them.
  useEffect(() => {
    if (!loaded || !activeWindow?.connectionId) return;
    if (activeWindow.state !== "idle") return;
    void connectWindow(
      activeWindow.id,
      activeWindow.connectionId,
      activeWindow.database,
    );
  }, [loaded, activeWindow, connectWindow]);

  const saveAllWindows = useCallback(() => {
    if (freshWindows) return;
    const list = windowsRef.current;
    saveWindows(
      list.map((w) => {
        const t = tabsByWindow.current.get(w.id);
        return { connectionId: w.connectionId, database: w.database, tabs: t?.tabs, activeTab: t?.active };
      }),
      Math.max(0, list.findIndex((w) => w.id === activeWindowIdRef.current)),
    );
  }, [freshWindows]);
  const activeWindowIdRef = useRef(activeWindowId);
  activeWindowIdRef.current = activeWindowId;
  useEffect(() => {
    saveAllWindows();
  }, [windows, activeWindowId, saveAllWindows]);
  /** A window's tabs or SQL changed (persist.ts writes about a second later). */
  const onTabsChange = useCallback(
    (windowId: string, tabs: SavedTab[], active: number) => {
      tabsByWindow.current.set(windowId, { tabs, active });
      saveAllWindows();
    },
    [saveAllWindows],
  );

  /** A new window, shown; with no connection it shows Connect to start (+, ⌘T). */
  const newWindow = (connectionId?: string | null, database?: string | null) => {
    setPopover(null);
    setPaletteOpen(false);
    // The window takes over from the Agents or Settings page, as picking one does.
    setAgents(null);
    setSettings(null);
    // One empty window is enough: + goes back to it instead of adding another.
    const empty = connectionId ? undefined : windowsRef.current.find((w) => !w.connectionId);
    if (empty) return switchWindow(empty.id);
    const id = `w${nextWindowNo.current++}`;
    setWindows((prev) => [...prev, blankWindow(id)]);
    setActiveWindowId(id);
    if (connectionId) void connectWindow(id, connectionId, database);
  };
  const newWindowRef = useRef(newWindow);
  newWindowRef.current = newWindow;

  const closeWindowById = (id: string) => {
    const closing = windowsRef.current.find((w) => w.id === id);
    const closedIndex = windowsRef.current.findIndex((w) => w.id === id);
    const closedTabs = tabsByWindow.current.get(id);
    if (closing?.connectionId) {
      const name = connections.find((c) => c.id === closing.connectionId)?.name ?? "window";
      // Undo brings it back where it was, with its tabs; it reconnects when shown.
      const restore = () => {
        const back = `w${nextWindowNo.current++}`;
        if (closedTabs) restoredTabs.current.set(back, closedTabs);
        setWindows((prev) => {
          const blankOnly = prev.length === 1 && !prev[0].connectionId;
          const list = blankOnly ? [] : prev;
          const at = Math.min(closedIndex, list.length);
          return [...list.slice(0, at), blankWindow(back, closing.connectionId, closing.database), ...list.slice(at)];
        });
        setActiveWindowId(back);
      };
      showUndoToast(`Closed ${name}${closing.database ? ` / ${closing.database}` : ""}`, undefined, { undo: restore });
    }
    void closeWindow(id);
    openSeq.current.delete(id);
    catalogUpdates.current.forget(id);
    const index = windows.findIndex((w) => w.id === id);
    const rest = windows.filter((w) => w.id !== id);
    if (rest.length === 0) {
      // Like query tabs, closing the last window leaves an empty one.
      const fresh = `w${nextWindowNo.current++}`;
      setWindows([blankWindow(fresh)]);
      setActiveWindowId(fresh);
      return;
    }
    setWindows(rest);
    if (id === activeWindowId) {
      setActiveWindowId(rest[Math.min(index, rest.length - 1)].id);
    }
  };

  // Back from a sleep or another app: check the open windows' idle sessions
  // now, off any query's path (core only pings ones idle a minute or more).
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      for (const w of windowsRef.current) {
        if (w.state === "connected") void pingIdle(w.id).catch(() => {});
      }
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  // The palette belongs to the window it was opened in.
  useEffect(() => setPaletteOpen(false), [activeWindowId]);

  // Timings: first commit, window switches and ⌘K, each to the painted frame.
  useEffect(() => {
    markOnce("shell-painted");
    void flushTimings();
  }, []);
  useEffect(() => endSpanAfterPaint("window-switch", { window: activeWindowId }), [activeWindowId]);
  useEffect(() => {
    if (paletteOpen) endSpanAfterPaint("palette-open");
  }, [paletteOpen]);

  /**
   * Dragging the panel's right edge: live, by setting the CSS variable on
   * the frame (no React render per pixel); the width is kept on release.
   * Double-click goes back to the narrowest.
   */
  const startPanelResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    if (!frame || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let width = panelWidth;
    frame.classList.add("panel-resizing");
    const move = (ev: PointerEvent) => {
      width = clampPanel(panelWidth + ev.clientX - startX);
      frame.style.setProperty("--panel-width", `${width}px`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      frame.classList.remove("panel-resizing");
      setPanelWidth(width);
      writeKey(PANEL_KEY, width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const resetPanelWidth = () => {
    setPanelWidth(PANEL_DEFAULT);
    writeKey(PANEL_KEY, PANEL_DEFAULT);
  };

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      saveSidebarHidden(!hidden);
      return !hidden;
    });
  }, []);

  // The shown pill's slot for its window's safe mode shield (portalled).
  const [titlebarTools, setTitlebarTools] = useState<HTMLSpanElement | null>(null);

  /** Shows another window; `window-switch` times it to the painted frame. */
  const switchWindow = (id: string) => {
    startSpan("window-switch");
    setActiveWindowId(id);
  };

  const cycleWindow = (dir: 1 | -1) => {
    const index = windows.findIndex((w) => w.id === activeWindowId);
    const next = windows[(index + dir + windows.length) % windows.length];
    if (next) switchWindow(next.id);
  };

  const setEnvironment = async (env: ConnectionEnv | null) => {
    if (!activeConnection) return;
    // Empty secrets keep the keychain entries as they are.
    await saveConnection({ ...activeConnection, environment: env }, {});
    await refreshConnections();
    const label = CONNECTION_ENVS.find((e) => e.value === env)?.label;
    showToast(label ? `Marked ${label}` : "Environment cleared", activeConnection.name);
  };

  const setSafeMode = async (mode: SafeMode) => {
    if (!activeConnection) return;
    // Open windows pick the change up on their next run; nothing reconnects.
    await saveConnection({ ...activeConnection, safe_mode: mode }, {});
    await refreshConnections();
    const label = SAFE_MODES.find((m) => m.value === mode)?.label ?? mode;
    showToast(`Safe mode: ${label}`, activeConnection.name);
  };

  /** Allow MCP on or off; `until` (Unix ms) ends a share on its own. */
  const setAllowMcp = async (allow: boolean, id = activeConnection?.id, until: number | null = null) => {
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    // First share: the own database with no tables ticked, and Edit access
    // opens so they can be ticked at once.
    const first = allow && !conn.mcp_access;
    // The MCP server reads the config on every call, so this applies at once.
    await saveConnection(
      {
        ...conn,
        allow_mcp: allow,
        mcp_until: allow ? until : null,
        ...(first ? { mcp_access: defaultAccess(conn), mcp_hidden_tables: [] } : {}),
      },
      {},
    );
    await refreshConnections();
    if (first) openSharing({ edit: conn.id, fill: true });
    const end =
      until === null
        ? ""
        : new Date(until).getHours() === 0 && new Date(until).getMinutes() === 0
          ? " until midnight"
          : ` until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
    showToast(allow ? `Shared with agents${end}` : "Not shared with agents", conn.name);
  };

  /** The page's Stop all sharing: every shared connection, one save each, one toast. */
  const stopAllMcp = async () => {
    const shared = connections.filter((c) => mcpShared(c));
    if (!shared.length) return;
    for (const c of shared) await saveConnection({ ...c, allow_mcp: false, mcp_until: null }, {});
    await refreshConnections();
    showToast("Stopped sharing with agents", shared.length === 1 ? shared[0].name : `${shared.length} connections`);
  };

  /**
   * Edit access: which databases and tables agents reach on one connection.
   * Saved one tick at a time, in order, each with the whole map.
   */
  const accessSaves = useRef<Promise<void>>(Promise.resolve());
  const setMcpAccess = (id: string, access: McpAccess) => {
    accessSaves.current = accessSaves.current.then(async () => {
      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn) return;
      try {
        await saveConnection({ ...conn, mcp_access: access, mcp_hidden_tables: [] }, {});
        await refreshConnections();
      } catch (err) {
        showToast("Couldn't save access", String(err), "error");
      }
    });
  };

  /** Edit access: the connection's sensitive columns, saved in order like ticks. */
  const setMaskedColumns = (id: string, masked: MaskedColumns) => {
    accessSaves.current = accessSaves.current.then(async () => {
      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn) return;
      try {
        await saveConnection({ ...conn, masked_columns: masked }, {});
        await refreshConnections();
      } catch (err) {
        showToast("Couldn't save masked columns", String(err), "error");
      }
    });
  };

  // A time-limited share ends on its own: re-read the connections then, so
  // the title bar, ⌘K and the sheets stop calling it shared.
  const nextShareEnd = connections.reduce<{ at: number; name: string } | null>((soonest, c) => {
    const at = c.allow_mcp ? c.mcp_until : null;
    if (at == null || at <= Date.now() || (soonest && soonest.at <= at)) return soonest;
    return { at, name: c.name };
  }, null);
  useEffect(() => {
    if (!nextShareEnd) return;
    const t = window.setTimeout(
      () => {
        void refreshConnections();
        showToast("Stopped sharing with agents", nextShareEnd.name);
      },
      Math.min(nextShareEnd.at - Date.now() + 50, 2 ** 31 - 1),
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextShareEnd?.at, nextShareEnd?.name]);

  // The MCP server is its own process; its log is read while any connection
  // is shared (or the sheet is open), every 3 s and only while visible.
  const anyShared = connections.some((c) => mcpShared(c));
  const mcpEntries = useMcpEntries();
  const mcpEntriesRef = useRef(mcpEntries);
  mcpEntriesRef.current = mcpEntries;
  const mcpOpenRef = useRef(false);
  const agentsOn = agents !== null;
  mcpOpenRef.current = agentsOn;
  const agentsRef = useRef(false);
  agentsRef.current = agentsOn;
  useEffect(() => {
    if (!anyShared && !agentsOn) return;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const [fresh, proposed] = await Promise.all([pollMcp(), pollProposals()]);
      if (stopped) return;
      // A proposed change: a toast whose Review opens it, unless it's open.
      const latest = proposed[proposed.length - 1];
      if (latest && !agentsRef.current && !hasPendingUndo() && !liveOffer()) {
        const table = proposalTable(latest.sql);
        const count = proposed.length > 1 ? `${proposed.length} changes` : table ? `a change to ${table}` : "a change";
        showOfferToast(`${clientLabel(latest.client)} proposed ${count}`, "Review", undefined, {
          run: () => openAgents("page"),
          mouseOnly: true,
        });
        return;
      }
      if (mcpOpenRef.current) return;
      // A refusal while you work: a toast whose View opens the log. It never
      // replaces an Undo or an offer still on screen, and ↵ never takes it.
      const refused = fresh.filter((e) => verdictOf(e) === "refused").pop();
      if (refused && !hasPendingUndo() && !liveOffer()) {
        const table = refused.verdict?.match(/reads (\S+) \(~/)?.[1]?.replace(/^public\./, "");
        showOfferToast(table ? `MCP refused a full read of ${table}` : "MCP refused a query", "View", undefined, {
          run: () => openAgents("activity"),
          mouseOnly: true,
        });
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 3000);
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyShared, agentsOn]);
  // The window pills' MCP tag: connections read in the last minute. State changes
  // only when that set does, so the poll doesn't re-render the app. The timer
  // runs only while an entry is under a minute old: the tick that clears the
  // tag stops it, and a new entry (a new `mcpEntries`) starts it again.
  const [mcpRecent, setMcpRecent] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let t: number | undefined;
    const update = () => {
      const now = Date.now();
      const next = recentConnections(mcpEntries, now);
      setMcpRecent((prev) =>
        prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next,
      );
      const live = mcpTagLive(mcpEntries, now);
      if (!live && t !== undefined) {
        window.clearInterval(t);
        t = undefined;
      }
      return live;
    };
    if (!update()) return;
    t = window.setInterval(update, 5000);
    return () => window.clearInterval(t);
  }, [mcpEntries]);

  /**
   * The Agents page at its proposals ("page": the oldest waiting, else the
   * newest call) or at its log; the sharing ones ("access", "connect",
   * "edit") are Settings › Agents (2026-10-17).
   */
  const openAgents = (tab: "activity" | "access" | "connect" | "page" | "edit") => {
    setPopover(null);
    setPaletteOpen(false);
    if (tab === "access" || tab === "connect" || tab === "edit")
      return openSharing({ connect: tab === "connect", edit: tab === "edit" ? (activeConnection?.id ?? null) : null });
    setSettings(null);
    setAgents({ initial: tab === "activity" ? "activity" : "proposals" });
  };
  const closeAgents = useCallback(() => setAgents(null), []);

  /** Settings › Agents, with Connect an agent or one connection's Edit access open. */
  const openSharing = (open: { connect?: boolean; edit?: string | null; fill?: boolean } = {}) => {
    setSharing({ connect: !!open.connect, edit: open.edit ?? null, fill: !!open.fill });
    openSettings("agents");
  };

  /** Settings, on a section (Updates by default): the page takes the window, as Agents does. */
  const openSettings = (section: SettingsSection = "updates") => {
    setPopover(null);
    setPaletteOpen(false);
    setShortcutsOpen(false);
    setAgents(null);
    setSettings(section);
  };

  /**
   * An agent's SQL in a query tab on its connection: a window already on it,
   * else a new one. Never run: the user reads it and presses ⌘↵.
   */
  const openMcpSql = (connectionId: string, database: string | undefined, sql: string) => {
    setAgents(null);
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) return;
    const wantDb = conn.kind === "postgres" ? (database ?? conn.database) : null;
    const fits = (w: WindowSession) =>
      w.connectionId === connectionId && (wantDb === null || (w.database ?? (conn.kind === "postgres" ? conn.database : null)) === wantDb);
    const on = fits(activeWindow) ? activeWindow : windowsRef.current.find(fits);
    if (on) {
      switchWindow(on.id);
      window.dispatchEvent(new CustomEvent("rowkery:open-sql", { detail: { windowId: on.id, sql, title: "Agent query" } }));
      return;
    }
    const id = `w${nextWindowNo.current++}`;
    const seeded = { tabs: [{ kind: "query" as const, title: "Agent query", sql }], active: 0 };
    restoredTabs.current.set(id, seeded);
    tabsByWindow.current.set(id, seeded);
    const blankOnly = !activeWindow.connectionId;
    setWindows((prev) => (blankOnly ? prev.map((w) => (w.id === activeWindow.id ? blankWindow(id) : w)) : [...prev, blankWindow(id)]));
    setActiveWindowId(id);
    void connectWindow(id, connectionId, wantDb);
  };

  // A rowkery:// link from a view in the chat: once connections are loaded
  // (it may be what launched the app), and whenever another arrives.
  const openLinkRef = useRef<() => void>(() => {});
  openLinkRef.current = () => {
    void takeOpenLink().then((link) => {
      if (!link) return;
      if (link.kind === "sql") {
        if (!connections.some((c) => c.id === link.connection))
          return showToast("That connection isn't in Rowkery any more", undefined, "error");
        setSettings(null);
        openMcpSql(link.connection, link.database ?? undefined, link.sql);
      } else if (link.kind === "proposal") {
        setPopover(null);
        setPaletteOpen(false);
        setSettings(null);
        setAgents({ initial: "proposals", proposal: link.id });
      } else if (link.kind === "decided") {
        showToast("That change isn't waiting for you any more");
      } else if (link.kind === "refused") {
        showToast("Rowkery won't open that query: it didn't pass the agent checks", undefined, "error");
      } else {
        showToast("That query isn't in Rowkery's activity log any more", undefined, "error");
      }
    }, () => {});
  };
  useEffect(() => {
    if (!loaded || !("__TAURI_INTERNALS__" in window)) return;
    const take = () => openLinkRef.current();
    take();
    window.addEventListener("rowkery:open-link", take);
    return () => window.removeEventListener("rowkery:open-link", take);
  }, [loaded]);

  /** Import CSV moved to a connection (the panel's picker): the window it opens in, and the file. */
  const [pendingImport, setPendingImport] = useState<{ windowId: string; path: string } | null>(null);
  /** A window already on the connection, else a new one, connected; it takes the file once it has its schema. */
  const importInConnection = (connectionId: string, path: string) => {
    const on = (["connected", "connecting"] as const)
      .map((state) => windowsRef.current.find((w) => w.connectionId === connectionId && w.state === state))
      .find(Boolean);
    if (on) {
      switchWindow(on.id);
      return setPendingImport({ windowId: on.id, path });
    }
    const id = `w${nextWindowNo.current++}`;
    setWindows((prev) => [...prev, blankWindow(id)]);
    setActiveWindowId(id);
    setPendingImport({ windowId: id, path });
    void connectWindow(id, connectionId);
  };

  /** The edit sheet; from a failed connection with the field to mark. */
  const [markField, setMarkField] = useState<{ field: string; message: string } | null>(null);
  /** A new connection's starting point (a pasted string, a Found row). */
  const [prefill, setPrefill] = useState<{ url?: string; fields?: Record<string, string> } | null>(null);
  const openSheet = (start: typeof prefill, mark: typeof markField = null) => {
    setPopover(null);
    setEditingId(null);
    setPrefill(start);
    setMarkField(mark);
    setNewConnOpen(true);
  };

  /** A new connection opens in this window when it's empty, else in its own. */
  const openInWindow = (id: string) => {
    const w = windowsRef.current.find((x) => x.id === activeWindowIdRef.current);
    if (w && !w.connectionId) void connectWindow(w.id, id);
    else newWindow(id);
  };

  /**
   * ⌘O or a dropped file: a SQLite connection named after it, connected; the
   * one already saved on that path when there is one. A path typed or pasted
   * into ⌘K (`typed`) must name a file first, or nothing is saved.
   */
  const openSqlitePath = async (path: string, typed = false) => {
    try {
      const plan = await planSqliteOpen(path, connectionsRef.current, typed ? { exists: sqliteFileExists } : {});
      if (plan.kind === "missing") {
        showToast(`No SQLite file at ${path}`, undefined, "error");
        return;
      }
      if (plan.kind === "reuse") {
        openInWindow(plan.id);
        return;
      }
      await saveConnection(plan.record, {});
      await refreshConnections();
      openInWindow(plan.record.id);
      showToast("Added", plan.record.name);
    } catch (e) {
      showToast("Couldn't open the file", String(e), "error");
    }
  };

  const openSqlitePathRef = useRef(openSqlitePath);
  openSqlitePathRef.current = openSqlitePath;

  /** A Found on this Mac row: libpq's defaults; a failure opens the sheet marked. */
  const connectFound = async ({ port, user }: LocalServer) => {
    const record: ConnectionRecord = {
      kind: "postgres",
      id: crypto.randomUUID(),
      name: `localhost:${port}`,
      host: "localhost",
      port,
      database: user,
      username: user,
      ssl_mode: "prefer",
      ssl_root_cert: null,
      ssh: null,
      environment: "local",
    };
    const res = await probeConnection(record, {}).catch((e) => ({ ok: false, message: String(e), elapsed_ms: 0 }));
    if (res.ok) {
      await saveConnection(record, {});
      await refreshConnections();
      openInWindow(record.id);
      return;
    }
    const x = await explainConnectError(res.message, { host: "localhost", port, username: user, sshHost: null }).catch(
      () => null,
    );
    openSheet(
      { fields: { host: "localhost", port: String(port), database: user, username: user } },
      { field: x?.field ?? "host", message: x?.cause ?? res.message },
    );
  };

  /** ⌘V outside a text field: a connection string fills the sheet; anything else does nothing. */
  const pasteConnection = async (text?: string, openAnyway = false) => {
    const t = text ?? (await readClipboardText().catch(() => ""));
    if (parsePostgresUrl(t)) openSheet({ url: t.trim() });
    else if (openAnyway) openSheet(null);
  };
  const editConnection = (id: string, mark?: { field: string; message: string }) => {
    setPopover(null);
    setEditingId(id);
    setMarkField(mark ?? null);
    setNewConnOpen(true);
  };

  /** Reconnects the windows on an edited connection so they pick up the change. */
  const onConnectionEdited = async (id: string) => {
    const before = connections.find((c) => c.id === id);
    const list = await refreshConnections();
    const after = list.find((c) => c.id === id);
    if (!after) return;
    // A window keeps its database only while it still points at the same server.
    const sameServer =
      before?.kind === "postgres" &&
      after.kind === "postgres" &&
      before.host === after.host &&
      before.port === after.port;
    for (const w of windowsRef.current) {
      if (w.connectionId !== id || w.state === "idle") continue;
      void connectWindow(w.id, id, sameServer ? w.database : null);
    }
  };

  /** Windows on a deleted connection go back to empty. */
  /**
   * A deleted connection: gone from the list and its windows emptied at
   * once (they keep their tabs), with Undo for 10 s. Its keychain entries
   * go when the toast does; the pending marker finishes that on the next
   * launch if the app quits first.
   */
  const onConnectionDeleted = async (id: string) => {
    const record = connections.find((c) => c.id === id);
    const emptied = windowsRef.current
      .filter((w) => w.connectionId === id)
      .map((w) => ({ id: w.id, database: w.database }));
    writeKey(PENDING_DELETE_KEY, [...pendingDeletes().filter((x) => x !== id), id]);
    const settle = () => writeKey(PENDING_DELETE_KEY, pendingDeletes().filter((x) => x !== id));
    if (record) {
      showUndoToast(`Removed ${record.name}`, undefined, {
        undo: () => {
          settle();
          void (async () => {
            // Empty secrets keep the keychain entries, which are still there.
            await saveConnection(record, {});
            await refreshConnections();
            for (const e of emptied) {
              const w = windowsRef.current.find((x) => x.id === e.id);
              if (w && !w.connectionId) {
                patchWindow(e.id, { connectionId: id, database: e.database, state: "idle" });
              }
            }
            showToast("Restored", record.name);
          })();
        },
        commit: () => {
          settle();
          void forgetConnectionSecrets(id).catch(() => {});
        },
      });
    }
    for (const w of windowsRef.current) {
      if (w.connectionId !== id) continue;
      void closeWindow(w.id);
      openSeq.current.delete(w.id);
      catalogUpdates.current.forget(w.id);
    }
    setWindows((prev) =>
      prev.map((w) => (w.connectionId === id ? blankWindow(w.id) : w)),
    );
    await refreshConnections();
  };

  const actions: WindowActions = {
    selectConnection: (id) => void connectWindow(activeWindow.id, id),
    reconnect: () => {
      if (activeWindow.connectionId)
        void connectWindow(
          activeWindow.id,
          activeWindow.connectionId,
          activeWindow.database,
        );
    },
    newConnection: () => openSheet(null),
    editConnection,
    openSqliteFile: () =>
      void chooseFile("sqlite").then((path) => {
        if (path) void openSqlitePath(path);
      }),
    openSqlitePath: (path) => void openSqlitePath(path, true),
    importInConnection,
    pasteConnection: (text, openAnyway) => void pasteConnection(text, openAnyway),
    openShortcuts: () => {
      setPopover(null);
      setShortcutsOpen(true);
    },
    openNotices: () => {
      setPopover(null);
      setShortcutsOpen(false);
      setNoticesOpen(true);
    },
    checkForUpdates: () => void lookForUpdate(true, runningQueries),
    openSettings: (section) => openSettings(section),
    connectFound: (server) => void connectFound(server),
    openSample: (reset) =>
      void (async () => {
        try {
          const record = await openSample(reset);
          await refreshConnections();
          const on = windowsRef.current.filter((w) => w.connectionId === record.id);
          if (reset) {
            // Each window on it reads the fresh copy.
            for (const w of on) void connectWindow(w.id, record.id, w.database);
            showToast("Sample database reset");
          } else if (on.length) {
            setActiveWindowId(on[0].id);
          } else if (!activeWindow.connectionId) {
            void connectWindow(activeWindow.id, record.id);
          } else {
            newWindow(record.id);
          }
        } catch (e) {
          showToast("Couldn't open the sample database", String(e), "error");
        }
      })(),
    retryConnect: () => {
      if (activeWindow.connectionId) void connectWindow(activeWindow.id, activeWindow.connectionId, activeWindow.database);
    },
    openConnectionSwitcher: () => setPopover("connection"),
    openDatabaseSwitcher: () => setPopover("database"),
    newWindow: () => newWindow(),
    closeWindow: () => closeWindowById(activeWindow.id),
    cycleWindow,
    setEnvironment: (env) => void setEnvironment(env),
    setSafeMode: (mode) => void setSafeMode(mode),
    setAllowMcp: (allow) => void setAllowMcp(allow),
    setMaskedColumns,
    openMcp: (tab) => openAgents(tab),
    reviewProposals: () => openAgents("page"),
    toggleSidebar,
    refreshSchema: (id, manual) => void refreshSchema(id, manual),
    reportIssue: (context) => {
      setPopover(null);
      setPaletteOpen(false);
      setReport(context);
    },
  };

  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sidebarHiddenRef = useRef(sidebarHidden);
  sidebarHiddenRef.current = sidebarHidden;

  // ⌘V outside a text field (no sheet open): a pasted connection string
  // opens the sheet filled. The keydown above covers a webview that fires
  // no paste event there.
  const pasteSeen = useRef(false);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      pasteSeen.current = true;
      if (newConnOpen || report || isTextField(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!parsePostgresUrl(text)) return;
      e.preventDefault();
      actionsRef.current.pasteConnection(text);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [newConnOpen, report]);

  // New connection sits in the inspector column, not over the window: Esc
  // closes it from anywhere that didn't take the key first (a menu, an editor).
  useEffect(() => {
    if (!newConnOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || connectOpen) return;
      if ((e.target as Element | null)?.closest?.('[data-testid="nc-sheet"]')) return;
      e.preventDefault();
      setNewConnOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConnOpen, connectOpen]);

  // ⌘W (Ctrl+W) with something open over the work (⌘K, a picker, a sheet,
  // New connection, the Agents page) closes that first, as Esc would; the
  // query tab or window waits for the next press.
  const overlayOpen =
    paletteOpen || popover !== null || newConnOpen || report !== null || shortcutsOpen || noticesOpen || agents !== null || settings !== null || connectOpen;
  useEffect(() => {
    if (!overlayOpen) return;
    const escape = () => {
      const at = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      at.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    };
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "close-tab") escape();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isMacPlatform() || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.code !== "KeyW") return;
      e.preventDefault();
      escape();
    };
    window.addEventListener("rowkery:command", onCommand);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("rowkery:command", onCommand);
      window.removeEventListener("keydown", onKey);
    };
  }, [overlayOpen]);

  // A .sqlite / .db dropped on the window (the sheet, when open, takes it).
  useEffect(() => {
    const onDrag = (e: Event) => {
      const { type, paths } = (e as CustomEvent<{ type: string; paths: string[] }>).detail;
      if (type !== "drop" || newConnOpen) return;
      const file = paths.find((p) => /\.(sqlite3?|db)$/i.test(p));
      if (file) void openSqlitePathRef.current(file);
    };
    window.addEventListener("rowkery:file-drag", onDrag);
    return () => window.removeEventListener("rowkery:file-drag", onDrag);
  }, [newConnOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The sheet owns the keyboard while it is open; a key something nearer
      // the focus took (⌘K's Ctrl+N, a keymap's swapped ⌘T) is not ours.
      if (newConnOpen || report || shortcutsOpen || noticesOpen || e.defaultPrevented) return;
      const mac = isMacPlatform();
      // ⌘B (Ctrl+B elsewhere): show or hide the sidebar, as most apps do. A
      // plain textarea gives ⌘B no meaning, so the editor doesn't keep it.
      // ⌃⌘S (Ctrl+Alt+S), Finder's chord and the first one here, still works.
      const chordB =
        e.code === "KeyB" && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
      const chordS =
        e.code === "KeyS" && (mac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey);
      if ((chordB || chordS) && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // ⌃⌘ chords are macOS's (⌃⌘F full screen, ⌃⌘D look up), never ours.
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // ? with focus in the grid or the schema panel's rows (never a text
      // field, so the filter box still types it): the shortcut sheet.
      if (
        e.key === "?" &&
        !mod &&
        !e.altKey &&
        !isTextField(e.target) &&
        e.target instanceof Element &&
        e.target.closest(".results-grid-wrap, .sidebar")
      ) {
        e.preventDefault();
        actionsRef.current.openShortcuts();
        return;
      }
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const toggle = (p: Popover) => {
        e.preventDefault();
        // With the panel hidden the switchers sit at the tab row's left
        // (the identity text), so the panel stays hidden.
        setPopover((cur) => (cur === p ? null : p));
      };
      if (!e.shiftKey && key === "k") {
        e.preventDefault();
        setPopover(null);
        startSpan("palette-open");
        setPaletteOpen((open) => !open);
      } else if (e.shiftKey && key === "a") {
        // ⇧⌘A (Ctrl+Shift+A): the Agents page, or back from it.
        e.preventDefault();
        if (agentsRef.current) setAgents(null);
        else actionsRef.current.reviewProposals();
      } else if (!e.shiftKey && e.code === "Comma") {
        // ⌘, (Ctrl+,): Settings, or back from it.
        e.preventDefault();
        if (settingsRef.current) setSettings(null);
        else actionsRef.current.openSettings();
      } else if (!e.shiftKey && key === "n") {
        e.preventDefault();
        actionsRef.current.newConnection();
      } else if (e.shiftKey && (e.code === "Slash" || e.key === "?")) {
        e.preventDefault();
        actionsRef.current.openShortcuts();
      } else if (!e.shiftKey && key === "o") {
        e.preventDefault();
        actionsRef.current.openSqliteFile();
      } else if (!e.shiftKey && key === "v" && !isTextField(e.target)) {
        // Paste-to-connect. The webview's paste event carries the text
        // (macOS sends Edit > Paste as one); without one, ask core.
        pasteSeen.current = false;
        window.setTimeout(() => {
          if (!pasteSeen.current) actionsRef.current.pasteConnection();
        }, 80);
      } else if (e.shiftKey && key === "o") {
        toggle("connection");
      } else if (e.shiftKey && key === "d") {
        toggle("database");
      } else if (!e.shiftKey && key === "t") {
        // A new empty window: Connect to start.
        e.preventDefault();
        newWindowRef.current();
      } else if (e.shiftKey && key === "w") {
        e.preventDefault();
        actionsRef.current.closeWindow();
      } else if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        const target = windowsRef.current[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setPopover(null);
          switchWindow(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConnOpen, report, shortcutsOpen, noticesOpen, toggleSidebar]);

  // The database picker only makes sense on a Postgres window.
  const canSwitchDb = activeConnection?.kind === "postgres";
  useEffect(() => {
    if (popover === "database" && !canSwitchDb) setPopover(null);
  }, [popover, canSwitchDb]);

  // The active window's connection and database: at the top of its schema
  // panel, and while the panel is hidden as the identity text at the tab
  // row's left. Only the one on screen opens its picker.
  // The schema head (2026-10-13): the title bar names the connection,
  // so the head names the database and its chevron opens the database
  // switcher; a SQLite file (one database) shows its file name. The
  // connection switcher stays mounted, chip hidden, for ⇧⌘O and the `…` menu.
  const renderSwitchers = (live: boolean, head = false) => (
    <>
      <ConnectionSwitcher
        connections={connections}
        activeId={activeWindow.connectionId}
        state={activeWindow.state}
        openIds={openIds}
        open={live && popover === "connection"}
        onOpenChange={(open) => setPopover(open ? "connection" : null)}
        onSelect={actions.selectConnection}
        onNewConnection={actions.newConnection}
        onEdit={editConnection}
      />
      {head && activeConnection?.kind === "sqlite" && (
        <span data-testid="sb-head-file" className="sb-head-file" data-db-file title={activeConnection.path}>
          {activeConnection.path.split(/[\\/]/).pop()}
        </span>
      )}
      {canSwitchDb && (
        <>
          {/* Named after its database (the default): the name once, and the chip is its ▾. */}
          {!head && activeConnection?.name !== activeWindow.database && <span className="sb-head-sep">/</span>}
          <DatabaseSwitcher
            windowId={activeWindow.id}
            // Before the first connect (or after a failed one) the head still
            // names the database the connection opens on.
            database={activeWindow.database ?? (head && activeConnection?.kind === "postgres" ? activeConnection.database : null)}
            nameless={!head && !!activeWindow.database && activeConnection?.name === activeWindow.database}
            connected={activeWindow.state === "connected"}
            open={live && popover === "database"}
            onOpenChange={(open) => setPopover(open ? "database" : null)}
            onPick={(db, inNewWindow) => {
              const connId = activeWindow.connectionId;
              if (!connId) return;
              if (inNewWindow) newWindow(connId, db);
              else void connectWindow(activeWindow.id, connId, db);
            }}
          />
        </>
      )}
    </>
  );
  // Windows out of sight with queries still running: their title-bar tab
  // spins (they keep going while hidden). A failed window's tab shows ⚠.
  const busyWindows = new Set(windows.filter((w) => w.id !== activeWindow.id && (runningByWindow[w.id] ?? 0) > 0).map((w) => w.id));
  // A window with no connection has no schema column (Paper, 2026-10-10):
  // its switcher moves to the tab row's left, where the chip itself is
  // hidden (styles/connect-to-start.css) and only ⇧⌘O's picker shows.
  const panelOff = !activeWindow.connectionId;
  // Where a page's way out returns: the shown window, by its connection's name.
  const backTo = activeConnection?.name ?? "New window";
  const switchers = panelOff ? null : renderSwitchers(!sidebarHidden, true);
  const identity = renderSwitchers(sidebarHidden || panelOff);

  return (
    <div
      ref={frameRef}
      data-testid="app-frame"
      className={`app-frame${macOverlay ? " app-frame-mac" : ""}${sidebarHidden ? " sidebar-hidden" : ""}`}
      data-sidebar-hidden={sidebarHidden ? "" : undefined}
      data-page={agents ? "agents" : settings ? "settings" : undefined}
      data-connect={newConnOpen ? "" : undefined}
      data-panel-width={panelWidth}
      style={{ ["--panel-width" as string]: `${panelWidth}px` }}
    >
      {!sidebarHidden && (
        <div
          className="panel-resizer"
          data-panel-resizer
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the schema panel"
          aria-valuemin={PANEL_MIN}
          aria-valuemax={PANEL_MAX}
          aria-valuenow={panelWidth}
          onPointerDown={startPanelResize}
          onDoubleClick={resetPanelWidth}
        />
      )}
      <TitleBar
        windows={windows}
        activeId={activeWindow.id}
        connections={connections}
        mcpRecent={mcpRecent}
        busy={busyWindows}
        onSelect={(id) => {
          setPopover(null);
          // Picking a window is leaving the page.
          setAgents(null);
          setSettings(null);
          switchWindow(id);
        }}
        onClose={closeWindowById}
        onReorder={(from, to) => setWindows((prev) => moveItem(prev, from, to))}
        onNewWindow={() => newWindow()}
        agentsOpen={agents !== null}
        onAgents={() => (agents ? setAgents(null) : openAgents("page"))}
        toolsRef={setTitlebarTools}
        onTilePick={(windowId, id) => {
          // The tab was selected on right-click; these act on that window.
          const w = windowsRef.current.find((x) => x.id === windowId);
          if (!w) return;
          if (id === "switch-database") return setPopover("database");
          if (id === "switch-connection") return setPopover("connection");
          if (id === "edit-connection") return w.connectionId && editConnection(w.connectionId);
          if (id === "reconnect") return w.connectionId && void connectWindow(w.id, w.connectionId, w.database);
          if (id === "new-window") return newWindow();
          if (id === "close-window") return closeWindowById(w.id);
        }}
      />
      {windows.map((w) => (
        <Workspace
          key={w.id}
          session={w}
          active={w.id === activeWindow.id}
          importFile={pendingImport?.windowId === w.id ? pendingImport.path : undefined}
          onImportFileTaken={() => setPendingImport((p) => (p?.windowId === w.id ? null : p))}
          connections={connections}
          windowCount={windows.length}
          connectionForm={newConnOpen}
          keysBlocked={
            newConnOpen || report !== null || popover !== null || shortcutsOpen || noticesOpen || agents !== null || settings !== null || connectOpen
          }
          commandsBlocked={newConnOpen || report !== null || popover !== null || shortcutsOpen || noticesOpen || connectOpen}
          paletteOpen={paletteOpen && w.id === activeWindow.id}
          onPaletteClose={() => setPaletteOpen(false)}
          sidebarHidden={sidebarHidden}
          switchers={w.id === activeWindow.id ? switchers : null}
          titlebarTools={w.id === activeWindow.id ? titlebarTools : null}
          agentsOpen={agents !== null}
          settingsOpen={settings !== null}
          onCloseSettings={() => setSettings(null)}
          proposalCount={proposals.length}
          onToggleAgents={() => (agents ? setAgents(null) : openAgents("page"))}
          identity={w.id === activeWindow.id ? identity : null}
          actions={actions}
          proof={w.id === "w1" ? proof : undefined}
          restoredTabs={restoredTabs.current.get(w.id)}
          runOnConnect={runOnConnect.current.has(w.id)}
          onRunningChange={onRunningChange}
          onTabsChange={onTabsChange}
        />
      ))}
      <ToastHost />
      <CmdHints />
      <Presence open={newConnOpen}>
        <NewConnectionSheet
          editing={connections.find((c) => c.id === editingId) ?? null}
          markField={markField}
          prefill={prefill}
          mcpStats={editingId ? mcpStats(mcpEntries, editingId) : null}
          onOpenMcp={(tab) => {
            // Connect opens over the sheet, so unsaved edits stay.
            if (tab === "connect") return setConnectOpen(true);
            setNewConnOpen(false);
            openAgents(tab);
          }}
          onClose={() => setNewConnOpen(false)}
          onDeleted={(id) => {
            setNewConnOpen(false);
            void onConnectionDeleted(id);
          }}
          onSaved={(id, name, firstShare) => {
            setNewConnOpen(false);
            // Just shared: Edit access opens and ticks its tables, as the
            // card's switch does.
            if (firstShare) openSharing({ edit: id, fill: true });
            // From the sample, a new connection gets its own window and the
            // sample stays where it is.
            const fromSample = !editingId && activeConnection?.kind === "sqlite" && !!activeConnection.sample;
            const sampleNo = windows.findIndex((w) => w.id === activeWindow.id) + 1;
            if (fromSample)
              showToast(`Connected to ${name}`, `${isMacPlatform() ? "⌘" : "Ctrl+"}${sampleNo} returns to the sample`);
            else showToast(editingId ? "Saved" : "Added", name);
            if (editingId) return void onConnectionEdited(id);
            // An empty window takes it; otherwise it gets its own window.
            void refreshConnections().then(() =>
              activeWindow.connectionId
                ? newWindow(id)
                : connectWindow(activeWindow.id, id),
            );
          }}
        />
      </Presence>
      <Presence open={shortcutsOpen}>
        {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} onNotices={() => actionsRef.current.openNotices()} />}
      </Presence>
      <Presence open={noticesOpen}>
        {noticesOpen && <NoticesSheet onClose={() => setNoticesOpen(false)} />}
      </Presence>
      <Presence open={agents !== null}>
        {agents !== null && (
          <AgentsInbox
            connections={connections}
            initial={agents.initial}
            focus={agents.proposal}
            backTo={backTo}
            onOpenSql={openMcpSql}
            onSharing={(connect) => openSharing({ connect })}
            onClose={closeAgents}
          />
        )}
      </Presence>
      <Presence open={settings !== null}>
        {settings !== null && (
          <SettingsPage
            section={settings}
            onSection={setSettings}
            onShortcuts={() => actionsRef.current.openShortcuts()}
            runningQueries={runningQueries}
            backTo={backTo}
            sharing={
              <AgentSharing
                connections={connections}
                connect={sharing.connect}
                onConnect={(connect) => setSharing((cur) => ({ ...cur, connect }))}
                editing={sharing.edit}
                fillEditing={sharing.fill}
                onEdit={(edit) => setSharing((cur) => ({ ...cur, edit, fill: false }))}
                onSetAllow={(id, allow, until) => void setAllowMcp(allow, id, until ?? null)}
                onStopAll={() => void stopAllMcp()}
                onSetAccess={setMcpAccess}
                onSetMasked={setMaskedColumns}
              />
            }
            onClose={() => setSettings(null)}
          />
        )}
      </Presence>
      <Presence open={connectOpen}>
        {connectOpen && (
          <McpConnectSheet
            sharedCount={connections.filter((c) => mcpShared(c)).length}
            onOpenAccess={() => {
              setConnectOpen(false);
              setNewConnOpen(false);
              openAgents("access");
            }}
            onClose={() => setConnectOpen(false)}
          />
        )}
      </Presence>
      <Presence open={report !== null}>
        {report && <ReportSheet context={report} onClose={() => setReport(null)} />}
      </Presence>
    </div>
  );
}

export default App;
