import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * What the MCP server (`Rowkery --mcp`, a separate process) logged to
 * `mcp-log.jsonl`, read back from Rust in pieces: the first read takes the
 * log's tail, later ones only what was appended since (a byte offset). Kept
 * outside React; ⌘K MCP activity, the window pills' MCP tag, the connection sheet's
 * counts and the refusal toast read it.
 */
export interface McpEntry {
  /** Unix ms. */
  ts: number;
  tool: string;
  /** The server process's start: one value per agent session. */
  session?: number;
  /** The client's own name from its handshake (`claude-code`). */
  client?: string;
  connection?: string;
  database?: string;
  /** describe_table's table, search_schema's text. */
  target?: string;
  sql?: string;
  rows?: number;
  /** The query's own run. */
  ms?: number;
  /** The whole call, from the request arriving to the answer being ready (older lines lack it). */
  took_ms?: number;
  verdict?: string;
  /** The arguments exactly as the agent sent them (a cut string past 4 KB). */
  args?: Record<string, unknown> | string;
  /** What was shared when it ran. */
  scope?: McpScope;
  /** Size of the response text. */
  bytes?: number;
}

/** rowkery-mcp `access::Tables::scope`. */
export interface McpScope {
  /** Databases shared then, or every one on the server. */
  databases: number | "all";
  mode: "picked" | "all";
  /** Tables ticked (`picked`) or hidden (`all`). */
  tables: number;
  timeout_s: number;
  max_rows?: number;
}

export type McpVerdict = "ok" | "refused" | "flagged" | "error";

/** `ok`; `would refuse` (explain only); `Refused: …` (a guard); anything else failed. */
export function verdictOf(e: McpEntry): McpVerdict {
  const v = e.verdict;
  if (!v || v === "ok") return "ok";
  if (v === "would refuse") return "flagged";
  if (v.startsWith("Refused")) return "refused";
  return "error";
}

/** How long the whole call took, as its detail prints it: `182 ms`, `1.4 s`; null on older lines. */
export function tookLabel(e: McpEntry): string | null {
  const ms = e.took_ms;
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

interface Activity {
  entries: McpEntry[];
  offset: number;
  reset: boolean;
}

/** The most entries kept in memory (the log itself keeps more). */
const KEEP = 1000;
/** A window pill's MCP tag stays this long after a read. */
export const RECENT_MS = 60_000;

let entries: McpEntry[] = [];
let offset: number | null = null;
let loaded = false;
let inflight: Promise<McpEntry[]> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Reads what was appended since the last read. Returns the entries that are
 * new since then; the first read (and one after the log was cleared) returns
 * none, so a toast never repeats old history.
 */
export function pollMcp(): Promise<McpEntry[]> {
  inflight ??= (async () => {
    try {
      const a = await invoke<Activity | null>("mcp_activity", { since: offset });
      if (!a) return [];
      const first = !loaded;
      loaded = true;
      offset = a.offset;
      if (a.reset) {
        const changed = entries.length > 0 || a.entries.length > 0;
        entries = a.entries.slice(-KEEP);
        if (changed) emit();
        return first ? [] : a.entries;
      }
      if (!a.entries.length) return [];
      entries = [...entries, ...a.entries].slice(-KEEP);
      emit();
      return a.entries;
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The start of what one call sent back (Rust `rowkery_mcp::samples`). */
export interface McpSample {
  /** The first 512 bytes of the response text. */
  text: string;
  /** The response's full size. */
  bytes: number;
}

const samples = new Map<string, Promise<McpSample | null>>();

/** The response kept for a call, if any (none past 24 h, or when turned off). */
export function mcpSample(e: McpEntry): Promise<McpSample | null> {
  if (e.session === undefined || verdictOf(e) === "refused" || verdictOf(e) === "error") return Promise.resolve(null);
  const key = `${e.session}-${e.ts}`;
  let found = samples.get(key);
  if (!found) {
    found = invoke<McpSample | null>("mcp_sample", { session: e.session, ts: e.ts }).catch(() => null);
    samples.set(key, found);
  }
  return found;
}

export async function clearMcp(): Promise<void> {
  await invoke("mcp_clear_activity");
  samples.clear();
  entries = [];
  offset = 0;
  emit();
}

const snapshot = () => entries;

/** The entries, oldest first; re-renders when a read brings new ones. */
export function useMcpEntries(): McpEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export interface McpStats {
  /** Calls since local midnight. */
  today: number;
  /** Of those, refused by a guard. */
  refused: number;
  last: number | null;
}

export function mcpStats(list: McpEntry[], connectionId: string, now = Date.now()): McpStats {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  let today = 0;
  let refused = 0;
  let last: number | null = null;
  for (const e of list) {
    if (e.connection !== connectionId) continue;
    if (last === null || e.ts > last) last = e.ts;
    if (e.ts < midnight) continue;
    today++;
    if (verdictOf(e) === "refused") refused++;
  }
  return { today, refused, last };
}

/** Connections an agent called in the last `RECENT_MS`. */
export function recentConnections(list: McpEntry[], now = Date.now()): Set<string> {
  const out = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (now - e.ts > RECENT_MS) break;
    if (e.connection) out.add(e.connection);
  }
  return out;
}

/**
 * Whether the newest entry is still inside `RECENT_MS`, so a pill's MCP tag
 * can still change on its own. Once it isn't, the tag's timer stops until a
 * new entry arrives.
 */
export function mcpTagLive(list: McpEntry[], now = Date.now()): boolean {
  const last = list[list.length - 1];
  return last !== undefined && now - last.ts <= RECENT_MS;
}

/** "12 s ago", "4 min ago", "13:04", "8 Oct". */
export function sinceLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const d = new Date(at);
  if (new Date(now).toDateString() === d.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** "96 B", "1.1 KB", "3.4 MB". */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "Claude Code" from `claude-code`; "Agent" when the client gave no name. */
export function clientLabel(name: string | undefined): string {
  if (!name) return "Agent";
  if (/^claude[-_ ]?code$/i.test(name)) return "Claude Code";
  if (/^claude[-_ ]?ai$/i.test(name)) return "Claude";
  return name.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Test hook: forget what was read. */
export function resetMcpForTests() {
  samples.clear();
  entries = [];
  offset = null;
  loaded = false;
  emit();
}

/** Shared with agents right now: Allow MCP on, and any time limit not passed. */
export function mcpShared(
  c: { allow_mcp?: boolean; mcp_until?: number | null },
  now = Date.now(),
): boolean {
  return !!c.allow_mcp && (c.mcp_until == null || now < c.mcp_until);
}

/** Ends of a time-limited share: an hour from now, or tonight at midnight. */
export function shareUntil(choice: "hour" | "today", now = Date.now()): number {
  if (choice === "hour") return now + 60 * 60_000;
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Which duration set `until`: Today ends where `shareUntil` puts the next midnight (even across a DST jump). */
export function shareDuration(until: number | null | undefined): "off" | "hour" | "today" {
  if (until == null) return "off";
  return until === shareUntil("today", until - 1) ? "today" : "hour";
}

/** The host as the agent sees it (rowkery-mcp `guard::mask_host`). */
export function maskHost(raw: string): string {
  const host = raw.trim();
  if (["localhost", "127.0.0.1", "::1", ""].includes(host)) return host;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.*.*`;
  if (host.includes(":")) return "***";
  const dot = host.indexOf(".");
  const first = dot < 0 ? host : host.slice(0, dot);
  const head = [...first].slice(0, 3).join("");
  return dot < 0 ? `${head}***` : `${head}***${host.slice(dot)}`;
}

/** The server's limits (rowkery-mcp `guard.rs`), as the Access tab states them. */
export const MCP_LIMITS = {
  defaultRows: 200,
  maxRows: 1000,
  cellChars: 200,
  responseBytes: 512,
  timeoutSeconds: 10,
  bigTableRows: 100_000,
};
