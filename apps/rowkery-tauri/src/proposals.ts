import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Changes agents proposed with `propose_change` (Rust `rowkery_mcp::proposals`)
 * that nobody has decided on yet, read back while a connection is shared.
 * Kept outside React: the Agents button's count, the arrival toast, ⌘K and
 * the review page read it.
 */
export interface Proposal {
  id: string;
  /** Unix ms. */
  ts: number;
  /** The connection's id. */
  connection: string;
  database: string;
  sql: string;
  /** The agent's own words. */
  reason: string;
  expect_rows?: number;
  /** The MCP client's name (`claude-ai`, `claude-code`). */
  client?: string;
}

/** One statement's dry run: the rows it changed, before and after. */
export interface StatementPreview {
  verb: "INSERT" | "UPDATE" | "DELETE";
  /** The table as written. */
  target: string;
  sql: string;
  /** DELETE / UPDATE with no WHERE. */
  destructive: boolean;
  rows: number;
  columns: string[];
  key: string[];
  /** Columns whose value differs in at least one shown row. */
  changed: string[];
  /** Up to 200 rows. */
  shown: { before: unknown[] | null; after: unknown[] | null }[];
  /** Triggers on the table: they ran too, their own writes aren't shown. */
  triggers: string[];
}

export interface DryRun {
  proposal: Proposal;
  connection_name: string;
  statements: StatementPreview[];
}

/** A user trigger one statement fires, and on which event. */
export interface PlannedTrigger {
  name: string;
  event: "INSERT" | "UPDATE" | "DELETE";
}

/**
 * One statement as the review shows it when it opens, before anything runs.
 * `verb` and `target` are null when the lexer couldn't read the statement:
 * `sql` is then the whole proposal and no triggers are listed.
 */
export interface PlannedStatement {
  verb: "INSERT" | "UPDATE" | "DELETE" | null;
  target: string | null;
  sql: string;
  destructive: boolean;
  triggers: PlannedTrigger[];
}

export interface Plan {
  connection_name: string;
  statements: PlannedStatement[];
}

export type CommitOutcome =
  | { outcome: "committed"; rows: number[] }
  | { outcome: "moved"; dry_run: DryRun }
  | { outcome: "failed"; error: string };

let waiting: Proposal[] = [];
let seen: Set<string> | null = null;
let inflight: Promise<Proposal[]> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Reads the queue. Returns the proposals that arrived since the last read;
 * the first read returns none, so opening the app never toasts old ones
 * (the Agents button's count shows them).
 */
export function pollProposals(): Promise<Proposal[]> {
  inflight ??= (async () => {
    try {
      const list = await invoke<Proposal[] | null>("proposals_waiting");
      if (!list) return [];
      const fresh = seen ? list.filter((p) => !seen!.has(p.id)) : [];
      seen = new Set(list.map((p) => p.id));
      const changed = list.length !== waiting.length || list.some((p, i) => p.id !== waiting[i]?.id);
      waiting = list;
      if (changed) emit();
      return fresh;
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Drops a decided proposal at once, before the next read. */
export function forgetProposal(id: string) {
  if (!waiting.some((p) => p.id === id)) return;
  waiting = waiting.filter((p) => p.id !== id);
  emit();
}

const snapshot = () => waiting;

/** How many wait, for ⌘K. */
export const waitingCount = () => waiting.length;

/** Waiting proposals, oldest first. */
export function useProposals(): Proposal[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Each statement and the triggers it would fire; executes nothing. */
export const planProposal = (id: string) => invoke<Plan>("proposal_plan", { id });

export const dryRunProposal = (id: string) => invoke<DryRun>("proposal_dry_run", { id });

export const commitProposal = (id: string, rows: number[]) =>
  invoke<CommitOutcome>("proposal_commit", { id, rows });

export const rejectProposal = (id: string, note?: string) =>
  invoke<void>("proposal_reject", { id, note: note?.trim() || null });

/** `orders` from `public.orders`, quotes dropped: what a toast names. */
export function tableLabel(target: string): string {
  const last = target.split(".").pop() ?? target;
  return last.replace(/^["`]|["`]$/g, "");
}

/** The first table a proposal's SQL names, for the arrival toast. */
export function proposalTable(sql: string): string | null {
  const m = /^\s*(?:insert\s+into|update(?:\s+only)?|delete\s+from(?:\s+only)?)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(sql);
  return m ? tableLabel(m[1]) : null;
}

/** Test hook: forget what was read. */
export function resetProposalsForTests() {
  waiting = [];
  seen = null;
  emit();
}
