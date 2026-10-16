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
      { href: "/windows-and-switching/", title: "Windows and switching", file: "windows-and-switching/page.mdx" },
      { href: "/environments-and-safe-mode/", title: "Environments and safe mode", file: "environments-and-safe-mode/page.mdx" },
      { href: "/hosted-postgres/", title: "Hosted Postgres", file: "hosted-postgres/page.mdx" },
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
      { href: "/choosing-what-to-share/", title: "Choosing what to share", file: "choosing-what-to-share/page.mdx" },
      { href: "/proposed-changes/", title: "Proposed changes", file: "proposed-changes/page.mdx" },
      { href: "/sensitive-columns-and-presenting/", title: "Sensitive columns and Presenting", file: "sensitive-columns-and-presenting/page.mdx" },
      { href: "/other-agents/", title: "Other agents", file: "other-agents/page.mdx" },
    ],
  },
  {
    title: "Keys",
    pages: [
      { href: "/search/", title: "Search with ⌘K", file: "search/page.mdx" },
      { href: "/shortcuts-and-keymaps/", title: "Shortcuts and keymaps", file: "shortcuts-and-keymaps/page.mdx" },
      { href: "/undo-and-esc/", title: "Undo and Esc", file: "undo-and-esc/page.mdx" },
    ],
  },
  {
    title: "Help",
    pages: [
      { href: "/release-notes/", title: "Release notes", file: "release-notes/page.mdx" },
    ],
  },
];

export const PAGES: (DocPage & { group: string })[] = GROUPS.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.title })));

/** The page at a path; the export writes every path with a trailing slash. */
export function pageAt(path: string) {
  const p = path.endsWith("/") ? path : `${path}/`;
  return PAGES.find((x) => x.href === p);
}
