import { describe, expect, it } from "vitest";
import { quoteBackspace, quoteTyped } from "../src/quotePairs";

describe("quoteTyped", () => {
  it("pairs a quote in code", () => {
    expect(quoteTyped("select ", 7, 7, "'")).toEqual({ kind: "insert", text: "''", caret: 8 });
    expect(quoteTyped("a = ", 4, 4, '"')).toEqual({ kind: "insert", text: '""', caret: 5 });
  });
  it("steps over a closing quote", () => {
    expect(quoteTyped("where a = 'x'", 12, 12, "'")).toEqual({ kind: "skip", caret: 13 });
  });
  it("leaves apostrophes inside words alone", () => {
    expect(quoteTyped("don", 3, 3, "'")).toBeNull();
  });
  it("does not pair in comments", () => {
    expect(quoteTyped("-- it ", 6, 6, "'")).toBeNull();
    expect(quoteTyped("/* ", 3, 3, "'")).toBeNull();
  });
  it("a different quote inside a string is plain", () => {
    expect(quoteTyped("'a ", 3, 3, '"')).toBeNull();
  });
  it("wraps a selection", () => {
    expect(quoteTyped("abc", 0, 3, "'")).toEqual({ kind: "wrap", from: 0, to: 3, text: "'abc'" });
  });
});

describe("quoteBackspace", () => {
  it("removes an empty pair", () => {
    expect(quoteBackspace("x ''", 3, 3)).toEqual({ kind: "delete", from: 2, to: 4 });
    expect(quoteBackspace("x 'a'", 4, 4)).toBeNull();
  });
});
