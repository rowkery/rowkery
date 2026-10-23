// External paste strings: new parsePaste must match origin/main's legacy splitter
// except where quote rules intentionally improve spreadsheet-style fields.
import { describe, expect, test } from "vitest";
import { parsePaste, stripTrailingLineBreak } from "../src/editBuffer";

function legacyParsePaste(text: string): string[][] {
  const trimmed = stripTrailingLineBreak(text.replace(/\r\n?/g, "\n"));
  if (trimmed.includes("\t")) {
    return trimmed.split("\n").map((l) => l.split("\t"));
  }
  if (trimmed === "") return [[""]];
  const rows: string[][] = [];
  let field = "";
  const push = () => {
    rows.push([field]);
    field = "";
  };
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\n") {
      push();
      continue;
    }
    field += trimmed[i];
  }
  push();
  return rows;
}

const CORPUS = [
  "a\tb\r\nc\td\r\n",
  "one\r\ntwo\r\n",
  "one\rtwo",
  '"quoted"',
  '"a" b',
  '"hello"',
  '{"a":1,"b":2}',
  'He said "hi", then left',
  '5" screen\nnext line',
  '5" screen\t3\nb\t4',
  "Smith, John\nDoe, Jane",
  "1,000\n2,500",
  "x\n",
  "a\tb\n",
  "a\r\n\r\n",
  "a\n\nb\n\n",
];

/** Quoted fields with embedded newline, tab or `""` may differ from legacy. */
const INTENDED_IMPROVEMENTS: { input: string; expected: string[][] }[] = [
  { input: '"a\nb"\tc', expected: [["a\nb", "c"]] },
  { input: '"x""y"\tz', expected: [["x\"y", "z"]] },
  { input: '"say ""hi"""', expected: [['say "hi"']] },
  { input: 'a\t"b\tc"\nd', expected: [["a", "b\tc"], ["d"]] },
  { input: '"line1\nline2"\tx', expected: [["line1\nline2", "x"]] },
];

describe("parsePaste corpus vs legacy", () => {
  test("matches legacy on the regression corpus", () => {
    const mismatches: string[] = [];
    for (const input of CORPUS) {
      const legacy = legacyParsePaste(input);
      const next = parsePaste(input);
      if (JSON.stringify(next) !== JSON.stringify(legacy)) {
        mismatches.push(`${JSON.stringify(input)} legacy=${JSON.stringify(legacy)} got=${JSON.stringify(next)}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  test("intended quote improvements", () => {
    for (const { input, expected } of INTENDED_IMPROVEMENTS) {
      expect(parsePaste(input)).toEqual(expected);
    }
  });
});
