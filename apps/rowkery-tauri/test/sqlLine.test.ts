import { describe, expect, test } from "vitest";
import { lineWithFilter, sqlLineParts, sqlLineText } from "../src/sqlLineParts";
import { highlightSqlLines } from "../src/sqlHighlight";

/** What the browser shows for highlighted HTML. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const FIXTURES = [
  "SELECT * FROM public.wallet_tx\nORDER BY id\nLIMIT 1000;",
  "SELECT * FROM public.wallet_tx\nWHERE (status = 'pending')\nORDER BY amount DESC NULLS LAST, id\nLIMIT 1000;",
  `SELECT * FROM public."Order"\nWHERE (note ILIKE '%it''s%' -- a comment\n)\nLIMIT 5000;`,
  "SELECT * FROM t\nORDER BY id\nLIMIT 1000 OFFSET 2000;",
  "SELECT * FROM public.events;",
  `SELECT id, "Note", "a, b" FROM public.wallet_tx\nORDER BY "Order" DESC NULLS LAST, id\nLIMIT 1000;`,
];

describe("the SQL line", () => {
  test.each(FIXTURES)("round-trips through the editor's tokenizer: %s", (sql) => {
    const p = sqlLineParts(sql);
    expect(textOf(p.beforeHtml) + (p.limit ?? "") + textOf(p.afterHtml)).toBe(sqlLineText(sql));
    // One line, tokenized the way the editor colours it.
    expect(highlightSqlLines(p.text)).toHaveLength(1);
  });

  test.each([
    ["SELECT * FROM public.wallet_tx\nORDER BY id\nLIMIT 1000;", null],
    ["SELECT * FROM public.wallet_tx\nWHERE (status = 'pending' AND amount > 100)\nORDER BY id\nLIMIT 1000;", "status = 'pending' AND amount > 100"],
    ["SELECT * FROM public.events;", null],
  ])("splits around the chips' slot: %s", (sql, filter) => {
    const p = sqlLineParts(sql, filter);
    expect(p.where).toBe(filter);
    expect(textOf(p.headHtml) + (p.where !== null ? `${p.where})` : "") + textOf(p.tailHtml) + (p.limit ?? "") + textOf(p.afterHtml)).toBe(p.text);
    if (!filter) expect(textOf(p.headHtml)).toMatch(/FROM public\.(wallet_tx|events)$/);
    else expect(textOf(p.headHtml)).toMatch(/WHERE \($/);
  });

  test("the line follows the chips before the new page is back", () => {
    const ran = "SELECT * FROM public.wallet_tx\nWHERE (status = 'pending')\nORDER BY id\nLIMIT 1000;";
    expect(lineWithFilter(ran, "status = 'pending'", "status = 'pending' AND amount > 1")).toBe(
      "SELECT * FROM public.wallet_tx WHERE (status = 'pending' AND amount > 1) ORDER BY id LIMIT 1000;",
    );
    expect(lineWithFilter(ran, "status = 'pending'", "")).toBe("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
    expect(lineWithFilter("SELECT * FROM t\nLIMIT 1000;", "", "a = 1")).toBe("SELECT * FROM t WHERE (a = 1) LIMIT 1000;");
  });

  test("literals are as sent, never formatted", () => {
    const p = sqlLineParts("SELECT * FROM public.wallet_tx\nORDER BY id\nLIMIT 1000;");
    expect(p.text).toBe("SELECT * FROM public.wallet_tx ORDER BY id LIMIT 1000;");
    expect(p.limit).toBe("LIMIT 1000");
    expect(p.text).not.toContain("1,000");
  });

  test("All rows has no LIMIT control", () => {
    expect(sqlLineParts("SELECT * FROM public.events;").limit).toBeNull();
  });

  test("clauses split so a gesture can wash the one it changed", () => {
    const p = sqlLineParts(
      `SELECT id, "Note", "a, b" FROM public.wallet_tx\nWHERE (x = ' ORDER BY y')\nORDER BY "Order" DESC NULLS LAST, id\nLIMIT 1000;`,
    );
    const by = (c: string) => p.segments.filter((s) => s.clause === c).map((s) => s.text);
    expect(by("select")).toEqual([`id, "Note", "a, b"`]);
    expect(p.segments.find((s) => s.clause === "select")?.columns).toBe(3);
    expect(by("order")).toEqual([`ORDER BY "Order" DESC NULLS LAST, id`]);
    expect(p.segments.map((s) => s.text).join("")).toBe(p.text.slice(0, p.text.indexOf("LIMIT")));
    // SELECT * has a list too (0 columns); no sort, no ORDER BY clause.
    const star = sqlLineParts("SELECT * FROM t\nLIMIT 5;");
    expect(star.segments.find((s) => s.clause === "select")?.columns).toBe(0);
    expect(star.segments.some((s) => s.clause === "order")).toBe(false);
  });
});
