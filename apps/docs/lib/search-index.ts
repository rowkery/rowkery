import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES } from "./pages";
import { slug } from "./slug";

export type SearchEntry = { title: string; page: string; href: string };

/**
 * What ⌘K searches: every page and each of its ## and ### headings, read from the MDX at
 * build time, so the index can't drift from the pages. Runs only on the server.
 */
export function searchIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const p of PAGES) {
    out.push({ title: p.title, page: p.group, href: p.href });
    const src = readFileSync(join(process.cwd(), "app", p.file), "utf8");
    for (const m of src.matchAll(/^#{2,3} (.+)$/gm)) {
      const text = m[1].replace(/`/g, "").trim();
      out.push({ title: text, page: p.title, href: `${p.href}#${slug(text)}` });
    }
  }
  return out;
}
