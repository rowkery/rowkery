import { readKey, writeKey } from "./persist";

/** A query or table tab as saved: everything but its results. */
export interface SavedTab {
  kind: "query" | "table" | "sessions";
  title: string;
  sql: string;
  view?: "data" | "structure";
  tableKey?: string;
  schema?: string;
  table?: string;
  filter?: string;
  /** The filter's chips (checked with `savedChips` on restore). */
  chips?: unknown[];
  /** Sort keys, primary first (older saves held one key or null; see `sortKeys`). */
  sort?: { column: string; desc: boolean }[] | { column: string; desc: boolean } | null;
  /** Table tabs: columns left out of the SELECT list. */
  hidden?: string[];
  pageSize?: number;
  preview?: boolean;
  /** Table tabs: staged row edits (checked with `savedBuffer` on restore). */
  edits?: unknown;
}

/** Open windows, restored on launch without connecting until one is shown. */
export interface StoredWindow {
  connectionId: string | null;
  database: string | null;
  /** Its tabs and SQL, in order; restored with the window. */
  tabs?: SavedTab[];
  /** Index into `tabs` of the tab that was showing. */
  activeTab?: number;
}

function savedTabs(raw: unknown): SavedTab[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tabs = raw.filter(
    (t): t is SavedTab =>
      !!t &&
      typeof t === "object" &&
      (t.kind === "query" || t.kind === "table" || t.kind === "sessions") &&
      typeof t.title === "string" &&
      typeof t.sql === "string",
  );
  return tabs.length ? tabs : undefined;
}

const KEY = "rowkery.windows";

export function loadWindows(): { windows: StoredWindow[]; active: number } | null {
  try {
    const raw = readKey(KEY);
    if (!raw || typeof raw !== "object") return null;
    const parsed = raw as { windows?: unknown; active?: unknown };
    if (!Array.isArray(parsed.windows) || parsed.windows.length === 0) return null;
    const windows = parsed.windows
      .filter((w): w is StoredWindow => typeof w === "object" && w !== null)
      .map((w) => {
        const tabs = savedTabs(w.tabs);
        return {
          connectionId: typeof w.connectionId === "string" ? w.connectionId : null,
          database: typeof w.database === "string" ? w.database : null,
          tabs,
          activeTab:
            tabs && typeof w.activeTab === "number" && w.activeTab < tabs.length ? w.activeTab : 0,
        };
      });
    if (windows.length === 0) return null;
    const active =
      typeof parsed.active === "number" && parsed.active < windows.length
        ? parsed.active
        : 0;
    return { windows, active };
  } catch {
    return null;
  }
}

export function saveWindows(windows: StoredWindow[], active: number) {
  writeKey(KEY, { windows, active });
}
