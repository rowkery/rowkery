import { describe, expect, test } from "vitest";
import { ResultRows } from "../src/resultStore";
import {
  compareCells,
  compareValues,
  cycleSort,
  isNumericType,
  hiddenGrips,
  setSortDirection,
  sortKeys,
  sortResult,
  sortedOrder,
  visibleColumns,
} from "../src/tableSort";
import type { QueryResultDto, Value } from "../src/types";

const N = (n: number): Value => ({ Int: n });
const F = (n: number): Value => ({ Float: n });
const B = (s: string): Value => ({ BigInt: s });
const T = (s: string): Value => ({ Text: s });
const NULL: Value = { Null: null };

const sortCol = (vals: Value[], desc = false) =>
  sortedOrder((r) => vals[r]!, vals.length, [{ col: 0, desc }]).map((r) => vals[r]);

describe("header click", () => {
  test("cycles asc → desc → off on the primary column", () => {
    let k = cycleSort([], "amount");
    expect(k).toEqual([{ column: "amount", desc: false }]);
    k = cycleSort(k, "amount");
    expect(k).toEqual([{ column: "amount", desc: true }]);
    expect(cycleSort(k, "amount")).toEqual([]);
  });

  test("a plain click on another column sorts by it alone", () => {
    const k = [
      { column: "a", desc: true },
      { column: "b", desc: false },
    ];
    expect(cycleSort(k, "b")).toEqual([{ column: "b", desc: false }]);
  });

  test("⇧-click adds, then cycles, a secondary key", () => {
    let k = cycleSort([{ column: "status", desc: false }], "amount", true);
    expect(k).toEqual([
      { column: "status", desc: false },
      { column: "amount", desc: false },
    ]);
    k = cycleSort(k, "amount", true);
    expect(k[1]).toEqual({ column: "amount", desc: true });
    expect(cycleSort(k, "amount", true)).toEqual([{ column: "status", desc: false }]);
    // With nothing sorted, ⇧-click is a plain click.
    expect(cycleSort([], "id", true)).toEqual([{ column: "id", desc: false }]);
  });

  test("the header menu sets a direction or clears a key", () => {
    const k = [
      { column: "a", desc: false },
      { column: "b", desc: false },
    ];
    expect(setSortDirection(k, "b", true)).toEqual([
      { column: "a", desc: false },
      { column: "b", desc: true },
    ]);
    expect(setSortDirection(k, "a", null)).toEqual([{ column: "b", desc: false }]);
    expect(setSortDirection(k, "c", true)).toEqual([{ column: "c", desc: true }]);
  });

  test("older saved tabs held one key or null", () => {
    expect(sortKeys(null)).toEqual([]);
    expect(sortKeys({ column: "id", desc: true })).toEqual([{ column: "id", desc: true }]);
    expect(sortKeys([{ column: "a", desc: false }, { nope: 1 }])).toEqual([{ column: "a", desc: false }]);
  });
});

describe("client-side sort of loaded rows", () => {
  test("numbers by value, not as text", () => {
    expect(sortCol([N(10), N(9), F(9.5), N(-1)])).toEqual([N(-1), N(9), F(9.5), N(10)]);
  });

  test("BigInt digits compare exactly, also against numbers", () => {
    expect(sortCol([B("9007199254740995"), B("9007199254740993"), N(5), B("-9007199254740993")])).toEqual([
      B("-9007199254740993"),
      N(5),
      B("9007199254740993"),
      B("9007199254740995"),
    ]);
  });

  test("text in locale order, not by code point", () => {
    // Case and accents fall between letters, not after Z; they still differ.
    expect(sortCol([T("b"), T("B"), T("a"), T("ab"), T("Zed")])).toEqual([T("a"), T("ab"), T("b"), T("B"), T("Zed")]);
    expect(sortCol([T("f"), T("é"), T("e")])).toEqual([T("e"), T("é"), T("f")]);
    expect(compareCells(T("a"), T("A"), false)).not.toBe(0);
  });

  test("NULLs last in both directions", () => {
    expect(sortCol([NULL, N(2), N(1), NULL])).toEqual([N(1), N(2), NULL, NULL]);
    expect(sortCol([NULL, N(2), N(1)], true)).toEqual([N(2), N(1), NULL]);
    expect(compareCells(NULL, NULL, false)).toBe(0);
  });

  test("stable, with a second key breaking ties", () => {
    const rows = [
      [T("b"), N(1)],
      [T("a"), N(2)],
      [T("b"), N(3)],
      [T("a"), N(1)],
    ];
    const get = (r: number, c: number) => rows[r]![c]!;
    expect(sortedOrder(get, 4, [{ col: 0, desc: false }])).toEqual([1, 3, 0, 2]);
    expect(
      sortedOrder(get, 4, [
        { col: 0, desc: false },
        { col: 1, desc: true },
      ]),
    ).toEqual([1, 3, 2, 0]);
  });

  test("sortResult returns the rows in the new order", () => {
    const result = {
      columns: [
        { name: "id", type_name: "int4" },
        { name: "name", type_name: "text" },
      ],
      rows: ResultRows.fromValues([
        [N(2), T("x")],
        [N(1), T("y")],
      ]),
      row_count: 2,
      elapsed_ms: 1,
      error: null,
      cancelled: false,
    } as QueryResultDto;
    const sorted = sortResult(result, [{ column: "id", desc: false }]);
    expect(sorted.rows.text(0, 1)).toBe("y");
    expect(sortResult(result, [])).toBe(result);
  });
});

describe("hidden columns", () => {
  const all = ["id", "wallet_id", "amount", "note", "created_at"];
  test("the explicit list leaves them out; none hidden selects *", () => {
    expect(visibleColumns(all, [])).toEqual([]);
    expect(visibleColumns(all, ["note"])).toEqual(["id", "wallet_id", "amount", "created_at"]);
  });
  test("grips sit where they were", () => {
    expect(hiddenGrips(all, ["note", "amount", "id"])).toEqual([
      { before: 0, names: ["id"] },
      { before: 1, names: ["amount", "note"] },
    ]);
  });
});

describe("numeric text sorts by value", () => {
  test("a query tab's numeric column orders -3, 9.50, 10.00, 100", () => {
    const values = ["10.00", "-3", "100", "9.50", "-3.5", "0.001"].map((t) => [{ Text: t }, { Text: t }]);
    const result = {
      columns: [
        { name: "amount", type_name: "numeric" },
        { name: "code", type_name: "text" },
      ],
      rows: ResultRows.fromValues(values),
      row_count: values.length,
      elapsed_ms: 0,
    } as unknown as QueryResultDto;
    const col = (r: QueryResultDto, c: number) =>
      Array.from({ length: r.rows.length }, (_, i) => r.rows.text(i, c));
    expect(col(sortResult(result, [{ column: "amount", desc: false }]), 0)).toEqual([
      "-3.5",
      "-3",
      "0.001",
      "9.50",
      "10.00",
      "100",
    ]);
    // A text column still sorts as text.
    expect(col(sortResult(result, [{ column: "code", desc: false }]), 1)[0]).toBe("-3");
  });

  test("digits compare exactly, past what a double holds", () => {
    const t = (s: string) => ({ Text: s });
    expect(compareValues(t("123456789012345678901.5"), t("123456789012345678901.25"), true)).toBe(1);
    expect(compareValues(t("-99999999999999999999"), t("-99999999999999999998"), true)).toBe(-1);
    expect(compareValues(t("1.10"), t("1.1"), true)).toBe(0);
    expect(compareValues(t("-0"), t("0"), true)).toBe(0);
    expect(compareValues(t("NaN"), t("1e300"), true)).toBe(1);
    expect(compareValues(t("Infinity"), t("99"), true)).toBe(1);
    expect(compareValues(t("-Infinity"), t("-99"), true)).toBe(-1);
    // Mixed with numbers the database sent as numbers.
    expect(compareValues({ Int: 10 }, t("9.99"), true)).toBe(1);
    expect(compareValues({ BigInt: "9007199254740993" }, t("9007199254740992.5"), true)).toBe(1);
  });

  test("which types hold numbers", () => {
    for (const t of ["numeric", "numeric(10,2)", "decimal", "int4", "integer", "bigint", "float8", "double precision", "real"]) {
      expect(isNumericType(t), t).toBe(true);
    }
    for (const t of ["interval", "text", "money", "point", "internal"]) expect(isNumericType(t), t).toBe(false);
  });
});
