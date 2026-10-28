// rowkery/reports#45: a cell of megabytes stays out of the DOM.
import { describe, expect, test } from "vitest";
import { CELL_SHOWN_CHARS, CELL_TITLE_CHARS, clipText, initialWidths } from "../src/gridLayout";
import { jsonShownText } from "../src/editBuffer";
import type { ResultRows } from "../src/resultStore";
import { quickLookTitle } from "../src/QuickLook";

const big = "x".repeat(5 * 1024 * 1024);

describe("big cells", () => {
  test("the grid shows the start of a big value and an ellipsis", () => {
    expect(clipText("short", CELL_SHOWN_CHARS)).toBe("short");
    const shown = clipText(big, CELL_SHOWN_CHARS);
    expect(shown).toHaveLength(CELL_SHOWN_CHARS + 1);
    expect(shown.endsWith("…")).toBe(true);
    expect(clipText(big, CELL_TITLE_CHARS)).toHaveLength(CELL_TITLE_CHARS + 1);
  });

  test("an emoji at the cut isn't split in half", () => {
    const text = `${"a".repeat(9)}😀tail`;
    expect(clipText(text, 10)).toBe(`${"a".repeat(9)}…`);
    expect(clipText(text, 11)).toBe(`${"a".repeat(9)}😀…`);
  });

  test("sizing a column reads only the start of a big value", () => {
    const rows = { length: 1, isNull: () => false, text: () => `😀${big}` } as unknown as ResultRows;
    const started = performance.now();
    const [width] = initialWidths([{ name: "body", type_name: "text" }], rows);
    expect(width).toBe(360);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("Quick Look pretty-prints JSON once, and leaves a huge value as stored", () => {
    expect(jsonShownText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(jsonShownText('{"a":1}')).toBe('{\n  "a": 1\n}');
    const huge = `{"body":"${big}"}`;
    expect(jsonShownText(huge)).toBe(huge);
  });

  test("Quick Look's title is the start of a big value", () => {
    const title = quickLookTitle([{ name: "body", type_name: "text" }], [{ Text: big }], -1, 1);
    expect(title.length).toBeLessThanOrEqual(201);
    expect(title.endsWith("…")).toBe(true);
  });
});
