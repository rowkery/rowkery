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
  /** Unix ms: a commit of it was started and Rowkery closed before it finished, so it may already be saved. */
  commit_started_ms?: number;
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
  /** Triggers on the table: they ran too; their writes count in `reach`. */
  triggers: string[];
  /** Every row the statement wrote, per table, cascades and triggers included. Null when the server keeps no counts. */
  reach: Reach | null;
  /** `[schema, table]` its own rows count under in `reach` (a partition's parent). */
  table: [string, string] | null;
}

/** Rows written in one table (Rust `rowkery_core::reach`). */
export interface TableRows {
  schema: string;
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface Reach {
  tables: TableRows[];
  /** Rows in tables Rowkery can't name (SQLite WITHOUT ROWID). */
  unnamed: number;
}

export interface DryRun {
  proposal: Proposal;
  connection_name: string;
  statements: StatementPreview[];
  /** What deferred triggers wrote when the dry run fired them, as COMMIT would. */
  at_commit: Reach | null;
  /** `[schema, table]` of each table written that isn't shared with agents. */
  unshared: [string, string][];
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

/** Commits only if every count the dry run showed, in every table, holds. */
export const commitProposal = (id: string, dry: DryRun) =>
  invoke<CommitOutcome>("proposal_commit", {
    id,
    seen: { rows: dry.statements.map((s) => s.rows), reach: dry.statements.map((s) => s.reach), at_commit: dry.at_commit },
  });

export const rejectProposal = (id: string, note?: string) =>
  invoke<void>("proposal_reject", { id, note: note?.trim() || null });

const reachTotal = (r: Reach) => r.tables.reduce((n, t) => n + t.inserted + t.updated + t.deleted, 0) + r.unnamed;

/** Rows a statement changes in other tables than its own (cascades, triggers). */
export function otherRows(s: StatementPreview): number {
  if (!s.reach) return 0;
  const own = s.table && s.reach.tables.find((t) => t.schema === s.table![0] && t.table === s.table![1]);
  if (!own) return Math.max(0, reachTotal(s.reach) - s.rows);
  return reachTotal(s.reach) - (own.inserted + own.updated + own.deleted);
}

/** Every row the change writes: each statement's, in every table, and its deferred triggers'. */
export function dryRunTotal(dry: DryRun): number {
  return dry.statements.reduce((n, s) => n + s.rows + otherRows(s), 0) + (dry.at_commit ? reachTotal(dry.at_commit) : 0);
}

/** One line per table across the whole change, summed, plus rows no table could be named for. */
export function reachByTable(dry: DryRun): { tables: (TableRows & { shared: boolean })[]; unnamed: number } {
  const by = new Map<string, TableRows & { shared: boolean }>();
  let unnamed = 0;
  for (const r of [...dry.statements.map((s) => s.reach), dry.at_commit]) {
    if (!r) continue;
    unnamed += r.unnamed;
    for (const t of r.tables) {
      const k = `${t.schema}\u0000${t.table}`;
      const row = by.get(k) ?? {
        schema: t.schema,
        table: t.table,
        inserted: 0,
        updated: 0,
        deleted: 0,
        shared: !dry.unshared.some(([s, n]) => s === t.schema && n === t.table),
      };
      row.inserted += t.inserted;
      row.updated += t.updated;
      row.deleted += t.deleted;
      by.set(k, row);
    }
  }
  return { tables: [...by.values()], unnamed };
}

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
