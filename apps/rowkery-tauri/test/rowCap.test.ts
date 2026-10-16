// A tab's row cap: how much the next fetch asks for (`rowCap.ts`).
import { describe, expect, it } from "vitest";
import { atCap, CAPPED_MESSAGE, MAX_TAB_ROWS, nextFetchRows } from "../src/rowCap";

describe("row cap", () => {
  it("asks for a page, or All, within what the tab may still hold", () => {
    expect(nextFetchRows(1000, 0)).toBe(1000);
    expect(nextFetchRows(1000, MAX_TAB_ROWS - 400)).toBe(400);
    expect(nextFetchRows(0, 0)).toBe(MAX_TAB_ROWS);
    expect(nextFetchRows(0, 2000)).toBe(MAX_TAB_ROWS - 2000);
  });

  it("asks for nothing at the cap", () => {
    expect(nextFetchRows(1000, MAX_TAB_ROWS)).toBe(0);
    expect(nextFetchRows(0, MAX_TAB_ROWS)).toBe(0);
    expect(nextFetchRows(5000, MAX_TAB_ROWS + 10)).toBe(0);
    expect(atCap(MAX_TAB_ROWS)).toBe(true);
    expect(atCap(MAX_TAB_ROWS - 1)).toBe(false);
  });

  it("says where it stopped, plainly", () => {
    expect(CAPPED_MESSAGE).toBe("Stopped at 1,000,000 rows");
  });
});
