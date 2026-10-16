// gridWidths.ts: dragged widths per result shape, in config.json via persist.ts.
import { beforeEach, describe, expect, test } from "vitest";
import { loadWidths, MAX_SHAPES, saveShapeWidths } from "../src/gridWidths";
import { readKey, resetPersistForTests } from "../src/persist";

beforeEach(() => resetPersistForTests());

describe("gridWidths", () => {
  test("a shape's widths are saved with the UI state and read back", () => {
    expect(loadWidths()).toEqual({});
    saveShapeWidths("id\0name", { id: 90 });
    expect(readKey("rowkery.columnWidths")).toEqual({ "id\0name": { id: 90 } });
    // Another shape with an `id` keeps its own.
    saveShapeWidths("id\0amount", { id: 200 });
    expect(loadWidths()["id\0name"]).toEqual({ id: 90 });
  });

  test("saving merges what another window saved meanwhile", () => {
    resetPersistForTests({ "rowkery.columnWidths": { a: { a: 100 } } });
    const all = saveShapeWidths("b", { b: 150 });
    expect(all).toEqual({ a: { a: 100 }, b: { b: 150 } });
  });

  test("bad values are dropped; the least recently dragged shapes go past the cap", () => {
    resetPersistForTests({ "rowkery.columnWidths": { a: { x: "wide", y: 0 }, b: { z: 80 } } });
    expect(loadWidths()).toEqual({ b: { z: 80 } });
    for (let i = 0; i < MAX_SHAPES; i++) saveShapeWidths(`s${i}`, { c: 100 });
    const all = loadWidths();
    expect(Object.keys(all)).toHaveLength(MAX_SHAPES);
    expect(all.b).toBeUndefined();
    // Dragging an old shape again makes it the newest.
    saveShapeWidths("s0", { c: 120 });
    expect(Object.keys(loadWidths()).at(-1)).toBe("s0");
  });
});
