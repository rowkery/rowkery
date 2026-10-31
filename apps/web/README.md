# Rowkery website (Next.js)

**The quiet page** (2026-10-25, from the approved mock modelled on reasonmachines.com/network): one calm, centred column on a light page under a floating rounded bar. Each section is a heading, a line and one thing to look at. Light only.

- **Look:** everything is in `app/globals.css`. Near-white page, IBM Plex Sans for text and headings (500), IBM Plex Mono for commands. Ink pills are Download; outlined pills are everything else; the command boxes are dark like a terminal. Orange is the one accent: the How it works stage, the dot on the version pill, focus rings. No gradients, glows or blur.
- **Order** (agent first, then security, then ⌘K; the site must not read as "you need AI"): the plain logo, *A database app for you and your agent*, Download and Read the docs; *How Rowkery works*, three steps that play in turn (Ask your agent, Say yes before anything changes, Or do it yourself); *Works with the agents you already use* with Claude Code's one-line command; *Safe, private and free*; *Quick from the keyboard* (two looping clips); *Questions*; *Get Rowkery*; the foot. Every word is real markup, so it shows without scripts and gets indexed.
- **Clips** (`public/clips`): the real app filmed in its light theme with the docs screen helpers (`openApp({ scheme: "light" })` and `record()` in `scripts/docs-shots/lib.mjs`: the app on Vite with its stubbed backend, screencast to H.264), each with a JPEG poster of its first frame. The agent's chat in the first step is drawn (`components/How.tsx`), since it lives in Claude, not in Rowkery.
- **Motion:** everything moves by transform or opacity. The opening settles in once on load; each other block rises into place the first time it scrolls into view (`components/Motion.tsx`; a head script in `app/layout.tsx` marks the page `data-js` first, and takes the mark off if the page's scripts never start). How it works plays only while on screen: the chat lines switch in by class, the pager bars fill by Web Animations that follow the clip (they wait while it buffers, and a step ends when its clip does), and the steps crossfade on layers kept with `will-change`, so a step change repaints next to nothing. The keyboard clips loop while on screen and load only when they come near. There is no frame loop. Under Reduce Motion nothing moves or hides: the chat shows whole, the bars are full, the clips stay on their posters with controls.
- **The penguin** (`Pg.tsx`): the mark itself, an inline path in an SVG with overflow visible, never a `<symbol>` behind `<use>` (a symbol clips to the view box that uses it). It is the plain logo everywhere on this page; its eyelid blinks on hover.
- **Copy facts:** one-click setup is only for Claude Desktop and Claude Code; any other MCP client runs `Rowkery --mcp`. No offline claims (the app checks for updates). No millisecond figures for the app's own speed until the known window-switch slowdown is fixed. The Mac app is signed and notarized by Apple from 1.0.0. Headings carry no full stops.
- **Fonts** (SIL OFL, self-hosted from `app/fonts` through `next/font/local`): IBM Plex Sans (400, 500), IBM Plex Mono (400, 500).
- **Stack:** Next.js (App Router, TypeScript), static export, plain CSS.

```bash
npm install
npm run dev        # http://localhost:3000 with hot reload
npm run build      # static site in out/
```

Or `make web` from the repo root (build + serve `out/` on :3000).

**Deploy:** Vercel (or Cloudflare Pages), root directory `apps/web`, build command `npm run build`, output directory `out`.

**Placeholders:** `DOWNLOAD_URL` and `RELEASE` in `lib/site.ts`. Every Download button links to `DOWNLOAD_URL`, and while it is empty they scroll to the close. `RELEASE` is the version on the pill at the top.

**Check** (after `npm run build`; Playwright in Chromium only, so Safari and a real Mac are Lucas's to check).

- `node scripts/resolution-check.mjs [dir]` photographs the page at eight window sizes (360 to 2560 wide) and reports sideways scroll, the bar off the window, the title over two lines (three on a phone), a button or agent name broken onto two lines, a block still hidden after scrolling past it, How it works not playing (chat lines, the next step's clip, its bar following the clip) and a keyboard clip not playing on screen or playing off it. Then Reduce Motion (nothing hidden or playing by itself, controls on the clips, full bars), no scripts (every block and chat line showing) and the 404. Fails on any page error.
- `node scripts/scroll-profile.mjs` scrolls the page top to foot in Chromium with the CPU slowed 4x and reports frame gaps and the main thread's style, layout and paint work, scrolling and sitting still (at the top, on How it works while it plays, on the keyboard clips, on the close). It fails if the page keeps laying out or painting while it sits still (a step change may do so once), or if anything asks for animation frames.
