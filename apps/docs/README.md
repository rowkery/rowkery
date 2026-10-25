# Rowkery docs (docs.rowkery.com)

How to install and use Rowkery, in the look rowkery.com had before its 2026-10-25 light redesign: one black sheet, IBM Plex Sans and Mono (400, 500), rounded `#161616` panels and pill buttons, and the real dark app screens. Dark only. The tokens are at the top of `app/globals.css`.

- **Pages** are MDX: `app/page.mdx` is the introduction, every other page is `app/<slug>/page.mdx`. Each starts with its `metadata` title and a `crumb` line naming its group. `##` and `###` headings get their ids from their text (`lib/slug.ts`), so `## SSH tunnel` is `#ssh-tunnel`.
- **A new page** is its `page.mdx` plus one entry in `lib/pages.ts`, which drives the sidebar, the previous / next links, "Edit this page" and search.
- **Search** (⌘K, or the search pill) covers every page and its `##` / `###` headings, read from the MDX at build time (`lib/search-index.ts`), so it can't drift from the pages.
- **Blocks** available in any page without an import (`mdx-components.tsx`): `<Steps>` (each `###` inside is a numbered step), `<Shot>` (a screen; `side` floats a tall one beside the text, ended with `<div className="clear" />`), `<Clip>` (a short looping recording with its poster; it plays only on screen and stays still under Reduce Motion), `<Cards>` / `<Card>`, `<Note>`, `<Env name="prd" />`. Code blocks get a Copy button; tables come from GitHub-style Markdown.
- **Generated tables** (`components/Generated.tsx`) read `lib/generated/*.json`, which tests write from the app's own code, so they can't drift: `<ShortcutTable />`, `<KeymapTable />`, `<MenuTable />` and `<CommandList />` from `commands.ts` and `releases.json` from `docs/releases/` (`apps/rowkery-tauri/test/docs-generated.test.ts`; `UPDATE_DOCS=1 npx vitest run test/docs-generated.test.ts`), and `<McpTools />`, `<McpLimits />`, `<McpInstructions />` from the MCP server's tool list (`crates/rowkery-mcp/src/docs_table.rs`; `UPDATE_DOCS=1 cargo test -p rowkery-mcp docs_table`). `<ReleaseNotes />` renders every release's notes. Search also finds every shortcut, tool and release these put on a page.
- **Screens and clips** are dark app screens at 2x in `public/img` and MP4s in `public/clips`, taken from the running app (Vite with a stubbed Tauri `invoke`, drawn as a Mac draws it) by `scripts/docs-shots/*.mjs` at the repo root, one file per group of pages over the helpers in `lib.mjs`. With Vite on :1420, `node scripts/docs-shots/<file>.mjs [outDir] --write` retakes them (`--only=<name>` for some). Write keys as the Mac has them (`⌘`, `⇧`, `⌥`).
- **Copy:** plain sentences, sentence case, no full stops on headings. Check a fact against the code (or `docs/spec.md`) before writing it.

```bash
npm install
npm run dev        # http://localhost:3001 with hot reload
npm run build      # static site in out/
```

Or `make docs` from the repo root (build + serve `out/` on :3001).

**Deploy:** its own Vercel project, root directory `apps/docs`, build command `npm run build`, output directory `out`, domain `docs.rowkery.com`. It doesn't depend on the website's coming-soon flag.

**Check** (after `npm run build`; it needs Playwright): `node scripts/docs-check.mjs [dir]` loads every page at a desktop and a phone size and fails on a page error, sideways scroll, an image that didn't load, the sidebar not marking the page, or a link to a page or heading that doesn't exist. It also tries ⌘K (find, ↵, Esc, no match), Copy and the phone's Menu, and saves a screenshot of each page at each size.
