import { keysFor } from "./commands";
import { isMacPlatform } from "./platform";
import type { LedgerLine, QueryTiming } from "./timings";

/**
 * What the ⌘K Timings sheet shows: the marks `timings.ts` recorded, as rows
 * of label · measured · budget. Budgets are scripts/budgets.json's warm
 * budgets (a vitest keeps them equal), so the sheet, latency-proof.sh and
 * the browser proof judge the same numbers. Pure, so it is tested without a
 * webview.
 */

/** scripts/budgets.json `warm_ms`, by metric. */
export const BUDGETS = {
  window_painted: 400,
  socket_warm_vs_webview_ready: 0,
  first_frame: 50,
  first_frame_painted: 66,
  palette_open: 16,
  window_switch: 16,
} as const;

export interface TimingRow {
  label: string;
  /** ms; null when that stage has not happened yet (shown as —). */
  ms: number | null;
  budget?: number;
  /** Plain text after the number (`1,000 rows`). */
  note?: string;
}

export interface TimingSection {
  title: string;
  rows: TimingRow[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function last(lines: readonly LedgerLine[], mark: string): LedgerLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].mark === mark) return lines[i];
  return undefined;
}

/** A span's UI-thread cost (what the browser proof budgets), else its painted duration. */
function spanMs(l: LedgerLine | undefined): number | null {
  if (!l) return null;
  const commit = l.commit_ms;
  return typeof commit === "number" ? commit : (l.dur ?? null);
}

export function timingsReport(
  lines: readonly LedgerLine[],
  queries: readonly QueryTiming[],
  tabTitle: (tab: number) => string | undefined = () => undefined,
  mac = isMacPlatform(),
): TimingSection[] {
  const first = (m: string) => lines.find((l) => l.mark === m);
  const webview = first("webview-ready");
  const shell = first("shell-painted");
  // Rust's mark is when the session was ready; the page's, when it heard.
  const socket = lines.find((l) => l.mark === "socket-warm" && l.source === "rust") ?? first("socket-warm");
  const launch: TimingRow[] = [
    { label: "process → webview ready", ms: webview?.t ?? null },
    { label: "process → window painted", ms: shell?.t ?? null, budget: BUDGETS.window_painted },
    {
      label: "socket warm, after webview ready",
      ms: socket && webview ? r1(socket.t - webview.t) : null,
      budget: BUDGETS.socket_warm_vs_webview_ready,
    },
    // The palette's key as this platform and keymap print it (Ctrl+K off macOS).
    { label: `${keysFor("command-palette", mac)} open (last)`, ms: spanMs(last(lines, "palette-open")), budget: BUDGETS.palette_open },
    { label: "window switch (last)", ms: spanMs(last(lines, "window-switch")), budget: BUDGETS.window_switch },
  ];

  const q = queries[queries.length - 1];
  const since = (t: number | null | undefined) => (q && t != null ? r1(t - q.runSent) : null);
  const query: TimingRow[] = [
    { label: "run → first frame", ms: since(q?.firstFrame), budget: BUDGETS.first_frame },
    { label: "run → rows painted", ms: since(q?.firstFramePainted), budget: BUDGETS.first_frame_painted },
    { label: "first row (database)", ms: q?.firstRowMs ?? null },
    {
      label: "database",
      ms: q?.elapsedMs ?? null,
      note: q?.rows != null ? `${q.rows.toLocaleString()} ${q.rows === 1 ? "row" : "rows"}` : undefined,
    },
  ];
  const title = q ? tabTitle(q.tab) : undefined;
  return [
    { title: "Launch", rows: launch },
    { title: title ? `Last query · ${title}` : "Last query", rows: query },
  ];
}

export function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  return `${Math.abs(ms) < 10 ? r1(ms).toFixed(1) : Math.round(ms).toLocaleString()} ms`;
}

/** Over its budget; false when there is no budget or no measurement. */
export function overBudget(row: TimingRow): boolean {
  return row.budget != null && row.ms != null && row.ms > row.budget;
}

/** Copy's text: `process → window painted 312 ms (budget 400)`, one row per line. */
export function timingsText(sections: TimingSection[], heading: string): string {
  const out = [heading];
  for (const s of sections) {
    out.push("", s.title);
    for (const r of s.rows) {
      let line = `${r.label} ${formatMs(r.ms)}`;
      if (r.note) line += ` · ${r.note}`;
      if (r.budget != null) line += ` (budget ${r.budget}${overBudget(r) ? ", over" : ""})`;
      out.push(line);
    }
  }
  return out.join("\n");
}
