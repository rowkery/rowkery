import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

// macOS's file system ignores case: `./SqlLine` resolves `.ts` first, so it
// found `sqlLine.ts` before `SqlLine.tsx` and the app never loaded there.
// No two modules may share a name that differs only in case.
describe("file names", () => {
  test.each(["src", "test"])("%s: no two names differ only in case", (dir) => {
    const stems = new Map<string, Set<string>>();
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      const stem = f.replace(/\.[^.]+$/, "");
      const key = stem.toLowerCase();
      if (!stems.has(key)) stems.set(key, new Set());
      stems.get(key)!.add(stem);
    }
    const clashes = [...stems.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / "));
    expect(clashes).toEqual([]);
  });
});
