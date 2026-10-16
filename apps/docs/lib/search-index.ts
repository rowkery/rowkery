import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES } from "./pages";
import { slug } from "./slug";
import shortcuts from "./generated/shortcuts.json";
import mcp from "./generated/mcp-tools.json";
import releases from "./generated/releases.json";

export type SearchEntry = { title: string; page: string; href: string };

/**
 * What ⌘K searches: every page and each of its ## and ### headings, read from the MDX at
 * build time, so the index can't drift from the pages, plus what a generated table puts on a
 * page (components/Generated.tsx), so a shortcut, a tool or a release is found by name. Runs
 * only on the server.
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
    if (src.includes("<ShortcutTable")) {
      for (const s of shortcuts.sections) {
        for (const r of s.rows) out.push({ title: r.title, page: `Shortcut ${r.keys}`, href: `${p.href}#shortcuts-${slug(s.name)}` });
      }
    }
    if (src.includes("<McpTools")) for (const t of mcp.tools) out.push({ title: t.name, page: "MCP tool", href: `${p.href}#${slug(t.name)}` });
    if (src.includes("<ReleaseNotes")) for (const r of releases) out.push({ title: r.version, page: p.title, href: `${p.href}#${slug(r.version)}` });
  }
  return out;
}
