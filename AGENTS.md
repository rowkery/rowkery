# Rowkery — agent notes

Rules for contributors and their coding agents: what holds across every pull request. [CONTRIBUTING.md](CONTRIBUTING.md) covers the same ground for people; [SECURITY.md](SECURITY.md) says how to report a vulnerability.

**Don't edit this file in a feature PR.** When every PR adds a line here, each merge puts every other open PR in conflict. What a PR changed goes in its description and commit messages (`git log` is the changelog). Edit this file only in its own small `chore/` PR, and only when a rule an agent must follow changes (git rules, commands, the quality gate, a project convention). How a feature works is not a rule: read the code, its comments and `docs/spec.md` (the design spec and its decisions).

## Git rules

- **Branch names** use a type prefix: `feat/xxx`, `fix/xxx`, `chore/xxx`, `refactor/xxx` or `perf/xxx`, even if your tool proposes another (such as `claude/xxx`). Commit messages use the same types, with an optional scope: `fix(ui): keep the chip editor's list in view`.
- **The PR description is the changelog.** Say what changed, the decisions a reviewer should know about, and how it was verified. Keep a PR under ~1,500 changed lines; split bigger work into stacked branches.
- A decision already settled in `docs/spec.md` or `DESIGN.md` isn't reopened in passing by a later PR; propose a change to it on its own.

## Stack

- **UI:** TypeScript, Tauri 2, Vite, React: `apps/rowkery-tauri` (`npm run tauri dev` for hot reload).
- **Core:** Rust `rowkery-core` (Postgres / SQLite, introspection, queries, edits) behind `rowkery-bridge` (`CoreBridge`). Everything goes through the window API (`open_window`, `run_window_query`, …); there is no single-session path.
- **Website:** `apps/web` (Next.js static export); `make web` builds and serves it on :3000.

## Running it

```bash
cd apps/rowkery-tauri
npm install
npm run tauri dev          # Vite HMR on :1420
```

- To run a branch or PR on a Mac: `make dev feat/x` (or `make dev 35` for PR #35, `make dev` for the current branch). It fetches, resets the local branch to origin, runs `npm install` when the lockfile changed, then `npm run tauri dev` (`scripts/dev.sh`); it stops if tracked files have uncommitted changes. Plain `npm run dev` only starts Vite.
- To install on another Mac: `make dmg` (or `make dmg universal`; `scripts/dmg.sh`). The local build is unsigned: `xattr -dr com.apple.quarantine /Applications/Rowkery.app`.
- Linux webview deps: `libwebkit2gtk-4.1-dev` and GTK 3 dev packages ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)). The real app runs headless under `Xvfb` with `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `ROWKERY_CONFIG_DIR=<a temp dir>`.
- Test Postgres: `docker compose -f docker-compose.test.yml up -d postgres` (port **54329**, user/db/password `rowkery`). The Postgres integration tests run with `ROWKERY_PG_HOST=127.0.0.1 ROWKERY_PG_PORT=54329` and `cargo test --workspace --features rowkery-core/postgres-integration,rowkery-mcp/postgres-integration`. `ROWKERY_CONFIG_DIR` (a temp dir) keeps the app and tests away from your own connections and keychain.

## Quality gate (before every push)

```bash
cd apps/rowkery-tauri && npm run typecheck && npx vitest run
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

- **CI runs on every pull request** (`ci.yml`: this gate with the Postgres integration tests, the website build, a macOS build check and the dependency audit, `deny.toml` + `npm audit`). A PR merges only when it's green, and a red run is yours to fix, not re-run. Still run the gate locally before you push. CI doesn't run the browser or latency proofs, so those stay yours. `dmg.yml` and `latency-webview2.yml` stay manual. Workflows keep `permissions: contents: read`, pin actions to a commit SHA and never use `pull_request_target`.
- **A new advisory** in the audit job is fixed by upgrading the dependency. When no fix exists, add an ignore to `deny.toml` with the reason it can't reach users.
- **Every UI change ships a browser proof** (`scripts/*-browser-proof.mjs`, Chromium + Vite with a stubbed Tauri `invoke`) and re-runs the existing proofs it could affect. Proofs select by stable attributes: a semantic `data-*` the app already uses, else `data-testid`; a class only when the class is what's under test. The convention, and how to run a proof, are in `scripts/lib/README.md` and CONTRIBUTING.md. Each script's header says what it proves.
- **Latency budgets gate.** Budgets live in `scripts/budgets.json`; `scripts/lib/latency-judge.mjs` fails a run on a regression against `scripts/baselines/reference-*.json` (more than 25% + 15 ms slower) or a budget miss the reference met. A PR that touches `crates/`, `apps/rowkery-tauri/src-tauri/` or the results path runs `scripts/latency-browser-proof.mjs` (UI thread, Chromium) and, on a Mac, `scripts/latency-proof.sh` (the packaged app against the test Postgres), and puts the before / after numbers for the marks it touches in its description. Don't cite the Chromium proof for what a browser can't see (process start, IPC, WebKit parsing).
- When verifying, check the behaviour around your change too, not only the change itself: re-run the proofs and tests for features it could touch.

## Engineering rules

Paths below are under `apps/rowkery-tauri/` unless they start with `crates/`.

- **Commands live in one registry**, `src/commands.ts`: id, title, chord, `canRun`, menu title, sheet section. ⌘K, the macOS menu bar (`src-tauri/menu.json`, generated: `UPDATE_MENU=1 npm test`), context menus, tooltips, the key strip and the shortcut sheet all read it. Never type a chord by hand in a `title=` or a menu row (use `commandTip` / `commandKeys` / `keysFor`); vitests fail on hard-coded chords and on two commands sharing a chord unless they can never run together.
- **Saved state goes to config.json, not localStorage**: read and write it through `src/persist.ts` (windows, tabs and their SQL, chips, sort, hidden columns, pending edits, widths, pins, history, hints, used keys, the prefetch switch). It writes at most once a second, off every hot thread; SQL is saved on blur / idle, never per keystroke. Values Rust needs before the window exists (native decorations) are typed fields in `rowkery-core`'s `AppConfig`.
- **Rows travel as binary frames** over a Tauri channel into a column store outside React. The format is documented at the top of `crates/rowkery-core/src/frames.rs` (and `docs/spec.md`, Wire format); a change regenerates the golden files as their test explains. Column profiles are computed once in Rust (`crates/rowkery-core/src/profile.rs`), never by scanning rows in the webview.
- **Paging:** free-form SELECTs page with a SQL cursor on the tab's own session, only when the tab has no transaction of the user's open; table tabs page by keyset on (sort columns…, primary key), with OFFSET only for tables without a key. Never wrap user SQL in READ ONLY.
- **Hover prefetch** is a per-connection switch, **off by default**; it uses its own session and never prefetches a write.
- **Writes to the user's data** (row edits) match on the full primary key, run in one transaction where every statement must change exactly one row, go through safe mode (`hold_for`: Confirm writes shows the exact SQL, Read-only refuses), never run inside the user's own open transaction, and never retry a COMMIT whose connection dropped.
- **Cancel:** Esc and ⌘. cancel the shown tab's query; a stuck query gets Force stop. Tauri commands that touch the database are async and run off the main thread.
- **No status bar and no footer.** Confirmations are a capsule toast (`showToast`); reversible actions offer Undo instead of a confirm dialog.

## Design rules

The visual language is Paper; `DESIGN.md` has the tokens and the reasons.

- **Rules are the structure, borders mean controls.** Regions are separated by 1 px `--line` rules on one opaque paper sheet; a 1 px `--line2` border says "you can press this". No glass, no `backdrop-filter`, no glow.
- **Orange is what you ask for, ink commits.** `--acc` is only on Run, the active statement's bar, the WHERE chips, the active tab, switches that are on and the focus ring. The button that writes (Commit, Save and connect, Send) is ink (`--ink` / `--inkfg`), never orange or red. Run is a flat fill.
- **Light and dark follow macOS** (Auto, or pinned with Appearance at the schema column's foot). Every colour is a token defined in both `:root` and `:root[data-theme="dark"]` in `src/App.css`; no hex outside them. Text on a solid fill uses `--onfill`; small text stays at 4.5:1 in both themes (`scripts/paper-finish-browser-proof.mjs` checks).
- **The inspector column** on the right holds Quick Look, Review SQL and New connection, one at a time, beside the data, never over it.
- **The foot edits bar** at the grid's foot counts staged edits and holds Discard / Review SQL / Commit; toasts (an ink card, its action in orange) sit above it.
- **Glide hover** is the one list highlight (`useGlideHover`); rows inside a glide list don't paint their own `:hover`.
- **The title bar** (48 px): traffic lights, one pill per window and +, then the shown window's Safe mode and MCP (only while connected) and ⌘K. The schema column keeps the connection's name and host, and ends with a row of icon buttons: Agents, Appearance (the only theme control), Help.
- **Environment** is the window pill's dot plus a word tag on its own wash (prd red, stg orange, dev blue, local green).
- **The penguin** (the Rowkery mark; Posture: Ready / Tilted) appears only at dead ends (Connect to start, Couldn't connect, the fatal error) and as an empty window's pill mark, never on a work surface or while a query runs. `brand/rowkery-mark*.svg` don't change: no redesign, only colour and size.
- **Motion:** exits are shorter than entries; keyboard-opened overlays appear at once; `prefers-reduced-motion` turns motion off.
- **macOS window:** native decorations with `Overlay` and `trafficLightPosition` (18, 24: centred on the title bar's pills) in `src-tauri/tauri.macos.conf.json`. Never toggle decorations at runtime on macOS (it drops the full-size content view). Linux / Windows draw their own controls (`src/WindowControls.tsx`) unless the native-decorations flag is on.
- **Logo marks only**, no wordmarks, for engine logos; new engines are one `ENGINES` entry (`src/engines.tsx`).

## Checklist (each change)

- [ ] Work on a correctly named branch (see Git rules)
- [ ] Run the quality gate and the proofs your change affects; refresh proof PNGs when UI changes
- [ ] Describe what changed, and how you verified it, in the PR description, not in this file
