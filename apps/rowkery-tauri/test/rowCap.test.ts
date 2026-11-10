// A tab's row cap: how much the next fetch asks for (`rowCap.ts`).
import { describe, expect, it } from "vitest";
import { atCap, CAPPED_MESSAGE, MAX_TAB_ROWS, nextFetchRows, pageAfter } from "../src/rowCap";
import type { Value } from "../src/types";

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

  // Core reads a cell as a one-key map; a bytes cell carries `byteLength`
  // too, and sending it failed the whole `browse_table` call.
  it("continues from the sort and key columns, never from a bytes cell", () => {
    const row: Record<string, Value> = {
      id: { Int: 1000 },
      name: { Text: "Ada" },
      big: { BigInt: "18446744073709551615" },
      payload: { Bytes: [137, 80], byteLength: 4096 },
    };
    const cell = (name: string) => row[name];
    expect(pageAfter(["name", "id"], cell)).toEqual({ name: { Text: "Ada" }, id: { Int: 1000 } });
    expect(pageAfter(["big"], cell)).toEqual({ big: { BigInt: "18446744073709551615" } });
    // A binary key or sort, or a column that wasn't selected: left out, so core pages by OFFSET.
    expect(pageAfter(["payload", "id"], cell)).toEqual({ id: { Int: 1000 } });
    expect(pageAfter(["hidden", "id"], cell)).toEqual({ id: { Int: 1000 } });
  });
});
