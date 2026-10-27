// The editor's incremental highlighter and statement scanner must agree with
// the whole-text passes (`highlightSqlLines`, `sqlStatementRanges`) after
// every edit. Random edits pile quotes, comments, dollar tags, `;` and
// newlines onto SQL fixtures; each step compares both against a full re-scan.
import { describe, expect, test } from "vitest";
import { createSqlHighlighter, highlightSqlLines } from "../src/sqlHighlight";
import { createStatementScanner, sqlStatementRanges } from "../src/sqlStatements";

/** Small deterministic PRNG (mulberry32), so a failure replays. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXTURES: Record<string, string> = {
  plain: [
    "SELECT id, name, created_at::date AS day",
    "FROM public.users u",
    "WHERE u.id > 10 AND u.name ILIKE 'a%';",
    "",
    "UPDATE t SET x = 1.5e3, y = .25 WHERE t.date IS NULL;",
    "  -- a comment; with a semicolon",
    "select count(*) from orders;",
  ].join("\n"),
  quoting: [
    "select 'it''s; fine' as a, \"col\"\"x\" from `tbl`;",
    "/* multi",
    "   line; comment */ select 2;",
    "select 'open",
    "string; still' , 3;",
    "select \"ident",
    "continues\" from x;",
  ].join("\n"),
  dollar: [
    "CREATE FUNCTION f() RETURNS int AS $$",
    "BEGIN",
    "  RETURN 1; -- inside",
    "END;",
    "$$ LANGUAGE plpgsql;",
    "DO $body$ select ';'; $body$;",
    "select a$$b, $1, $tag$ x",
    "y $tag$ from t;",
  ].join("\n"),
  numbers: [
    "select 1e",
    "5, 2e",
    "x, 3E",
    "+4, 1.e",
    "",
    "7 from t.",
    "date, t.",
    "  select;",
    "é$$ ;",
    "$$ ;",
  ].join("\n"),
  routines: [
    "CREATE TRIGGER rt_note AFTER DELETE ON t BEGIN",
    "  INSERT INTO a VALUES (CASE WHEN old.id > 1 THEN 'x;' END); -- a; note",
    "  UPDATE b SET n = n + 1;",
    "END;",
    "create or replace function f(a int) returns int language sql",
    "begin atomic select 1; select (2); end; begin; select 1; commit;",
    "CREATE TEMP TRIGGER g BEFORE INSERT ON t WHEN (1) BEGIN SELECT 1; END; select 3;",
  ].join("\n"),
};

const TOKENS = [
  "'", "''", '"', "`", "--", "/*", "*/", "$$", "$a$", "$tag$", ";", ";", "\n", "\n", "\n\n",
  " ", "  ", "\t", "\r", "x", "select", "SELECT", "date", ".", "1", "1e", "e", "5", "(", "é", "_",
  "BEGIN", "begin ", " END", "END;", "CASE", "ATOMIC", "CREATE ", "TRIGGER ", " t ", ")", "FUNCTION", "[", "x.",
];

function check(text: string, hl: ReturnType<typeof createSqlHighlighter>, st: ReturnType<typeof createStatementScanner>) {
  expect(hl.update(text)).toEqual(highlightSqlLines(text));
  expect(st.update(text)).toEqual(sqlStatementRanges(text));
}

describe("incremental tokenizing matches a full re-scan", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const seed of [1, 2, 3, 4, 5]) {
      test(`${name}, seed ${seed}`, () => {
        const rand = rng(seed * 7919 + name.length);
        const hl = createSqlHighlighter();
        const st = createStatementScanner();
        let text = fixture;
        check(text, hl, st);
        for (let step = 0; step < 300; step++) {
          const at = Math.floor(rand() * (text.length + 1));
          const roll = rand();
          if (roll < 0.55 || text.length === 0) {
            const tok = TOKENS[Math.floor(rand() * TOKENS.length)];
            text = text.slice(0, at) + tok + text.slice(at);
          } else if (roll < 0.9) {
            const len = 1 + Math.floor(rand() * 4);
            text = text.slice(0, at) + text.slice(at + len);
          } else {
            // Paste a chunk of another fixture, or (rarely) replace everything.
            const other = Object.values(FIXTURES)[Math.floor(rand() * Object.keys(FIXTURES).length)];
            const a = Math.floor(rand() * other.length);
            const chunk = other.slice(a, a + Math.floor(rand() * 60));
            text = roll < 0.98 ? text.slice(0, at) + chunk + text.slice(at) : chunk;
          }
          check(text, hl, st);
        }
      });
    }
  }

  test("typing and undoing a quote, comment and dollar tag at the top of a long text", () => {
    const base = Array.from(
      { length: 400 },
      (_, i) => `SELECT id, 'row ${i}' AS label FROM t_${i} WHERE id > ${i}; -- line ${i}`,
    ).join("\n");
    const hl = createSqlHighlighter();
    const st = createStatementScanner();
    check(base, hl, st);
    const at = base.indexOf("\n") + 8;
    for (const tok of ["'", "/*", "$$", "$x$", '"', ";", "\n"]) {
      check(base.slice(0, at) + tok + base.slice(at), hl, st);
      check(base, hl, st);
    }
  });

  test("an unchanged text returns the cached arrays", () => {
    const hl = createSqlHighlighter();
    const st = createStatementScanner();
    const text = FIXTURES.plain;
    const lines = hl.update(text);
    const ranges = st.update(text);
    expect(hl.update(text)).toBe(lines);
    expect(st.update(text)).toBe(ranges);
    expect(hl.update("")).toEqual([""]);
    expect(st.update("")).toEqual([]);
  });
});
