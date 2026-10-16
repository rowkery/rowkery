/**
 * Every page, in reading order, grouped as the sidebar shows them. `file` is the page's
 * MDX under app/; search reads its headings from there at build time (lib/search-index.ts).
 * A new page is one entry here plus its page.mdx.
 */
export type DocPage = { href: string; title: string; file: string };
export type DocGroup = { title: string; pages: DocPage[] };

export const GROUPS: DocGroup[] = [
  {
    title: "Get started",
    pages: [
      { href: "/", title: "Introduction", file: "page.mdx" },
      { href: "/quick-setup/", title: "Quick setup", file: "quick-setup/page.mdx" },
    ],
  },
  {
    title: "Connections",
    pages: [
      { href: "/setting-up-a-connection/", title: "Setting up a connection", file: "setting-up-a-connection/page.mdx" },
    ],
  },
  {
    title: "Working with data",
    pages: [
      { href: "/query-tabs/", title: "Query tabs", file: "query-tabs/page.mdx" },
      { href: "/completion/", title: "Completion", file: "completion/page.mdx" },
      { href: "/table-tabs-and-filters/", title: "Table tabs and filters", file: "table-tabs-and-filters/page.mdx" },
      { href: "/quick-look/", title: "Quick Look", file: "quick-look/page.mdx" },
      { href: "/editing-rows/", title: "Editing rows", file: "editing-rows/page.mdx" },
      { href: "/exporting-and-copying/", title: "Exporting and copying", file: "exporting-and-copying/page.mdx" },
      { href: "/query-plans/", title: "Query plans", file: "query-plans/page.mdx" },
      { href: "/sessions/", title: "Sessions", file: "sessions/page.mdx" },
    ],
  },
  {
    title: "Agents",
    pages: [
      { href: "/connecting-to-agents/", title: "Connecting to agents", file: "connecting-to-agents/page.mdx" },
    ],
  },
];

export const PAGES: (DocPage & { group: string })[] = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));

/** The page at a path; the export writes every path with a trailing slash. */
export function pageAt(path: string) {
  const p = path.endsWith("/") ? path : `${path}/`;
  return PAGES.find((x) => x.href === p);
}
