import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { probeLocalServers, type LocalServer } from "./api";
import { pickerGroup, pinnedFirst, useConnectionPins } from "./connectionPins";
import { PenguinMark } from "./PenguinMark";
import { EngineTile } from "./engines";
import { EnvTag } from "./EnvTag";
import { PinIcon } from "./icons";
import { isMacPlatform } from "./platform";
import { useGlideHover } from "./motion";
import type { ConnectionRecord } from "./types";
import { connectionLine, usePresenting } from "./presenting";
import { commandKeys, commandTip, keysFor } from "./commands";
import { failedPanelPose, type PenguinPose } from "./penguinPlacement";
import { Keys } from "./Keys";

/** Saved connections listed before "Show all…" takes over. */
const SAVED_MAX = 8;

interface EmptyWindowProps {
  /** A connection was picked here: the screen stays, inert, until its result. */
  connecting?: boolean;
  /** The shown window, and no sheet or popover owns the keyboard. */
  keysLive: boolean;
  onNewConnection: () => void;
  onOpenFile: () => void;
  /** The row's click (or ↵): the clipboard's connection string, else an empty sheet. */
  onPaste: () => void;
  onOpenSample: () => void;
  onConnectFound: (server: LocalServer) => void;
  /** Saved connections, listed under "Your connections" (pinned first). */
  connections: ConnectionRecord[];
  /** A saved connection's row: connect this window to it. */
  onPickConnection: (id: string) => void;
  /** "Show all…": the connection picker (⇧⌘O). */
  onShowAll: () => void;
}

type Row =
  | { kind: "action"; id: string; label: string; sub: string; key: string; run: () => void }
  | { kind: "saved"; conn: ConnectionRecord; group: "pinned" | "sample" | "rest" }
  | { kind: "all"; hidden: number }
  | { kind: "found"; server: LocalServer };

const isTextField = (el: Element | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

/**
 * "Connect to start": a window with no connection. The penguin, the four ways
 * in with their keys (↵ alone opens the sample, as printed), the saved
 * connections (pinned first, at most eight, then "Show all…"), and on macOS
 * the Postgres servers answering on loopback. Nothing connects on its own.
 */
export function EmptyWindow({
  connecting = false,
  keysLive,
  onNewConnection,
  onOpenFile,
  onPaste,
  onOpenSample,
  onConnectFound,
  connections,
  onPickConnection,
  onShowAll,
}: EmptyWindowProps) {
  const mac = isMacPlatform();
  const presenting = usePresenting();
  const mod = mac ? "⌘" : "Ctrl+";
  const [found, setFound] = useState<LocalServer[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  // The keyboard's cursor paints its own fill; the pointer's is the glide
  // (one highlight that moves between the rows, as in the schema column).
  const [keyed, setKeyed] = useState(false);
  const pointAt = (i: number) => {
    setCursor(i);
    setKeyed(false);
  };
  const listsRef = useRef<HTMLDivElement>(null);
  useGlideHover(listsRef, ".ew-row");
  const [dragging, setDragging] = useState(false);
  // Read once per mount, as the pickers do.
  const { pins } = useConnectionPins();
  const saved = useMemo(() => pinnedFirst(connections, pins), [connections, pins]);

  // Once per mount; macOS only until the other platforms are reviewed.
  useEffect(() => {
    if (!mac) return;
    let live = true;
    void probeLocalServers()
      .then((servers) => live && setFound(Array.isArray(servers) ? servers : []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mac]);

  // A .sqlite / .db dragged over the window (App opens it on drop).
  useEffect(() => {
    const onDrag = (e: Event) => {
      const { type } = (e as CustomEvent<{ type: string }>).detail;
      setDragging(type === "enter" || type === "over");
    };
    window.addEventListener("rowkery:file-drag", onDrag);
    return () => window.removeEventListener("rowkery:file-drag", onDrag);
  }, []);

  const more = saved.length > SAVED_MAX;
  const rows: Row[] = [
    { kind: "action", id: "new", label: "New connection", sub: "Postgres or SQLite", key: keysFor("new-connection", mac), run: onNewConnection },
    { kind: "action", id: "file", label: "Open a SQLite file…", sub: "or drop one anywhere", key: keysFor("open-sqlite-file", mac), run: onOpenFile },
    { kind: "action", id: "paste", label: "Paste a postgres:// URL", sub: "fills the form for you", key: `${mod}V`, run: onPaste },
    // sample.sql: six CREATE TABLEs and one CREATE VIEW.
    { kind: "action", id: "sample", label: "Open the sample database", sub: "six tables, one view", key: "↵", run: onOpenSample },
    ...saved
      .slice(0, SAVED_MAX)
      .map((conn): Row => ({ kind: "saved", conn, group: pickerGroup(conn, pins) })),
    ...(more ? [{ kind: "all", hidden: saved.length - SAVED_MAX } as Row] : []),
    ...found.map((server): Row => ({ kind: "found", server })),
  ];
  /** Where Your connections ends and Found on this Mac starts. */
  const savedEnd = 4 + Math.min(saved.length, SAVED_MAX) + (more ? 1 : 0);
  const runRow = (row: Row) => {
    if (row.kind === "action") row.run();
    else if (row.kind === "saved") onPickConnection(row.conn.id);
    else if (row.kind === "all") onShowAll();
    else onConnectFound(row.server);
  };

  // A connection deleted elsewhere can shrink the rows under the cursor.
  useEffect(() => {
    setCursor((c) => (c !== null && c >= rows.length ? null : c));
  }, [rows.length]);

  // ↓ ↑ move a cursor over the rows, ↵ runs it (or, with none, opens the
  // sample), Esc clears it. Re-bound each render, so it sees these rows.
  useEffect(() => {
    if (!keysLive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextField(document.activeElement)) return;
      const n = rows.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setKeyed(true);
        setCursor((c) => (c === null ? (step > 0 ? 0 : n - 1) : (c + step + n) % n));
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const row = cursor === null ? rows[3] : rows[cursor];
        if (row) runRow(row);
      } else if (e.key === "Escape") {
        setCursor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const renderRow = (row: Row, i: number) => {
    const on = i === cursor;
    const lit = on && keyed;
    if (row.kind === "action") {
      // Paper (2026-10-10): the four ways in are bordered cards, two by two,
      // the key at the right of the sub-line.
      return (
        <li key={row.id}>
          <button
            type="button"
            data-testid="ew-row"
            className={`ew-card${lit ? " cursor" : ""}`}
            data-cursor={on ? "" : undefined}
            data-empty-action={row.id}
            onMouseMove={() => pointAt(i)}
            onClick={() => runRow(row)}
          >
            <span className="ew-label">{row.label}</span>
            <span className="ew-card-sub">
              <span data-testid="ew-card-sub">{row.sub}</span>
              <kbd className="ew-key"><Keys text={row.key} /></kbd>
            </span>
          </button>
        </li>
      );
    }
    if (row.kind === "saved") {
      const { conn, group } = row;
      return (
        <li key={`saved-${conn.id}`}>
          <button
            type="button"
            data-testid="ew-row"
            className={`ew-row ew-saved${lit ? " cursor" : ""}`}
            data-cursor={on ? "" : undefined}
            data-saved-conn={conn.id}
            data-group={group}
            title={
              group === "sample"
                ? `A bundled SQLite file, copied to this ${mac ? "Mac" : "computer"}. Delete it when you are done.`
                : undefined
            }
            onMouseMove={() => pointAt(i)}
            onClick={() => runRow(row)}
          >
            <EngineTile kind={conn.kind} />
            <span className="ew-saved-text">
              <span className="ew-saved-title">
                <span data-testid="ew-saved-name" className="ew-saved-name">{conn.name}</span>
                <EnvTag env={conn.environment} />
                {group === "pinned" && (
                  <span className="ew-pinned" aria-label="Pinned">
                    <PinIcon size={10} filled />
                  </span>
                )}
              </span>
              <span data-testid="ew-saved-sub" className="ew-saved-sub">{connectionLine(conn, presenting)}</span>
            </span>
            <kbd className="ew-key ew-go">Connect ↵</kbd>
          </button>
        </li>
      );
    }
    if (row.kind === "all") {
      return (
        <li key="show-all">
          <button
            type="button"
            data-testid="ew-row"
            className={`ew-row ew-all${lit ? " cursor" : ""}`}
            data-cursor={on ? "" : undefined}
            data-saved-all={row.hidden}
            onMouseMove={() => pointAt(i)}
            onClick={() => runRow(row)}
          >
            <span className="ew-label">Show all…</span>
            <kbd className="ew-key"><Keys text={keysFor("switch-connection", mac)} /></kbd>
          </button>
        </li>
      );
    }
    const { port, user } = row.server;
    return (
      <li key={`found-${port}`}>
        <button
          type="button"
          data-testid="ew-row"
          className={`ew-row ew-found${lit ? " cursor" : ""}`}
          data-cursor={on ? "" : undefined}
          data-found={port}
          onMouseMove={() => pointAt(i)}
          onClick={() => runRow(row)}
        >
          <span className="conn-dot connected" />
          <span className="ew-label">
            Postgres · <span className="ew-mono">localhost:{port}</span> · {user}
          </span>
          <kbd className="ew-key ew-go">Connect ↵</kbd>
        </button>
      </li>
    );
  };

  return (
    <div
      className="empty-window"
      data-empty-window
      data-connecting={connecting || undefined}
      data-dragging={dragging ? "" : undefined}
      inert={connecting}
    >
      <div className="ew-block">
        <StartHead
          penguin={<PenguinMark pose="ready" size={64} className="ew-penguin" />}
          title={dragging ? "Drop to open" : "Connect to start"}
          sub="Nothing connects until you choose."
        />
        <ul className="ew-cards">{rows.slice(0, 4).map(renderRow)}</ul>
        {(saved.length > 0 || found.length > 0) && (
          <div className="ew-lists" ref={listsRef}>
            {saved.length > 0 && (
              <section className="ew-saved-section" data-saved-section={saved.length}>
                <h3 data-testid="ew-section" className="ew-section">Your connections</h3>
                <ul className="ew-list">{rows.slice(4, savedEnd).map((r, i) => renderRow(r, i + 4))}</ul>
              </section>
            )}
            {found.length > 0 && (
              <section className="ew-found-section" data-found-section title="Loopback only: Postgres answering on this Mac's own ports.">
                <h3 data-testid="ew-section" className="ew-section">Found on this Mac</h3>
                <ul className="ew-list">{rows.slice(savedEnd).map((r, i) => renderRow(r, i + savedEnd))}</ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The penguin beside the heading and its one quiet line. */
function StartHead({ penguin, title, sub }: { penguin: ReactNode; title: string; sub: ReactNode }) {
  return (
    <div className="ew-head">
      {penguin}
      <div className="ew-head-text">
        <h2 data-testid="ew-title" className="ew-title">{title}</h2>
        <p data-testid="ew-sub" className="ew-sub">{sub}</p>
      </div>
    </div>
  );
}

/** The last failure of a window's connection, held through a Retry. */
export interface ConnectFailure {
  id: string | null;
  error: string;
  cause: string | null;
}

/**
 * Couldn't connect's state: the last failure of this connection. A Retry
 * keeps the penguin, cause and raw text in place until its result (success
 * clears it, failure updates it). Null when there is nothing to show.
 */
export function useConnectFailure(c: {
  connectionId: string | null;
  error: string | null;
  cause: string | null;
  connecting: boolean;
  running: boolean;
  hasData: boolean;
}): { failed: ConnectFailure; retrying: boolean; pose: PenguinPose | null } | null {
  const failure = useRef<ConnectFailure | null>(null);
  if (c.error && !c.connecting) failure.current = { id: c.connectionId, error: c.error, cause: c.cause };
  else if (!c.connecting || failure.current?.id !== c.connectionId) failure.current = null;
  const failed = c.hasData ? null : failure.current;
  if (!failed) return null;
  const retrying = c.connecting;
  const pose = failedPanelPose({
    connectionId: c.connectionId,
    state: c.connecting ? "connecting" : c.error ? "error" : "connected",
    running: c.running,
    hasData: c.hasData,
    retrying,
  });
  return { failed, retrying, pose };
}

/**
 * Couldn't connect: the same column as Connect to start, the penguin Tilted,
 * the cause as its line, the raw error in mono, then Retry · Edit… with
 * their keys and Report…. Replaces the editor and results until the
 * connection comes back (Paper, 2026-10-10; it used to sit in the schema
 * column).
 */
export function ConnectFailed({
  failure,
  onRetry,
  onEdit,
  onReport,
}: {
  failure: { failed: ConnectFailure; retrying: boolean; pose: PenguinPose | null };
  onRetry?: () => void;
  onEdit?: () => void;
  onReport?: () => void;
}) {
  const { failed, retrying, pose: failedPose } = failure;
  return (
    <div className="empty-window ew-failed" data-connect-error data-retrying={retrying || undefined}>
      <div className="ew-block">
        <div className="ew-head">
          {failedPose && <PenguinMark pose={failedPose} size={64} className="ew-penguin-tilted" />}
          <div className="ew-head-text">
            <h2 data-testid="sb-error-title" className="ew-title">Couldn't connect</h2>
            {failed.cause && (
              <p className="ew-sub" data-cause>
                {failed.cause}
              </p>
            )}
          </div>
        </div>
        <pre data-testid="sb-error-text" className="ew-error-text">{failed.error}</pre>
        <div className="ew-error-actions">
          {(onRetry || retrying) && (
            <button
              type="button"
              data-testid="sb-error-btn"
              className="ew-btn"
              data-action="retry"
              title={commandTip("retry-connect", "Connect again")}
              disabled={retrying}
              onClick={onRetry}
            >
              Retry <kbd><Keys text={commandKeys("retry-connect")} /></kbd>
            </button>
          )}
          {(onEdit || retrying) && (
            <button
              type="button"
              data-testid="sb-error-btn"
              className="ew-btn"
              data-action="edit"
              title={commandTip("edit-failed-connection", "Open this connection's settings")}
              disabled={retrying}
              onClick={onEdit}
            >
              Edit… <kbd><Keys text={commandKeys("edit-failed-connection")} /></kbd>
            </button>
          )}
          {onReport && (
            <button type="button" data-testid="sb-report" className="ew-btn ew-btn-quiet" title="Send the error with your note" onClick={onReport}>
              Report…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
