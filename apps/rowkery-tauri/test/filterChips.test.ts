import { describe, expect, test } from "vitest";
import {
  FILTER_OPS,
  chipIdent,
  isNumberType,
  joinList,
  splitList,
  chipFragments,
  chipsFromFilter,
  chipsToWhere,
  parseFragment,
  renameFragmentColumn,
  savedChips,
  textColumns,
  unknownColumn,
  type FilterChip,
  type FilterOp,
} from "../src/filterChips";
import { sqlLineParts } from "../src/sqlLineParts";

const pred = (column: string, type: string, op: FilterOp, value = "", value2?: string): FilterChip => ({
  kind: "pred",
  column,
  type,
  op,
  value,
  value2,
});

const COLUMNS = [
  { name: "id", type_name: "int8" },
  { name: "amount", type_name: "numeric" },
  { name: "status", type_name: "text" },
  { name: "name", type_name: "varchar(80)" },
  { name: "note", type_name: "text" },
  { name: "active", type_name: "bool" },
  { name: "created_at", type_name: "timestamptz" },
  { name: "Order", type_name: "int4" },
];

describe("chipsToWhere", () => {
  test.each<[FilterOp, FilterChip, string]>([
    ["=", pred("status", "text", "=", "pending"), "status = 'pending'"],
    ["<>", pred("kiosk_id", "int4", "<>", "7"), "kiosk_id <> 7"],
    ["IS DISTINCT FROM", pred("status", "text", "IS DISTINCT FROM", "paid"), "status IS DISTINCT FROM 'paid'"],
    [">", pred("amount", "numeric", ">", "100"), "amount > 100"],
    ["<", pred("amount", "numeric", "<", "-2.5"), "amount < -2.5"],
    [">=", pred("created_at", "timestamptz", ">=", "2026-10-01"), "created_at >= '2026-10-01'"],
    ["<=", pred("amount", "numeric", "<=", "1e3"), "amount <= 1e3"],
    ["ILIKE", pred("name", "text", "ILIKE", "kiosk"), "name ILIKE '%kiosk%'"],
    ["IN", pred("status", "text", "IN", "pending, 'settled'"), "status IN ('pending', 'settled')"],
    ["BETWEEN", pred("amount", "numeric", "BETWEEN", "50", "200"), "amount BETWEEN 50 AND 200"],
    ["IS NULL", pred("note", "text", "IS NULL"), "note IS NULL"],
    ["IS NOT NULL", pred("note", "text", "IS NOT NULL"), "note IS NOT NULL"],
  ])("%s", (_op, chip, sql) => {
    expect(chipsToWhere([chip])).toBe(sql);
  });

  test("every operator in the picker has a fixture above", () => {
    expect(FILTER_OPS.map((o) => o.op)).toEqual(["=", "<>", "IS DISTINCT FROM", ">", "<", ">=", "<=", "ILIKE", "IN", "BETWEEN", "IS NULL", "IS NOT NULL"]);
  });

  test("NULL goes through IS NULL, never = NULL", () => {
    expect(chipsToWhere([pred("note", "text", "=", "NULL")])).toBe("note IS NULL");
    expect(chipsToWhere([pred("note", "text", "<>", "null")])).toBe("note IS NOT NULL");
  });

  test("a quoted 'null' is the text, a bare null is NULL (rowkery/reports#44)", () => {
    expect(chipsToWhere([pred("note", "text", "=", "'null'")])).toBe("note = 'null'");
    expect(chipsToWhere([pred("note", "text", "IS DISTINCT FROM", "'NULL'")])).toBe("note IS DISTINCT FROM 'NULL'");
    expect(chipsToWhere([pred("note", "text", "IN", "'null', a")])).toBe("note IN ('null', 'a')");
    expect(chipsToWhere([pred("note", "text", "IN", "null")])).toBe("note IN (NULL)");
    expect(parseFragment("note = 'null'", COLUMNS)).toMatchObject({ op: "=", value: "'null'" });
    expect(parseFragment("note = null", COLUMNS)).toMatchObject({ op: "=", value: "null" });
    expect(parseFragment("note in ('null', 'x')", COLUMNS)).toMatchObject({ op: "IN", value: "'null', x" });
    expect(splitList(joinList(["'null'", "a, b"]))).toEqual(["'null'", "a, b"]);
  });

  test("contains on a non-text column searches its text on Postgres (rowkery/reports#56)", () => {
    expect(chipsToWhere([pred("id", "integer", "ILIKE", "2024")])).toBe("CAST(id AS TEXT) ILIKE '%2024%'");
    expect(chipsToWhere([pred("at", "timestamp with time zone", "ILIKE", "2024")])).toBe("CAST(at AS TEXT) ILIKE '%2024%'");
    expect(chipsToWhere([pred("note", "text", "ILIKE", "a")])).toBe("note ILIKE '%a%'");
    expect(chipsToWhere([pred("id", "INTEGER", "ILIKE", "20")], "sqlite")).toBe("id LIKE '%20%'");
  });

  test("quotes are doubled", () => {
    expect(chipsToWhere([pred("note", "text", "=", "it's")])).toBe("note = 'it''s'");
    expect(chipsToWhere([pred("note", "text", "ILIKE", "it's")])).toBe("note ILIKE '%it''s%'");
    expect(chipsToWhere([{ kind: "any", columns: ["name"], value: "o'brien" }])).toBe("name ILIKE '%o''brien%'");
  });

  test("numbers and booleans are bare only on number and boolean columns", () => {
    expect(chipsToWhere([pred("amount", "numeric", "=", "100")])).toBe("amount = 100");
    expect(chipsToWhere([pred("code", "text", "=", "100")])).toBe("code = '100'");
    expect(chipsToWhere([pred("amount", "numeric", "=", "abc")])).toBe("amount = 'abc'");
    expect(chipsToWhere([pred("active", "bool", "=", "true")])).toBe("active = TRUE");
    expect(chipsToWhere([pred("label", "text", "=", "true")])).toBe("label = 'true'");
  });

  test("identifiers are quoted only when they need it", () => {
    expect(chipsToWhere([pred("Order", "int4", "=", "1")])).toBe('"Order" = 1');
    expect(chipsToWhere([pred("user", "text", "IS NULL")])).toBe('"user" IS NULL');
  });

  test("any text column is an ILIKE chain over the text columns, shown honestly", () => {
    const any: FilterChip = { kind: "any", columns: textColumns(COLUMNS), value: "bangsar" };
    // Alone, core's WHERE (…) brackets it: WHERE (status ILIKE … OR note ILIKE …).
    expect(chipsToWhere([any])).toBe("status ILIKE '%bangsar%' OR name ILIKE '%bangsar%' OR note ILIKE '%bangsar%'");
    // With another chip it carries its own brackets.
    expect(chipsToWhere([any, pred("amount", "numeric", ">", "1")])).toBe(
      "(status ILIKE '%bangsar%' OR name ILIKE '%bangsar%' OR note ILIKE '%bangsar%') AND amount > 1",
    );
    // SQLite has no ILIKE; its LIKE ignores ASCII case.
    expect(chipsToWhere([any], "sqlite")).toBe("status LIKE '%bangsar%' OR name LIKE '%bangsar%' OR note LIKE '%bangsar%'");
  });

  test("an expression chip passes through untouched", () => {
    const sql = "created_at > now() - interval '1 day'";
    expect(chipsToWhere([{ kind: "expr", sql }])).toBe(sql);
    expect(chipsToWhere([{ kind: "expr", sql: "a = 1 OR b = 2" }])).toBe("a = 1 OR b = 2");
    // Joined with others, a top-level OR keeps its meaning.
    expect(chipsToWhere([{ kind: "expr", sql: "a = 1 OR b = 2" }, pred("amount", "numeric", ">", "5")])).toBe(
      "(a = 1 OR b = 2) AND amount > 5",
    );
    expect(chipsToWhere([{ kind: "expr", sql: sql }, pred("amount", "numeric", ">", "5")])).toBe(
      `${sql} AND amount > 5`,
    );
  });

  test("chips join with AND in clause order", () => {
    expect(chipsToWhere([pred("status", "text", "=", "pending"), pred("amount", "numeric", ">", "100")])).toBe(
      "status = 'pending' AND amount > 100",
    );
    expect(chipsToWhere([])).toBe("");
  });

  test("a tab saved before chips keeps its filter as one expression chip", () => {
    expect(chipsToWhere(chipsFromFilter("status = 'x' or id = 1"))).toBe("status = 'x' or id = 1");
    expect(chipsFromFilter("")).toEqual([]);
  });

  test("the line shows the chips' WHERE text, and round-trips", () => {
    const chips = [pred("status", "text", "=", "pending"), pred("amount", "numeric", ">", "100")];
    const where = chipsToWhere(chips);
    const sql = `SELECT * FROM public.wallet_tx\nWHERE (${where})\nORDER BY id\nLIMIT 1000;`;
    const p = sqlLineParts(sql, where);
    expect(p.where).toBe(where);
    expect(chipFragments(chips).join(" AND ")).toBe(p.where);
  });

  test("saved chips are checked on the way in", () => {
    expect(savedChips([{ kind: "expr", sql: "x" }, { kind: "pred", column: "a", type: "int", op: "nope", value: "" }, null])).toEqual([
      { kind: "expr", sql: "x" },
    ]);
    expect(savedChips("x")).toBeUndefined();
  });
});

describe("parseFragment", () => {
  test("a bare col op value is a chip", () => {
    expect(parseFragment("amount > 100", COLUMNS)).toEqual(pred("amount", "numeric", ">", "100"));
    expect(parseFragment("status = pending", COLUMNS)).toMatchObject({ column: "status", op: "=", value: "pending" });
    expect(parseFragment("status = 'it''s'", COLUMNS)).toMatchObject({ value: "it's" });
    expect(parseFragment("note is null", COLUMNS)).toMatchObject({ op: "IS NULL" });
    expect(parseFragment("STATUS in (a, b)", COLUMNS)).toMatchObject({ column: "status", op: "IN", value: "a, b" });
    expect(parseFragment("amount between 50 and 200", COLUMNS)).toMatchObject({ op: "BETWEEN", value: "50", value2: "200" });
    expect(parseFragment(`"Order" != 3`, COLUMNS)).toMatchObject({ column: "Order", op: "<>", value: "3" });
  });

  test("anything else that is SQL becomes an expression chip", () => {
    const sql = "created_at > now() - interval '1 day'";
    expect(parseFragment(sql, COLUMNS)).toEqual({ kind: "expr", sql });
    expect(parseFragment("missing = 1", COLUMNS)).toEqual({ kind: "expr", sql: "missing = 1" });
    expect(parseFragment("amount > 1 or id < 5", COLUMNS)).toEqual({ kind: "expr", sql: "amount > 1 or id < 5" });
  });

  test("a plain value is left to the chosen column and operator", () => {
    expect(parseFragment("bangsar", COLUMNS)).toBeNull();
    expect(parseFragment("rock and roll", COLUMNS)).toBeNull();
    expect(parseFragment("it's", COLUMNS)).toBeNull();
  });
});

describe("review fixes", () => {
  // A plain value holding "in" (or another word operator) is a value, not SQL.
  test.each(["pending", "admin", "Berlin", "shipping", "Singapore", "admin@x.com", "linking", "isnull", "between"])(
    "%s is a plain value",
    (v) => {
      expect(parseFragment(v, COLUMNS)).toBeNull();
    },
  );

  test("word operators need space around them; symbols don't", () => {
    expect(parseFragment("status in (a, b)", COLUMNS)).toMatchObject({ op: "IN", value: "a, b" });
    expect(parseFragment("status in(a, b)", COLUMNS)).toMatchObject({ op: "IN", value: "a, b" });
    expect(parseFragment("amount>5", COLUMNS)).toMatchObject({ op: ">", value: "5" });
    expect(parseFragment("note is null", COLUMNS)).toMatchObject({ op: "IS NULL" });
    expect(parseFragment("status ilike '%x%'", COLUMNS)).toMatchObject({ op: "ILIKE", value: "x" });
    // An unknown column with a word operator is a value; with a symbol it is SQL.
    expect(parseFragment("rock in roll", COLUMNS)).toBeNull();
    expect(parseFragment("missing = 1", COLUMNS)).toEqual({ kind: "expr", sql: "missing = 1" });
    // A LIKE pattern of the user's own is SQL, kept as typed.
    expect(parseFragment("status like 'a%'", COLUMNS)).toEqual({ kind: "expr", sql: "status like 'a%'" });
    expect(parseFragment("status ilike 'a%'", COLUMNS)).toEqual({ kind: "expr", sql: "status ilike 'a%'" });
  });

  // "Hide rows where col = v" keeps the NULL rows.
  test("IS DISTINCT FROM: Postgres says so, SQLite says IS NOT", () => {
    const hide = pred("status", "text", "IS DISTINCT FROM", "paid");
    expect(chipsToWhere([hide])).toBe("status IS DISTINCT FROM 'paid'");
    expect(chipsToWhere([hide], "sqlite")).toBe("status IS NOT 'paid'");
    expect(chipsToWhere([pred("kiosk_id", "int4", "IS DISTINCT FROM", "2")])).toBe("kiosk_id IS DISTINCT FROM 2");
    expect(chipsToWhere([pred("note", "text", "IS DISTINCT FROM", "NULL")])).toBe("note IS NOT NULL");
    // <> typed by hand stays <> (it drops NULLs, as the picker's gloss says).
    expect(chipsToWhere([pred("status", "text", "<>", "paid")])).toBe("status <> 'paid'");
    expect(FILTER_OPS.find((o) => o.op === "<>")?.gloss).toMatch(/empty/);
    // Both spellings read back as the chip.
    expect(parseFragment("status is distinct from 'paid'", COLUMNS)).toMatchObject({ op: "IS DISTINCT FROM", value: "paid" });
    expect(parseFragment("status IS NOT 'paid'", COLUMNS)).toMatchObject({ op: "IS DISTINCT FROM", value: "paid" });
    expect(savedChips([hide])).toEqual([hide]);
  });

  // Contains matches the value literally.
  // On Postgres the escaped pattern and its ESCAPE are E'' strings, which
  // read the same with standard_conforming_strings on or off.
  test("contains escapes \\ % _ and says ESCAPE", () => {
    expect(chipsToWhere([pred("note", "text", "ILIKE", "it's a \\")])).toBe("note ILIKE E'%it''s a \\\\\\\\%' ESCAPE E'\\\\'");
    expect(chipsToWhere([pred("name", "text", "ILIKE", "user_name")])).toBe("name ILIKE E'%user\\\\_name%' ESCAPE E'\\\\'");
    expect(chipsToWhere([pred("name", "text", "ILIKE", "50%")], "sqlite")).toBe("name LIKE '%50\\%%' ESCAPE '\\'");
    expect(chipsToWhere([pred("note", "text", "ILIKE", "it's a \\")], "sqlite")).toBe("note LIKE '%it''s a \\\\%' ESCAPE '\\'");
    expect(chipsToWhere([{ kind: "any", columns: ["note"], value: "a_b" }])).toBe("note ILIKE E'%a\\\\_b%' ESCAPE E'\\\\'");
    // A plain value reads plainly.
    expect(chipsToWhere([pred("name", "text", "ILIKE", "kiosk")])).toBe("name ILIKE '%kiosk%'");
  });

  test("contains chips round-trip through the line", () => {
    for (const engine of ["postgres", "sqlite"] as const) {
      for (const v of ["it's a \\", "user_name", "50%", "plain", "a\\_b", "x y"]) {
        const sql = chipsToWhere([pred("note", "text", "ILIKE", v)], engine).replace(/^note LIKE /, "note ILIKE ");
        expect(parseFragment(sql, COLUMNS), sql).toEqual(pred("note", "text", "ILIKE", v));
      }
    }
  });

  // A key value with a backslash can't end its literal on a Postgres server
  // with standard_conforming_strings off (following a key builds this chip).
  test("a value with a backslash is an E'' literal on Postgres", () => {
    const breakout = "\\' OR TRUE --";
    expect(chipsToWhere([pred("name", "text", "=", breakout)])).toBe("name = E'\\\\'' OR TRUE --'");
    expect(chipsToWhere([pred("name", "text", "=", "C:\\tmp")])).toBe("name = E'C:\\\\tmp'");
    expect(chipsToWhere([pred("name", "text", "IN", "a\\b, c")])).toBe("name IN (E'a\\\\b', 'c')");
    // Without a backslash, and on SQLite (no escapes in strings), plain quotes.
    expect(chipsToWhere([pred("name", "text", "=", "it's")])).toBe("name = 'it''s'");
    expect(chipsToWhere([pred("name", "text", "=", breakout)], "sqlite")).toBe("name = '\\'' OR TRUE --'");
    // IN's chip text keeps plain quotes: it is read back by splitList, not run.
    expect(joinList(["a, b\\"])).toBe("'a, b\\'");
  });

  // IN lists with apostrophes and quoted commas.
  test("IN: a quote opens a string only at an item's start", () => {
    expect(splitList("O'Brien, Smith")).toEqual(["O'Brien", "Smith"]);
    expect(splitList("'a, b', 'c'")).toEqual(["a, b", "c"]);
    expect(splitList("'it''s', x")).toEqual(["it's", "x"]);
    expect(chipsToWhere([pred("name", "text", "IN", "O'Brien, Smith")])).toBe("name IN ('O''Brien', 'Smith')");
    expect(chipsToWhere([pred("name", "text", "IN", "'a, b', 'c'")])).toBe("name IN ('a, b', 'c')");
  });

  test("IN: values re-join so they split the same way", () => {
    const chip = parseFragment("name in ('a, b', 'c', 'O''Brien')", COLUMNS);
    expect(chip).toMatchObject({ op: "IN", value: "'a, b', c, O'Brien" });
    expect(chipsToWhere([chip!])).toBe("name IN ('a, b', 'c', 'O''Brien')");
    for (const items of [["a, b", "c"], ["O'Brien", "Smith"], ["'quoted'", "x"]]) expect(splitList(joinList(items))).toEqual(items);
  });

  // Reserved words are quoted the way core quotes them.
  test.each([
    "current_date", "current_time", "current_timestamp", "current_user", "session_user", "localtime", "localtimestamp",
    "left", "right", "full", "inner", "cross", "natural", "both", "leading", "trailing", "collate", "similar", "ilike",
    "isnull", "notnull", "verbose", "lateral", "returning", "user", "order",
  ])("%s is quoted", (name) => {
    expect(chipIdent(name)).toBe(`"${name}"`);
  });

  test("plain names stay bare", () => {
    expect(chipIdent("wallet_tx")).toBe("wallet_tx");
    expect(chipIdent("status")).toBe("status");
    expect(chipIdent("Order")).toBe('"Order"');
  });

  // interval is not a number.
  test("number types, never interval", () => {
    for (const t of ["int2", "int4", "int8", "integer", "bigint", "smallint", "numeric", "numeric(10,2)", "decimal", "real", "double precision", "float8", "serial", "bigserial", "INTEGER"])
      expect(isNumberType(t), t).toBe(true);
    for (const t of ["interval", "text", "inet", "int4range", "timestamptz"]) expect(isNumberType(t), t).toBe(false);
    expect(chipsToWhere([pred("wait", "interval", "=", "1")])).toBe("wait = '1'");
    expect(chipsToWhere([pred("n", "int4", "=", "1")])).toBe("n = 1");
  });
});

describe("textColumns", () => {
  test("array columns never join an any-text ILIKE", () => {
    const cols = [
      { name: "name", type_name: "text" },
      { name: "tags", type_name: "text[]" },
      { name: "codes", type_name: "_varchar" },
      { name: "note", type_name: "character varying(40)" },
    ];
    expect(textColumns(cols as never)).toEqual(["name", "note"]);
  });
});

describe("a fragment on a column the table doesn't have", () => {
  const cols = [
    { name: "id", type_name: "int8" },
    { name: "player_id", type_name: "int8" },
    { name: "balance_cents", type_name: "int8" },
    { name: "currency", type_name: "text" },
  ];
  test("names the column it most likely meant", () => {
    expect(unknownColumn("balance > 500", cols)).toEqual({ name: "balance", suggestion: "balance_cents" });
    expect(unknownColumn("curency = 'EUR'", cols)).toEqual({ name: "curency", suggestion: "currency" });
    expect(unknownColumn("cents >= 10", cols)).toEqual({ name: "cents", suggestion: "balance_cents" });
  });
  test("stays free SQL when the column exists, nothing comes close, or it isn't a fragment", () => {
    expect(unknownColumn("balance_cents > 500", cols)).toBeNull();
    expect(unknownColumn("CURRENCY = 'EUR'", cols)).toBeNull();
    expect(unknownColumn("now() > '2024-01-01'", cols)).toBeNull();
    expect(unknownColumn("zzz > 1", cols)).toBeNull();
    expect(unknownColumn("EUR", cols)).toBeNull();
    // `id` is in two names: no single guess.
    expect(unknownColumn("i > 1", cols)).toBeNull();
  });
  test("renames the fragment's column", () => {
    expect(renameFragmentColumn(" balance > 500", "balance", "balance_cents")).toBe("balance_cents > 500");
  });
});
