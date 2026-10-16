/**
 * THIRD_PARTY_NOTICES.md (scripts/notices.mjs) read into the few shapes it
 * has, for the notices sheet: headings, paragraphs, one row per package
 * (`- **name** version, licence`, its copyright line indented under it) and
 * fenced licence texts.
 */
export type NoticeBlock =
  | { kind: "h3" | "h4" | "p"; text: string }
  | { kind: "list"; rows: { name: string | null; rest: string; who: string | null }[] }
  | { kind: "text"; text: string };

const plain = (s: string) => s.replace(/\*\*|`/g, "");

export function noticeBlocks(md: string): NoticeBlock[] {
  const out: NoticeBlock[] = [];
  const lines = md.split("\n");
  let rows: Extract<NoticeBlock, { kind: "list" }>["rows"] = [];
  const flush = () => {
    if (rows.length) out.push({ kind: "list", rows });
    rows = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      out.push({ kind: "text", text: body.join("\n") });
    } else if (line.startsWith("- ")) {
      const m = /^- \*\*(.+?)\*\*(.*)$/.exec(line);
      const who = lines[i + 1]?.startsWith("  ") ? lines[++i].trim() : null;
      rows.push({ name: m ? m[1] : null, rest: plain(m ? m[2] : line.slice(2)), who });
    } else {
      flush();
      if (line.startsWith("### ")) out.push({ kind: "h4", text: line.slice(4) });
      else if (line.startsWith("## ")) out.push({ kind: "h3", text: line.slice(3) });
      else if (line.trim() && !line.startsWith("# ")) out.push({ kind: "p", text: plain(line) });
    }
  }
  flush();
  return out;
}
