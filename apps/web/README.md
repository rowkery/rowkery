# Rowkery website (Next.js)

**Playful dark** (2026-10-20, after omlx.ai and deno.com): one black sheet with no side rails, big Gabarito headlines, grey copy, pill buttons, and the penguin acting out each section. Dark only (2026-10-14): there is no light theme and no Appearance toggle.

- **Look:** the tokens and the shared rules are in `app/globals.css`; each section's own rules sit beside it (`components/sections/*.css`). White pills are Download; grey pills are everything else. Orange is the one accent: the last headline line, SQL keywords, the lit step, the Rowkery node and its wires, the penguin's props, and Recommended. No gradients or glows.
- **Story** (2026-10-16: agent first, then security, then ⌘K; the site must not read as "you need AI"): the hero (*Postgres and SQLite on your Mac, with or without AI*, Download and GitHub, and a card to connect your agent: Claude Code's command, or the entry Claude Desktop or Cursor reads); a ticker of what's in the app; the app window and the agent's limits as numbers; *With your agent* (four steps beside a sticky scene: it asks, Rowkery checks, it reads stand-ins, you Commit); *Security first* (what an agent sees, what it can run, what gets written); *Built for the keyboard* (six chords from the app's own registry, each playing in a small window); the databases (Postgres and SQLite now, lanes of the ones we might add, a link to Discussions); Lucas's note and the FAQ; get started (the Mac app with the unquarantine command, or from source); and the rookery the name comes from. Long headings break into lines (`.ln`) instead of using commas.
- **The penguin** (`Pg.tsx`): the mark itself, never redrawn, plus an eyelid that blinks on hover and props drawn beside it in orange (a hat, hard hat, shades, magnifier, letter, sign, arrow, question mark). Poses are transforms only (Tilted leans it 10°).
- **Motion:** CSS only, no animation library. The hero rises in once; the penguin peeks over the connect card and says a line every 5.2 s (tap it for the next); the ticker scrolls with a penguin walking along it; the app window tilts upright as it scrolls in and the numbers count up; the agent scene follows the step at the middle of the screen; the igloo, the hearts and the snow loop; the chords play one after another while the keyboard section is on screen; typing "rookery" sends a parade across. `prefers-reduced-motion` stills everything and shows every result. Without scripts every section and the first agent step still show.
- **Copy facts:** one-click setup is only for Claude Desktop and Claude Code; any other MCP client runs `Rowkery --mcp`. No offline claims (the app checks for updates): say the agent's connection runs on your Mac with no server of ours in between. No millisecond figures on the page until the known window-switch slowdown is fixed. No signing promises: the Mac app isn't signed yet, and sponsors cover the developer fee. The agent's limits on the page (1,000 rows at most, 10 s) are `MAX_ROWS` and `STATEMENT_TIMEOUT` in `crates/rowkery-mcp/src/guard.rs`.
- **Screens:** one real app screen, rendered from the app in Chromium, as `-dark.webp` at 2x in `assets/img`, imported with its size in `lib/shots.ts` and drawn by `Shot.tsx`. Imported rather than served from `public/`, so a build only ships the screens a page draws.
- **Fonts** (all SIL OFL, self-hosted from `app/fonts` through `next/font/local`): Gabarito (variable, 400 to 800) for headings, IBM Plex Sans (400, 500) for body text, IBM Plex Mono (400, 500) for code and labels, and Caveat for the penguin's speech bubble (not preloaded).
- **Stack:** Next.js (App Router, TypeScript), static export, plain CSS.

```bash
npm install
npm run dev        # http://localhost:3000 with hot reload
npm run build      # static site in out/
```

Or `make web` from the repo root (build + serve `out/` on :3000).

**Deploy:** Vercel (or Cloudflare Pages), root directory `apps/web`, build command `npm run build`, output directory `out`.

**Placeholders:** `DOWNLOAD_URL` and `RELEASE` in `lib/site.ts`. Every Download button links to `DOWNLOAD_URL`, and while it is empty they scroll to the closing section. `RELEASE` is the build named in the hero's pill and under the closing buttons.

**Check** (after `npm run build`; it needs Playwright):

- `node scripts/resolution-check.mjs [dir]` photographs every section at eight window sizes (360 to 2560 wide) and reports sideways scroll, images that didn't load, text cut off or broken onto two lines, the penguins that peek over cards covering text, and loops that aren't running. Then Reduce Motion (nothing moves, one line in the bubble, the typed SQL whole, every check showing), no scripts, and the 404. Fails on any page error. One contact sheet per size.
- `node scripts/follow-proof.mjs [dir]` proves the email signup under Try Rowkery with Kit stubbed: its place, the penguin clear of text, the address posted as `email_address`, the confirm message, the error that keeps the address (and leaves the field still), and the plain-form fallback when Kit is unreachable. Needs `KIT_FORM_ID`.
- `node scripts/redesign-proof.mjs [dir]` proves the 2026-10-20 redesign at 1440x900 and 390x844: the fonts, the section order, the connect card's tabs and Copy, tapping the penguin, each agent step's panel, the keyboard demo (clicked and playing by itself), the unquarantine command and the parade. Writes frames of each.
- `node scripts/scroll-profile.mjs` scrolls the page top to foot in Chromium with the CPU slowed 4x and reports frame gaps and the main thread's style, layout and paint work, scrolling and sitting still. It fails if the page lays out or paints while it sits still. So every loop moves only `transform`, `translate`, `scale`, `rotate` or `opacity` on an HTML box, and nothing changes on a timer from script. Two traps it caught: an animation on a shape inside an SVG repaints every frame, and so does an animation inside a box that is itself moving (the walking penguin's walk, turn and waddle are three properties on one box instead).
