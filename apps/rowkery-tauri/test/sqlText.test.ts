// Statement ranges (`sqlStatements.ts`) and editor colours (`sqlHighlight.ts`)
// read quotes, comments and dollar bodies the same way: one shared fixture.
import { describe, expect, test } from "vitest";
import { quotedEnd, sqlStatementRanges, sqlToRun, statementRangeAtOffset } from "../src/sqlStatements";
import { highlightSqlLines, lineAtOffset, lineStartOffsets } from "../src/sqlHighlight";

const texts = (sql: string) => sqlStatementRanges(sql).map((r) => sql.slice(r.start, r.end));

/** Each fixture: SQL, the statements it splits into, and its string spans. */
const QUOTING: { name: string; sql: string; statements: string[]; strings: string[] }[] = [
  {
    name: "doubled single quote",
    sql: "select 'it''s; fine' as a; select 2",
    statements: ["select 'it''s; fine' as a;", "select 2"],
    strings: ["'it''s; fine'"],
  },
  {
    name: "doubled quote at the very end of the literal",
    sql: "select ''''; select 'x'",
    statements: ["select '''';", "select 'x'"],
    strings: ["''''", "'x'"],
  },
  {
    name: "empty string",
    sql: "select ''; select 1",
    statements: ["select '';", "select 1"],
    strings: ["''"],
  },
  {
    name: "doubled double quote in an identifier",
    sql: 'select "a"";b" from t; select 1',
    statements: ['select "a"";b" from t;', "select 1"],
    strings: [],
  },
  {
    name: "line and block comments",
    sql: "select 1 -- not; here\n; /* nor; here */ select 2",
    statements: ["select 1 -- not; here\n;", "/* nor; here */ select 2"],
    strings: [],
  },
  {
    name: "dollar-quoted body",
    sql: "create function f() returns int as $body$ select 1; $body$ language sql; select 3",
    statements: [
      "create function f() returns int as $body$ select 1; $body$ language sql;",
      "select 3",
    ],
    strings: ["$body$ select 1; $body$"],
  },
  {
    name: "unclosed string runs to the end",
    sql: "select 'abc; select 2",
    statements: ["select 'abc; select 2"],
    strings: ["'abc; select 2"],
  },
];

/** Text of every `s` span, joined across lines. */
function stringSpans(sql: string): string[] {
  const html = highlightSqlLines(sql).join("\n");
  const out: string[] = [];
  const re = /<span class="s">([^<]*)<\/span>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }
  return out;
}

describe("shared quoting fixture", () => {
  for (const f of QUOTING) {
    test(`statements: ${f.name}`, () => {
      expect(texts(f.sql)).toEqual(f.statements);
    });
    test(`highlight: ${f.name}`, () => {
      expect(stringSpans(f.sql)).toEqual(f.strings);
    });
  }
});

describe("quotedEnd", () => {
  test("skips doubled quotes and stops after the closing one", () => {
    expect(quotedEnd("'it''s' x", 0)).toBe(7);
    expect(quotedEnd('"a""b".c', 0)).toBe(6);
  });
  test("unclosed runs to the end", () => {
    expect(quotedEnd("'abc", 0)).toBe(4);
    expect(quotedEnd("'it''", 0)).toBe(5);
  });
});

describe("sqlStatementRanges", () => {
  test("trims whitespace and drops bare semicolons", () => {
    expect(texts("  select 1 ;;\n\n ; select 2  ")).toEqual(["select 1 ;", "select 2"]);
  });
  test("empty text has no statements", () => {
    expect(texts("   \n ")).toEqual([]);
  });
});

describe("statement at the caret", () => {
  const sql = "select 1;\nselect 2;   \n\nselect 3";
  test("inside a statement picks it", () => {
    expect(sqlToRun(sql, 13, 13)).toBe("select 2;");
  });
  test("trailing whitespace on the same line picks the statement before", () => {
    expect(sqlToRun(sql, 21, 21)).toBe("select 2;");
  });
  test("a blank line picks the next statement", () => {
    expect(sqlToRun(sql, 23, 23)).toBe("select 3");
  });
  test("a selection wins over the caret", () => {
    expect(sqlToRun(sql, 0, 6)).toBe("select");
  });
  test("no SQL gives null", () => {
    expect(statementRangeAtOffset("  ", 1)).toBeNull();
  });
});

describe("highlightSqlLines", () => {
  test("one HTML string per line, classes by token", () => {
    const lines = highlightSqlLines("SELECT count(*), 1.5e3, $1\nFROM t -- note");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('<span class="k">SELECT</span>');
    expect(lines[0]).toContain('<span class="f">count</span>');
    expect(lines[0]).toContain('<span class="n">1.5e3</span>');
    expect(lines[0]).toContain('<span class="n">$1</span>');
    expect(lines[1]).toContain('<span class="c">-- note</span>');
  });
  test("a column after a dot is not a keyword", () => {
    expect(highlightSqlLines("select t.date from t")[0]).not.toContain('<span class="k">date</span>');
  });
  test("escapes HTML", () => {
    expect(highlightSqlLines("select '<b>' & 1")[0]).toContain("&lt;b&gt;");
  });
  test("a string over two lines colours both halves", () => {
    const lines = highlightSqlLines("select 'a\nb'");
    expect(lines[0]).toContain('<span class="s">\'a</span>');
    expect(lines[1]).toContain('<span class="s">b\'</span>');
  });
  test("line offsets", () => {
    const starts = lineStartOffsets("ab\ncd\n\ne");
    expect(starts).toEqual([0, 3, 6, 7]);
    expect(lineAtOffset(starts, 4)).toBe(1);
    expect(lineAtOffset(starts, 7)).toBe(3);
  });
});
