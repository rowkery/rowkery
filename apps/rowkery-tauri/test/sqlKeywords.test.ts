import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { SQL_KEYWORDS, needsQuoting } from "../src/sqlKeywords";

// The chips must quote a column exactly as core's SQL does: the TS list is
// core's `KEYWORDS`, read here from the Rust source.
const RUST = resolve(__dirname, "../../../crates/rowkery-core/src/db/introspect.rs");

describe("sqlKeywords", () => {
  test("equals core's KEYWORDS (crates/rowkery-core/src/db/introspect.rs)", () => {
    const src = readFileSync(RUST, "utf8");
    const body = /const KEYWORDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(src)?.[1];
    expect(body).toBeDefined();
    const rust = [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rust.length).toBeGreaterThan(100);
    expect([...SQL_KEYWORDS]).toEqual(rust);
  });

  test("needsQuoting follows core's needs_quoting", () => {
    expect(needsQuoting("wallet_tx")).toBe(false);
    expect(needsQuoting("_tmp2")).toBe(false);
    expect(needsQuoting("Order")).toBe(true);
    expect(needsQuoting("user")).toBe(true);
    expect(needsQuoting("2fa")).toBe(true);
    expect(needsQuoting("first name")).toBe(true);
    expect(needsQuoting("a$b")).toBe(true);
    expect(needsQuoting("")).toBe(true);
  });
});
