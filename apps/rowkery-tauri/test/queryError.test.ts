import { describe, expect, it } from "vitest";
import { levenshtein, nearestName, positionToOffset, quotedName, rawErrorLines, tokenAt } from "../src/queryError";

describe("queryError", () => {
  it("maps the server's character position to a UTF-16 offset", () => {
    expect(positionToOffset("SELECT nmae", 8)).toBe(7);
    // An emoji is one character to the server, two UTF-16 units here.
    const sql = "SELECT '😀', nmae";
    expect(sql.slice(positionToOffset(sql, 13))).toBe("nmae");
  });

  it("finds the token there", () => {
    const sql = "SELECT id, nmae FROM kiosks";
    expect(sql.slice(tokenAt(sql, 11).start, tokenAt(sql, 11).end)).toBe("nmae");
    expect(sql.slice(tokenAt(sql, 13).start, tokenAt(sql, 13).end)).toBe("nmae");
    const q = 'SELECT "Nmae" FROM t';
    const r = tokenAt(q, 7);
    expect(q.slice(r.start, r.end)).toBe('"Nmae"');
    expect(tokenAt("a + b", 2)).toEqual({ start: 2, end: 3 });
  });

  it("reads the quoted name and suggests the nearest within two edits", () => {
    expect(quotedName('column "nmae" does not exist')).toBe("nmae");
    expect(quotedName('relation "public.kiosk" does not exist')).toBe("kiosk");
    expect(levenshtein("nmae", "name")).toBe(2);
    expect(nearestName("nmae", ["id", "name", "city"])).toBe("name");
    expect(nearestName("kiosk", ["kiosks", "players"])).toBe("kiosks");
    expect(nearestName("Kiosk", ["kiosks"])).toBe("kiosks");
    expect(nearestName("zzzz", ["name", "id"])).toBeNull();
  });

  it("prints the raw error like psql", () => {
    expect(rawErrorLines('column "nmae" does not exist', "SELECT id,\n  nmae FROM kiosks;", 14)).toEqual([
      'ERROR:  column "nmae" does not exist',
      "LINE 2:   nmae FROM kiosks;",
      "          ^",
    ]);
    expect(rawErrorLines("boom", null, null)).toEqual(["ERROR:  boom"]);
  });
});
