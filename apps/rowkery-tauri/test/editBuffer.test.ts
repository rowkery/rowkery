// Staged row edits: what the buffer keeps, what it sends core, and who may edit.
import { describe, expect, test } from "vitest";
import {
  addInserts,
  boolOf,
  bufferChanges,
  editorStartText,
  jsonEditorText,
  sameValue,
  withoutCommitted,
  changeCount,
  columnEditor,
  editRefusal,
  emptyBuffer,
  parseInput,
  parsePaste,
  revertCell,
  rowKey,
  savedBuffer,
  setInsertCell,
  stageCell,
  toggleDeletes,
  valueKey,
} from "../src/editBuffer";
import type { TableNode } from "../src/types";

const key = (id: number) => [{ column: "id", value: { Int: id } }];
const kiosks: TableNode = {
  name: "kiosks",
  kind: "table",
  primary_key: ["id"],
  columns: [
    { name: "id", type_name: "integer", nullable: false, default: "nextval('kiosks_id_seq'::regclass)" },
    { name: "name", type_name: "text", nullable: false },
  ],
};

describe("staging", () => {
  test("a cell back to its original value is no longer edited", () => {
    let b = stageCell(emptyBuffer("db.public.kiosks", "c1"), key(3), "city", { Text: "PJ" }, { Text: "KL" });
    expect(changeCount(b)).toBe(1);
    b = stageCell(b, key(3), "city", { Text: "Puchong" }, { Text: "ignored: the first original stands" });
    expect(b.updates[rowKey(key(3))].was.city).toEqual({ Text: "KL" });
    b = stageCell(b, key(3), "city", { Text: "KL" }, { Text: "KL" });
    expect(changeCount(b)).toBe(0);
  });

  test("staging what is already there returns the same buffer (no ⌘Z step)", () => {
    const empty = emptyBuffer("t", "c1");
    expect(stageCell(empty, key(1), "city", { Text: "KL" }, { Text: "KL" })).toBe(empty);
    const b = stageCell(empty, key(1), "city", { Text: "PJ" }, { Text: "KL" });
    expect(stageCell(b, key(1), "city", { Text: "PJ" }, { Text: "KL" })).toBe(b);
    expect(stageCell(b, key(1), "city", { Text: "KL" }, { Text: "KL" })).not.toBe(b);
  });

  test("Esc reverts one cell and keeps the others", () => {
    let b = stageCell(emptyBuffer("t", "c1"), key(1), "a", { Int: 2 }, { Int: 1 });
    b = stageCell(b, key(1), "b", null, { Text: "x" });
    b = revertCell(b, key(1), "a");
    expect(b.updates[rowKey(key(1))].set).toEqual({ b: null });
  });

  test("⌫ marks rows and unmarks them when all were marked", () => {
    let b = toggleDeletes(emptyBuffer("t", "c1"), [key(1), key(2)]);
    expect(Object.keys(b.deletes)).toHaveLength(2);
    b = toggleDeletes(b, [key(1)]);
    expect(Object.keys(b.deletes)).toHaveLength(1);
    b = toggleDeletes(b, [key(1), key(2)]);
    expect(Object.keys(b.deletes)).toHaveLength(2);
  });

  test("Int and BigInt of the same number name the same row", () => {
    expect(valueKey({ Int: 12 })).toBe(valueKey({ BigInt: "12" }));
    expect(valueKey(null)).toBe(valueKey({ Null: null }));
  });
});

describe("what core gets", () => {
  test("inserts in the order made, then updates, then deletes; a deleted row drops its edits", () => {
    let b = addInserts(emptyBuffer("t", "c1"), [{ id: 1, values: { name: { Text: "first" } } }]);
    b = addInserts(b, [{ id: 2, values: {} }]);
    b = setInsertCell(b, 2, "name", { Text: "second" });
    b = stageCell(b, key(3), "name", { Text: "x" }, { Text: "y" });
    b = stageCell(b, key(4), "name", { Text: "x" }, { Text: "y" });
    b = toggleDeletes(b, [key(4)]);
    expect(bufferChanges(b)).toEqual([
      { op: "insert", values: [{ column: "name", value: { Text: "first" } }] },
      { op: "insert", values: [{ column: "name", value: { Text: "second" } }] },
      { op: "update", key: key(3), set: [{ column: "name", value: { Text: "x" } }] },
      { op: "delete", key: key(4) },
    ]);
    // A new row's cell back to DEFAULT leaves it out.
    expect(bufferChanges(setInsertCell(b, 2, "name", undefined))[1]).toEqual({ op: "insert", values: [] });
  });

  test("a saved buffer comes back, and a broken one doesn't", () => {
    const b = toggleDeletes(stageCell(emptyBuffer("t", "c1"), key(1), "a", { Int: 2 }, { Int: 1 }), [key(5)]);
    expect(savedBuffer(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(savedBuffer({ tableKey: "t", inserts: [], updates: {}, deletes: {} })).toBeUndefined();
    expect(savedBuffer({ tableKey: "t", inserts: "x" })).toBeUndefined();
    expect(savedBuffer({ tableKey: "t", inserts: [], updates: { k: { key: [], set: {}, was: {} } }, deletes: {} })).toBeUndefined();
  });
});

describe("who may edit", () => {
  test("a table with its key shown, on a connection that isn't read-only", () => {
    expect(editRefusal(kiosks, "off", ["id", "name"])).toBeNull();
    expect(editRefusal(kiosks, "confirm", ["id", "name"])).toBeNull();
    expect(editRefusal(kiosks, "read_only", ["id", "name"])).toBe("Read-only connection · Change safe mode…");
    expect(editRefusal({ ...kiosks, primary_key: [] }, "off", ["id"])).toBe("No primary key · rows here can't be edited");
    expect(editRefusal({ ...kiosks, kind: "view" }, "off", ["id"])).toBe("Views can't be edited");
    expect(editRefusal(kiosks, "off", ["name"])).toBe("Show id to edit rows");
    expect(editRefusal(undefined, "off", ["id"])).not.toBeNull();
  });

  test("each column gets its typed editor", () => {
    const pg = (type_name: string) => columnEditor({ name: "c", type_name, nullable: true }, "postgres", [
      { schema: "public", name: "kiosk_status", labels: ["open", "closed"] },
    ]);
    expect(pg("integer")?.kind).toBe("int");
    expect(pg("numeric(10,2)")?.kind).toBe("number");
    expect(pg("boolean")?.kind).toBe("bool");
    expect(pg("jsonb")?.kind).toBe("json");
    expect(pg("timestamp with time zone")?.kind).toBe("date");
    expect(pg("date")?.placeholder).toBe("YYYY-MM-DD · now()");
    expect(pg("kiosk_status")).toMatchObject({ kind: "enum", labels: ["open", "closed"] });
    expect(pg("public.kiosk_status")?.kind).toBe("enum");
    expect(pg("text[]")?.kind).toBe("text");
    expect(pg("bytea")).toBeNull();
    const lite = (type_name: string) => columnEditor({ name: "c", type_name, nullable: true }, "sqlite", [])?.kind;
    expect([lite("INTEGER"), lite("REAL"), lite("TEXT"), lite("BLOB")]).toEqual(["int", "number", "text", undefined]);
  });
});

describe("typed input", () => {
  test("numbers stay exact; the wrong kind is refused", () => {
    expect(parseInput("int", " 42 ")).toEqual({ value: { Int: 42 } });
    expect(parseInput("int", "9223372036854775807")).toEqual({ value: { BigInt: "9223372036854775807" } });
    expect(parseInput("int", "4.2")).toEqual({ error: "Whole numbers only" });
    expect(parseInput("number", "12.50")).toEqual({ value: { Text: "12.50" } });
    expect(parseInput("number", "12,5")).toHaveProperty("error");
    expect(parseInput("bool", "f")).toEqual({ value: { Bool: false } });
    expect(parseInput("date", "now()")).toEqual({ value: { Text: "now" } });
    expect(parseInput("json", '{"a":1}')).toEqual({ value: { Text: '{"a":1}' } });
    expect(parseInput("json", "{a:1}")).toEqual({ error: "Not valid JSON" });
    expect(parseInput("text", " it's ")).toEqual({ value: { Text: " it's " } });
  });

  test("a pasted block splits on tabs and lines", () => {
    expect(parsePaste("a\tb\r\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parsePaste("one\ntwo")).toEqual([["one"], ["two"]]);
  });

  test("quoted TSV keeps line breaks, tabs and quotes in one cell", () => {
    expect(parsePaste('"Kuala\nLumpur"\tx\n"a\tb"\t"say ""hi"""\n')).toEqual([
      ["Kuala\nLumpur", "x"],
      ["a\tb", 'say "hi"'],
    ]);
    expect(parsePaste("a\t\nb\tc")).toEqual([["a", ""], ["b", "c"]]);
    // A stray quote isn't a quoted field: split on tabs as is.
    expect(parsePaste('5" pipe\tx')).toEqual([['5" pipe', "x"]]);
  });

  test("a bad quote is taken literally and leaves the rest of the block alone", () => {
    // Excel's unquoted `"Best" seller` beside a quoted multi-line cell.
    expect(parsePaste('"Best" seller\t"a\nb"\nx\ty')).toEqual([['"Best" seller', "a\nb"], ["x", "y"]]);
    // An unquoted field starting with a quote doesn't swallow the cells after it.
    expect(parsePaste('"open\tb\tc\nd\te\tf')).toEqual([['"open', "b", "c"], ["d", "e", "f"]]);
    // A lone quoted word keeps its quotes, so a JSON string pastes as it is.
    expect(parsePaste('"hello"')).toEqual([['"hello"']]);
    expect(parsePaste('"hello"\t{"a": 1}')).toEqual([['"hello"', '{"a": 1}']]);
  });

  test("a line with commas is one value", () => {
    for (const v of ["12 Jalan Ampang, Kuala Lumpur", "3,14", "[1, 2, 3]", '{"a": 1, "b": 2}', '"x","y"']) {
      expect(parsePaste(v)).toEqual([[v]]);
    }
    expect(parsePaste("Hopper, Grace\nTuring, Alan")).toEqual([["Hopper, Grace"], ["Turing, Alan"]]);
  });

  test("CSV only with several lines, a quoted field and the same fields on each", () => {
    expect(parsePaste('a,b\n"c,d","e\nf"')).toEqual([["a", "b"], ["c,d", "e\nf"]]);
    expect(parsePaste('a,b,c\n"c,d"')).toEqual([["a,b,c"], ['"c,d"']]);
    expect(parsePaste("a,b\nc,d")).toEqual([["a,b"], ["c,d"]]);
  });

  test("one column: a value per line, a quoted one keeps its line break", () => {
    expect(parsePaste('"two\nlines"\nNULL\n')).toEqual([["two\nlines"], ["NULL"]]);
    expect(parsePaste("")).toEqual([[""]]);
  });
});

describe("a value closed as it opened stages nothing", () => {
  test("the JSON editor opens on the stored text when pretty-printing would change a number", () => {
    // Past 2^53 and 1.0: JSON.parse would round one and drop the other's zero.
    const big = '{"id": 12345678901234567890, "price": 1.0}';
    expect(jsonEditorText(big)).toBe(big);
    expect(editorStartText("json", { Text: big })).toBe(big);
    // Nothing lost: pretty-printed.
    expect(jsonEditorText('{"a": [1, 2.5, "x"]}')).toBe('{\n  "a": [\n    1,\n    2.5,\n    "x"\n  ]\n}');
    // Numbers inside strings don't count, invalid JSON opens as is.
    expect(jsonEditorText('{"n": "1.0"}')).toBe('{\n  "n": "1.0"\n}');
    expect(jsonEditorText("{nope")).toBe("{nope");
  });

  test("NULL opens empty, so an untouched editor's text is its start", () => {
    expect(editorStartText("text", null)).toBe("");
    expect(editorStartText("text", { Null: null })).toBe("");
    expect(editorStartText("number", { Float: 1.5 })).toBe("1.5");
  });

  test("SQLite's 1 and 0 are a bool column's true and false", () => {
    expect(boolOf({ Int: 1 })).toBe(true);
    expect(boolOf({ Int: 0 })).toBe(false);
    expect(boolOf({ Text: "t" })).toBe(true);
    expect(boolOf({ Text: "f" })).toBe(false);
    expect(boolOf({ Bool: true })).toBe(true);
    expect(boolOf({ Int: 7 })).toBeNull();
    expect(sameValue({ Bool: true }, { Int: 1 }, "bool")).toBe(true);
    expect(sameValue({ Bool: false }, { Int: 0 }, "bool")).toBe(true);
    expect(sameValue({ Bool: false }, { Int: 1 }, "bool")).toBe(false);
    // Staging the value it holds leaves the row unedited.
    const b = stageCell(emptyBuffer("main.flags", "c1"), key(1), "on", { Bool: true }, { Int: 1 }, "bool");
    expect(changeCount(b)).toBe(0);
    const off = stageCell(emptyBuffer("main.flags", "c1"), key(1), "on", { Bool: false }, { Int: 1 }, "bool");
    expect(changeCount(off)).toBe(1);
  });

  test("a float column's value staged back as text is no edit", () => {
    expect(sameValue({ Text: "1.5" }, { Float: 1.5 }, "number")).toBe(true);
    expect(sameValue({ Text: "10.00" }, { Text: "10" }, "number")).toBe(true);
    expect(sameValue({ Text: "1.50" }, { Float: 1.25 }, "number")).toBe(false);
    expect(sameValue({ Int: 3 }, { Text: "3.0" }, "int")).toBe(true);
    // A text column keeps its spelling: "1.0" isn't "1".
    expect(sameValue({ Text: "1.0" }, { Text: "1" }, "text")).toBe(false);
    const b = stageCell(emptyBuffer("db.public.t", "c1"), key(1), "price", { Text: "2.5" }, { Float: 2.5 }, "number");
    expect(changeCount(b)).toBe(0);
  });
});

describe("a commit takes only what it sent", () => {
  test("edits staged while it ran stay, measured from what it wrote", () => {
    let sent = stageCell(emptyBuffer("db.public.kiosks", "c1"), key(1), "name", { Text: "A" }, { Text: "a" });
    sent = addInserts(sent, [{ id: 7, values: { name: { Text: "new" } } }]);
    sent = toggleDeletes(sent, [key(2)]);
    // Meanwhile: row 1 edited again, row 3 edited, one more new row.
    let now = stageCell(sent, key(1), "name", { Text: "B" }, { Text: "a" });
    now = stageCell(now, key(3), "name", { Text: "C" }, { Text: "c" });
    now = addInserts(now, [{ id: 8, values: {} }]);
    const left = withoutCommitted(now, sent)!;
    expect(left.inserts.map((r) => r.id)).toEqual([8]);
    expect(Object.keys(left.deletes)).toEqual([]);
    expect(left.updates[rowKey(key(1))]).toEqual({ key: key(1), set: { name: { Text: "B" } }, was: { name: { Text: "A" } } });
    expect(left.updates[rowKey(key(3))].set.name).toEqual({ Text: "C" });
    // Nothing new: nothing left.
    expect(withoutCommitted(sent, sent)).toBeUndefined();
    expect(withoutCommitted(undefined, sent)).toBeUndefined();
  });
});
