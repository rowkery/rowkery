// sqliteOpen.ts: a SQLite path from ⌘K, ⌘O or a drop becomes one connection, never a duplicate or a typo.
import { describe, expect, test } from "vitest";
import { planSqliteOpen, sqliteName } from "../src/sqliteOpen";
import type { ConnectionRecord } from "../src/types";

const saved: ConnectionRecord[] = [
  { kind: "sqlite", id: "s1", name: "app", path: "/tmp/app.sqlite" },
  { kind: "postgres", id: "p1", name: "wallet", host: "h", port: 5432, database: "wallet", username: "u" } as ConnectionRecord,
];

describe("planSqliteOpen", () => {
  test("a typed path with no file there saves nothing", async () => {
    const asked: string[] = [];
    const exists = async (p: string) => (asked.push(p), false);
    expect(await planSqliteOpen("/tmp/typo.sqlite", saved, { exists })).toEqual({ kind: "missing" });
    expect(asked).toEqual(["/tmp/typo.sqlite"]);
  });

  test("a path already saved reuses its connection", async () => {
    const exists = async () => true;
    expect(await planSqliteOpen("/tmp/app.sqlite", saved, { exists })).toEqual({ kind: "reuse", id: "s1", name: "app" });
    expect(await planSqliteOpen("/tmp/app.sqlite", saved)).toEqual({ kind: "reuse", id: "s1", name: "app" });
  });

  test("a new file becomes a connection named after it", async () => {
    expect(await planSqliteOpen("/data/My Shop.db", saved, { exists: async () => true, newId: () => "n1" })).toEqual({
      kind: "new",
      record: { kind: "sqlite", id: "n1", name: "My Shop", path: "/data/My Shop.db" },
    });
  });

  test("names drop the extension", () => {
    expect(sqliteName("~/dev/a.sqlite3")).toBe("a");
    expect(sqliteName("C:\\x\\b.db")).toBe("b");
    expect(sqliteName("/x/c.db3")).toBe("c");
  });
});
