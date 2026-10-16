// The webview's frame decoder reads the same golden bytes rowkery-core writes
// (crates/rowkery-core/tests/frames, `cargo test -p rowkery-core frames`).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ResultRows, decodeFrame } from "../src/resultStore";
import { columnProfiles, summarizeRows } from "../src/columnProfile";
import type { Value } from "../src/types";

const dir = fileURLToPath(new URL("../../../crates/rowkery-core/tests/frames/", import.meta.url));
const bin = readFileSync(`${dir}golden.bin`);
const golden = JSON.parse(readFileSync(`${dir}golden.json`, "utf8"));
const buffer = () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;

/** The golden spelling of a cell (floats as JS strings, NULL as null). */
function spell(v: Value): unknown {
  if ("Null" in v) return null;
  if ("Float" in v) return { Float: String(v.Float) };
  return v;
}

describe("binary rows frames", () => {
  test("the header", () => {
    const h = decodeFrame(buffer(), () => {});
    expect(h).toEqual({ queryId: golden.query_id, seq: golden.seq, last: golden.last, sentAtMs: golden.sent_at_ms, rows: golden.rows.length });
  });

  test("every cell decodes to what Rust encoded", () => {
    const rows = new ResultRows();
    rows.appendFrame(buffer());
    expect(rows.length).toBe(golden.rows.length);
    const ncols = golden.kinds.length;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < ncols; c++) {
        expect(spell(rows.get(r, c)), `${r},${c}`).toEqual(golden.rows[r][c]);
        expect(rows.isNull(r, c)).toBe(golden.rows[r][c] === null);
      }
    }
  });

  test("text is what the grid prints", () => {
    const rows = new ResultRows();
    rows.appendFrame(buffer());
    expect(rows.text(0, 2)).toBe("9223372036854775807");
    expect(rows.text(0, 4)).toBe("12345.678");
    expect(rows.text(0, 7)).toBe("<20 bytes>");
    expect(rows.text(1, 0)).toBe("");
    expect(rows.text(2, 3)).toBe("NaN");
    expect(rows.text(1, 8)).toBe("text"); // a mixed column's text cell
    expect(rows.number(3, 8)).toBe(2.25);
    expect(rows.number(1, 1)).toBeNull();
    expect(rows.isNumber(0, 2)).toBe(true);
    expect(rows.isBool(0, 0)).toBe(true);
  });

  test("a frame at an odd offset still decodes (typed arrays need alignment)", () => {
    const padded = new Uint8Array(bin.byteLength + 1);
    padded.set(bin, 1);
    const shifted = padded.slice(1).buffer;
    const rows = new ResultRows();
    rows.appendFrame(shifted);
    expect(spell(rows.get(3, 3))).toEqual({ Float: "-Infinity" });
  });

  test("not a frame", () => {
    expect(() => new ResultRows().appendFrame(new Uint8Array(40).buffer)).toThrow("INL1");
  });
});

describe("profiles in the frame that completes the sample", () => {
  const pbin = readFileSync(`${dir}golden-profile.bin`);
  const pgolden = JSON.parse(readFileSync(`${dir}golden-profile.json`, "utf8"));
  const pbuffer = () => pbin.buffer.slice(pbin.byteOffset, pbin.byteOffset + pbin.byteLength) as ArrayBuffer;

  test("decode to what profile.rs computed", () => {
    const h = decodeFrame(pbuffer(), () => {});
    expect(h.rows).toBe(golden.rows.length);
    expect(h.profiles).toEqual(pgolden);
    // A frame without them has none.
    expect(decodeFrame(buffer(), () => {}).profiles).toBeUndefined();
  });

  test("land on the rows, which notify, and the header draws them", () => {
    const rows = new ResultRows();
    const v0 = rows.getVersion();
    rows.appendFrame(pbuffer());
    expect(rows.getVersion()).toBeGreaterThan(v0 + 1);
    expect(rows.profiles).toEqual(pgolden);
    const columns = golden.kinds.map((_: number, i: number) => ({ name: `c${i}`, type_name: "" }));
    const drawn = columnProfiles(columns, rows);
    expect(drawn[0]).toMatchObject({ kind: "split", top: "true" }); // bool
    expect(drawn[1]?.kind).toBe("hist"); // int4
    expect(drawn[7]).toBeNull(); // bytea
  });

  test("the webview's summary of the same rows matches core's", () => {
    // `summarizeRows` stands in for core on rows built here; same rules, same numbers.
    const types = ["bool", "int4", "int8", "float8", "numeric", "text", "jsonb", "bytea", ""];
    const rows = new ResultRows();
    rows.appendFrame(buffer());
    const columns = types.map((type_name, i) => ({ name: `c${i}`, type_name }));
    expect(summarizeRows(columns, rows)).toEqual(pgolden);
  });
});

describe("ResultRows", () => {
  test("chunks append; reads find their chunk", () => {
    const rows = new ResultRows();
    rows.appendFrame(buffer());
    rows.appendValues([[{ Int: 1 }], [{ Null: null }]]);
    rows.appendFrame(buffer());
    expect(rows.length).toBe(golden.rows.length * 2 + 2);
    expect(rows.get(golden.rows.length, 0)).toEqual({ Int: 1 });
    expect(rows.isNull(golden.rows.length + 1, 0)).toBe(true);
    expect(rows.text(golden.rows.length + 2, 5)).toBe("it's ünïcode");
    // Random access after sequential access.
    expect(rows.text(0, 5)).toBe("it's ünïcode");
  });

  test("a next page shares its chunks", () => {
    const a = ResultRows.fromValues([[{ Int: 1 }]]);
    const b = ResultRows.fromValues([[{ Int: 2 }], [{ Int: 3 }]]);
    a.appendRows(b);
    expect(a.length).toBe(3);
    expect(a.text(2, 0)).toBe("3");
  });

  test("version bumps on every append", () => {
    const rows = new ResultRows();
    const v0 = rows.getVersion();
    rows.appendValues([[{ Int: 1 }]]);
    expect(rows.getVersion()).toBeGreaterThan(v0);
  });
});
