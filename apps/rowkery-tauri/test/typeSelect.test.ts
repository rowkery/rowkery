import { describe, expect, test } from "vitest";
import { typeSelect } from "../src/typeSelect";

const COLUMNS = ["any text column", "id", "amount", "status", "note", "kiosk_id"];
const OPS = ["is", "more than", "less than", "between", "More…"];

describe("typeSelect", () => {
  test("a letter jumps to the first row starting with it", () => {
    expect(typeSelect(COLUMNS, -1, "s")).toBe(3);
    expect(typeSelect(COLUMNS, -1, "S")).toBe(3);
  });

  test("the same letter again steps to the next match, and wraps", () => {
    expect(typeSelect(COLUMNS, -1, "a")).toBe(0);
    expect(typeSelect(COLUMNS, 0, "aa")).toBe(2);
    expect(typeSelect(COLUMNS, 2, "aaa")).toBe(0);
  });

  test("more letters narrow, keeping the row while it still matches", () => {
    expect(typeSelect(COLUMNS, 0, "am")).toBe(2);
    expect(typeSelect(OPS, -1, "mo")).toBe(1);
    expect(typeSelect(OPS, 1, "more…")).toBe(4);
    expect(typeSelect(OPS, 1, "more ")).toBe(1);
  });

  test("no match keeps the cursor", () => {
    expect(typeSelect(COLUMNS, 2, "z")).toBe(2);
    expect(typeSelect(COLUMNS, -1, "zz")).toBe(-1);
    expect(typeSelect([], -1, "a")).toBe(-1);
  });
});
