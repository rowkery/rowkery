import { useState } from "react";
import { readKey, writeKey } from "./persist";
import type { ConnectionRecord } from "./types";

const KEY = "rowkery.pinnedConnections";

function load(): string[] {
  const ids = readKey(KEY);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Connections pinned to the top of the pickers, saved with the UI state.
 * Only one picker is open at a time, so each reads the list when it mounts.
 */
export function useConnectionPins() {
  const [pins, setPins] = useState<string[]>(load);
  const toggle = (id: string) => {
    const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    setPins(next);
    writeKey(KEY, next);
    return next;
  };
  return { pins, toggle };
}

/** Pinned first, then the sample, then the rest; each group keeps the saved order. */
export function pinnedFirst(
  connections: ConnectionRecord[],
  pins: string[],
): ConnectionRecord[] {
  const group = (c: ConnectionRecord) => pickerGroup(c, pins);
  const rank = { pinned: 0, sample: 1, rest: 2 } as const;
  if (connections.every((c) => group(c) === "rest")) return connections;
  return [...connections].sort((a, b) => rank[group(a)] - rank[group(b)]);
}

/** Pinned rows on top, then the sample database under its own heading, then the rest. */
export function pickerGroup(c: ConnectionRecord, pins: string[]): "pinned" | "sample" | "rest" {
  if (pins.includes(c.id)) return "pinned";
  return c.kind === "sqlite" && c.sample ? "sample" : "rest";
}
