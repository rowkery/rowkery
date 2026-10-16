// Header profiles (`columnProfile.ts`): what the header draws from core's
// numbers (`profile.rs`), here made by `summarizeRows`, which mirrors it for
// rows built in the webview (frames.test.ts checks the two agree).
import { describe, expect, test } from "vitest";
import {
  binEdge,
  columnProfiles as profilesOf,
  profileCaption,
  profileSample,
  summarizeRows,
  toColumnProfile,
  ProfileKind,
  UNIQUE,
  type WireProfile,
} from "../src/columnProfile";
import { ResultRows } from "../src/resultStore";
import { sortResult } from "../src/tableSort";
import type { Column } from "../src/types";

function profiled(columns: Column[], values: unknown[][]): ResultRows {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = ResultRows.fromValues(values as any);
  rows.setProfiles(summarizeRows(columns, rows));
  return rows;
}

const columnProfiles = (columns: Column[], values: unknown[][]) => profilesOf(columns, profiled(columns, values));

const col = (name: string, type_name: string) => ({ name, type_name }) as Column;
const Int = (n: number) => ({ Int: n });
const Text = (s: string) => ({ Text: s });
const Null = { Null: null };

const wire = (w: Partial<WireProfile>): WireProfile => ({
  kind: ProfileKind.Categorical,
  sampleRows: 0,
  nulls: 0,
  distinct: 0,
  min: 0,
  max: 0,
  bins: new Array(14).fill(0),
  wholeBins: false,
  top: [],
  ...w,
});

describe("columnProfiles", () => {
  test("no rows, no profiles; nothing is computed in the grid", () => {
    expect(columnProfiles([col("a", "int4")], [])).toEqual([null]);
    // Rows core hasn't profiled (yet) draw nothing: the grid never scans them.
    expect(profilesOf([col("a", "text")], ResultRows.fromValues([[Text("x")]]))).toEqual([null]);
  });

  test("a few whole numbers get one bar each", () => {
    const [p] = columnProfiles([col("id", "int8")], [[Int(2041)], [Int(2042)], [Int(2042)], [Int(2044)]]);
    expect(p).toMatchObject({ kind: "hist", bars: [0.5, 1, 0, 0.5], nullShare: 0 });
    // Each bar is one value: dragging across bars 1-3 filters BETWEEN 2042 AND 2044.
    if (p?.kind === "hist") expect(p.ranges).toEqual([[2041, 2041], [2042, 2042], [2043, 2043], [2044, 2044]]);
  });

  test("wide numeric spread uses 14 bins and counts nulls", () => {
    const rows = [...Array.from({ length: 99 }, (_, i) => [Int(i * 100)]), [Null]];
    const [p] = columnProfiles([col("amount", "numeric")], rows);
    expect(p?.kind).toBe("hist");
    if (p?.kind !== "hist") return;
    expect(p.bars).toHaveLength(14);
    expect(p.ranges[13]).toEqual([9800 - 9800 / 14, 9800]);
    expect(p.nullShare).toBeCloseTo(0.01);
    expect(profileCaption(p)).toBe("1% null");
  });

  test("timestamps read from text", () => {
    const [p] = columnProfiles(
      [col("at", "timestamptz")],
      [[Text("2026-01-01 10:00:00+00")], [Text("2026-03-01 10:00:00+00")]],
    );
    expect(p).toMatchObject({ kind: "hist", time: true });
    if (p?.kind === "hist") expect(p.ranges[0][0]).toBe(Date.UTC(2026, 0, 1, 10));
  });

  test("a few repeated values make a split, top value first", () => {
    const rows = ["pending", "pending", "pending", "settled", null].map((v) => [v === null ? Null : Text(v)]);
    const [p] = columnProfiles([col("status", "text")], rows);
    expect(p).toMatchObject({ kind: "split", top: "pending", topShare: 0.6, nullShare: 0.2 });
    if (p?.kind === "split") expect(p.segs.map((s) => s.value)).toEqual(["pending", "settled", null]);
    if (p) expect(profileCaption(p)).toBe("pending 60%");
  });

  test("more than three values fold into the last segment", () => {
    const rows = ["a", "a", "a", "a", "b", "b", "c", "d", "e", "a", "b", "a"].map((v) => [Text(v)]);
    const [p] = columnProfiles([col("k", "text")], rows);
    expect(p?.kind).toBe("split");
    if (p?.kind !== "split") return;
    expect(p.segs).toHaveLength(4);
    // The rest (d, e) has no value to filter on.
    expect(p.segs[3]).toEqual({ share: 2 / 12, tone: "rank" });
  });

  test("mostly distinct text is unique", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [Text(`user${i}@x.io`)]);
    const [p] = columnProfiles([col("email", "text")], rows);
    expect(p).toEqual({ kind: "unique", distinct: 20, nullShare: 0 });
    if (p) expect(profileCaption(p)).toBe("20 unique");
  });

  test("past 256 distinct values it is just unique", () => {
    const rows = Array.from({ length: 300 }, (_, i) => [Text(`k${i}`)]);
    const [p] = columnProfiles([col("k", "text")], rows);
    expect(p).toEqual({ kind: "unique", distinct: null, nullShare: 0 });
    if (p) expect(profileCaption(p)).toBe("unique");
    const at = toColumnProfile(wire({ sampleRows: 5000, nulls: 2500, distinct: UNIQUE }));
    expect(at && profileCaption(at)).toBe("unique · 50% null");
  });

  test("booleans colour true and report its share", () => {
    const rows = [true, false, false, true, true].map((b) => [{ Bool: b }]);
    const [p] = columnProfiles([col("ok", "bool")], rows);
    expect(p).toMatchObject({ kind: "split", top: "true", topShare: 0.6 });
    if (p?.kind === "split") expect(p.segs[0].tone).toBe("true");
  });

  test("all null", () => {
    const [p] = columnProfiles([col("x", "text")], [[Null], [Null]]);
    expect(p).toEqual({ kind: "null" });
    if (p) expect(profileCaption(p)).toBe("all null");
  });

  test("bytea has no profile; untyped SQLite numbers get a histogram", () => {
    const [b, n] = columnProfiles([col("b", "bytea"), col("n", "")], [[Text("\\x00"), Int(1)], [Text("\\x01"), Int(5)]]);
    expect(b).toBeNull();
    expect(n?.kind).toBe("hist");
  });

  test("only the first 5,000 rows are read, and the tooltip says so", () => {
    const values = [...Array.from({ length: 5000 }, () => [Text("a")]), ...Array.from({ length: 5000 }, () => [Text("b")])];
    const rows = profiled([col("k", "text")], values);
    expect(profilesOf([col("k", "text")], rows)[0]).toMatchObject({ kind: "split", top: "a", topShare: 1 });
    expect(profileSample(rows)).toBe("of first 5,000");
    // All rows read: nothing to say.
    expect(profileSample(profiled([col("k", "text")], [[Text("a")]]))).toBe("");
  });

  test("sorting and the next page keep the first rows' profiles", () => {
    const columns = [col("n", "int4")];
    const rows = profiled(columns, [[Int(3)], [Int(1)], [Int(2)]]);
    const sorted = sortResult({ columns, rows, row_count: 3, elapsed_ms: 0, error: null, cancelled: false }, [{ column: "n", desc: false }]);
    expect(sorted.rows.profiles).toBe(rows.profiles);
    const next = ResultRows.concat(rows, profiled(columns, [[Int(100)]]));
    expect(next.profiles).toBe(rows.profiles);
  });
});

describe("a histogram drag's edges hold every row", () => {
  test("the low edge rounds down and the high edge up", () => {
    // 6 significant digits; rounding to nearest would cut the min or max row.
    expect(binEdge(1.2345678, false, "low")).toBe("1.23456");
    expect(binEdge(1.2345678, false, "high")).toBe("1.23457");
    expect(binEdge(1.2345628, false, "high")).toBe("1.23457");
    expect(binEdge(-1.2345678, false, "low")).toBe("-1.23457");
    expect(binEdge(-1.2345678, false, "high")).toBe("-1.23456");
    expect(binEdge(1.5, false, "low")).toBe("1.5");
    expect(binEdge(1.5, false, "high")).toBe("1.5");
    expect(binEdge(42, false, "high")).toBe("42");
    for (const x of [0.1 + 0.2, 1 / 3, 123456.789, 1e-7 * 3.3333333, 9.99999999]) {
      expect(Number(binEdge(x, false, "low")), String(x)).toBeLessThanOrEqual(x);
      expect(Number(binEdge(x, false, "high")), String(x)).toBeGreaterThanOrEqual(x);
      expect(binEdge(x, false, "high")).not.toContain("e");
    }
  });

  test("times keep their fractions: the high edge covers its whole second", () => {
    const at = Date.UTC(2026, 2, 1, 10, 0, 0, 500);
    expect(binEdge(at, true, "low")).toBe("2026-03-01 10:00:00");
    expect(binEdge(at, true, "high")).toBe("2026-03-01 10:00:00.999999");
    // A day's midnight is a date either way.
    const day = Date.UTC(2026, 1, 1);
    expect(binEdge(day, true, "low")).toBe("2026-02-01");
    expect(binEdge(day, true, "high")).toBe("2026-02-01");
  });

  test("the profile's range keeps milliseconds", () => {
    const rows = ResultRows.fromValues([[{ Text: "2026-03-01 10:00:00.5" }], [{ Text: "2026-01-01 10:00:00" }]]);
    const [w] = summarizeRows([col("at", "timestamp")], rows);
    expect(w.max).toBe(Date.UTC(2026, 2, 1, 10, 0, 0, 500));
  });
});
