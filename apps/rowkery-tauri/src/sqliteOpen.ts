import type { ConnectionRecord } from "./types";

/**
 * What opening a SQLite file by path does (⌘O, a dropped file, a path typed
 * or pasted into ⌘K): reuse the saved connection on that path, else save a
 * new one named after the file. A typed path is checked first (`exists`), so
 * a typo saves nothing.
 */
export type SqliteOpen =
  | { kind: "missing" }
  | { kind: "reuse"; id: string; name: string }
  | { kind: "new"; record: ConnectionRecord & { kind: "sqlite" } };

/** The file's name without its .sqlite / .sqlite3 / .db extension. */
export function sqliteName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.(sqlite3?|db3?)$/i, "");
}

export async function planSqliteOpen(
  path: string,
  connections: ConnectionRecord[],
  o: { exists?: (path: string) => Promise<boolean>; newId?: () => string } = {},
): Promise<SqliteOpen> {
  if (o.exists && !(await o.exists(path))) return { kind: "missing" };
  const same = connections.find((c) => c.kind === "sqlite" && c.path === path);
  if (same) return { kind: "reuse", id: same.id, name: same.name };
  const id = o.newId ? o.newId() : crypto.randomUUID();
  return { kind: "new", record: { kind: "sqlite", id, name: sqliteName(path), path } };
}
