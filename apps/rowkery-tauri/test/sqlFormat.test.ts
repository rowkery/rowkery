// Format SQL (⌘I, sqlFormat.ts): what it covers, and that it only moves
// whitespace and keyword case, never what's inside strings, comments or bodies.
import { describe, expect, test } from "vitest";
import { formatSql, formatTarget } from "../src/sqlFormat";

const THREE = "select 1;\nselect a,b from t where x = 'y';\nselect 3";
const slice = (text: string, r: { start: number; end: number } | null) => (r ? text.slice(r.start, r.end) : null);

describe("what ⌘I formats", () => {
  test("the caret's statement only", () => {
    const at = THREE.indexOf("a,b");
    expect(slice(THREE, formatTarget(THREE, at, at))).toBe("select a,b from t where x = 'y';");
  });

  test("a selection inside one statement takes all of it", () => {
    const at = THREE.indexOf("from");
    expect(slice(THREE, formatTarget(THREE, at, at + 4))).toBe("select a,b from t where x = 'y';");
  });

  test("a selection over two statements takes both, whole", () => {
    const a = THREE.indexOf("1;");
    const b = THREE.indexOf("where");
    expect(slice(THREE, formatTarget(THREE, b, a))).toBe("select 1;\nselect a,b from t where x = 'y';");
  });

  test("select all takes every statement", () => {
    expect(slice(THREE, formatTarget(THREE, 0, THREE.length))).toBe(THREE);
  });

  test("a selection of only blank lines, or no SQL, formats nothing", () => {
    const text = "select 1;\n\n\nselect 2";
    expect(formatTarget(text, 10, 11)).toBeNull();
    expect(formatTarget("  \n", 1, 1)).toBeNull();
  });
});

describe("formatSql", () => {
  const pg = async (sql: string) => {
    const done = await formatSql(sql, { start: 0, end: sql.length }, "postgresql");
    if (!done.ok) throw new Error(done.error);
    return done.sql;
  };

  test("tabular, keywords upper, functions lower", async () => {
    expect(await pg("select u.id, COUNT(*) as n from users u join orders o on o.user_id = u.id where u.id > 1 order by n desc;")).toBe(
      [
        "SELECT    u.id,",
        "          count(*) AS n",
        "FROM      users u",
        "JOIN      orders o ON o.user_id = u.id",
        "WHERE     u.id > 1",
        "ORDER BY  n DESC;",
      ].join("\n"),
    );
  });

  test("strings, quoted names and comments come back as written", async () => {
    const out = await pg(`select 'it''s -- not; a comment', "Mixed Case" from t -- keep  this\n/* and   this */ where a = 1`);
    expect(out).toContain("'it''s -- not; a comment'");
    expect(out).toContain('"Mixed Case"');
    expect(out).toContain("-- keep  this");
    expect(out).toContain("/* and   this */");
  });

  test("a $$ body is left alone", async () => {
    const body = "$$ select   1 ;  begin  end $$";
    expect(await pg(`create function f() returns int as ${body} language sql;`)).toContain(body);
    expect(await pg("do $tag$ begin  perform 1; end $tag$;")).toContain("$tag$ begin  perform 1; end $tag$");
  });

  test("only the range is formatted, and an error names the editor's line", async () => {
    const text = "select 1;\n\nselect from where );";
    const start = text.indexOf("select from");
    const done = await formatSql(text, { start, end: text.length }, "postgresql");
    expect(done).toEqual({ ok: false, error: 'Unexpected ")" on line 3' });
  });

  test("SQLite's dialect", async () => {
    const sql = "select json_extract(data, '$.a') from t";
    const done = await formatSql(sql, { start: 0, end: sql.length }, "sqlite");
    expect(done).toEqual({ ok: true, sql: "SELECT    json_extract(data, '$.a')\nFROM      t" });
  });
});
