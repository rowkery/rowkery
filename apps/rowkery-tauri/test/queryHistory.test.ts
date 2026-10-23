// queryHistory.ts: recent SQL per connection, saved with the UI state.
import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { forgetHistory, loadHistory, MAX_SQL, recordHistory } = await import("../src/queryHistory");

describe("query history", () => {
  test("SQL too long to keep isn't recorded", () => {
    let h = recordHistory("c1", [], "select 1");
    h = recordHistory("c1", h, `select '${"x".repeat(MAX_SQL)}'`);
    expect(h.map((e) => e.sql)).toEqual(["select 1"]);
    expect(loadHistory("c1").map((e) => e.sql)).toEqual(["select 1"]);
  });

  test("a deleted connection's history goes with it", () => {
    recordHistory("gone", [], "select 2");
    recordHistory("kept", [], "select 3");
    forgetHistory("gone");
    expect(loadHistory("gone")).toEqual([]);
    expect(loadHistory("kept").map((e) => e.sql)).toEqual(["select 3"]);
  });
});
