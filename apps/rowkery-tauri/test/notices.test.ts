// THIRD_PARTY_NOTICES.md (scripts/notices.mjs) keeps up with what the app
// ships, and the sheet reads its shapes. A new production dependency fails
// here until the file is regenerated.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { noticeBlocks } from "../src/notices";

const notices = readFileSync(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("third-party notices", () => {
  test("every production dependency is listed", () => {
    for (const dep of Object.keys(pkg.dependencies)) expect(notices, dep).toContain(dep);
  });

  test("the font carries the OFL and its copyright line", () => {
    expect(notices).toContain("Reserved Font Name \"Plex\"");
    expect(notices).not.toContain("Source Serif");
    expect(notices).toMatch(/### OFL-1\.1\n\n```text\nSIL OPEN FONT LICENSE Version 1\.1/);
  });

  test("each licence text appears once", () => {
    const heads = [...notices.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(heads.length).toBeGreaterThan(3);
    expect(new Set(heads).size).toBe(heads.length);
  });

  test("the sheet reads headings, package rows and texts", () => {
    expect(
      noticeBlocks(
        "# Title\n\nIntro `x`.\n\n## Rust crates (1)\n\n- **serde** 1.0.0, MIT\n  Copyright (c) Someone\n- **ryu** 1.0.0, Apache-2.0\n\n## Licence texts\n\n### MIT\n\n```text\nPermission is hereby granted\n\n## not a heading\n```\n",
      ),
    ).toEqual([
      { kind: "p", text: "Intro x." },
      { kind: "h3", text: "Rust crates (1)" },
      {
        kind: "list",
        rows: [
          { name: "serde", rest: " 1.0.0, MIT", who: "Copyright (c) Someone" },
          { name: "ryu", rest: " 1.0.0, Apache-2.0", who: null },
        ],
      },
      { kind: "h3", text: "Licence texts" },
      { kind: "h4", text: "MIT" },
      { kind: "text", text: "Permission is hereby granted\n\n## not a heading" },
    ]);
  });

  test("the whole file reads: every package a row, every text once", () => {
    const blocks = noticeBlocks(notices);
    const rows = blocks.flatMap((b) => (b.kind === "list" ? b.rows : []));
    expect(rows.length).toBeGreaterThan(300);
    expect(rows.every((r) => r.name)).toBe(true);
    expect(blocks.filter((b) => b.kind === "text").length).toBe(blocks.filter((b) => b.kind === "h4").length);
  });
});
