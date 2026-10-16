/**
 * Where the penguin may show, as pure rules (test/penguin.test.ts walks them).
 * Pose equals state, one to one: Ready = no connection, Tilted = the
 * connection failed. No other state has a pose, so in any other state the
 * penguin is absent; and never while a query runs or beside data.
 */
export type PenguinPose = "ready" | "tilted";

export type WindowConnState = "idle" | "connecting" | "connected" | "error";

export interface PenguinContext {
  /** The window's connection, or null when none is picked. */
  connectionId: string | null;
  state: WindowConnState;
  /** A query runs in this window. */
  running: boolean;
  /** The surface lists tables or shows rows. */
  hasData: boolean;
}

/**
 * Connect to start's penguin: Ready while the window has no connection, and
 * through the connect started from it (`heldFromEmpty`), so the empty state
 * leaves in one fade as the first schema lands, or as the failure shows.
 */
export function emptyWindowPose(c: PenguinContext & { heldFromEmpty: boolean }): PenguinPose | null {
  if (c.running || c.hasData) return null;
  if (!c.connectionId) return "ready";
  return c.heldFromEmpty && (c.state === "idle" || c.state === "connecting") ? "ready" : null;
}

/**
 * The schema panel's Couldn't connect penguin: Tilted while the connection is
 * failed, and through a Retry of that same connection (the penguin and text
 * stay until the result).
 */
export function failedPanelPose(c: PenguinContext & { retrying: boolean }): PenguinPose | null {
  if (c.running || c.hasData || !c.connectionId) return null;
  if (c.state === "error") return "tilted";
  return c.state === "connecting" && c.retrying ? "tilted" : null;
}
