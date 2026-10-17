# Contributing to Rowkery

Thanks for helping. This page covers building Rowkery, the checks a change has to pass, and how commits and pull requests are shaped. How the app looks is in [DESIGN.md](DESIGN.md); how it works is in [docs/spec.md](docs/spec.md) and the code's comments. Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).

## Build from source

You need Rust (the version in `rust-toolchain.toml`), Node 22 and, on a Mac, Xcode's command line tools. On Linux, install WebKitGTK 4.1 and the other [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Linux and Windows builds are unofficial.

```bash
cd apps/rowkery-tauri
npm install
npm run tauri dev        # the app with hot reload (Vite on :1420)
```

From the repo root, `make dmg` builds a DMG for your Mac's chip and `make dmg universal` one for both. `make dev <branch>` or `make dev <PR number>` runs a branch or a pull request. `make web` builds and serves the website on :3000.

For the Postgres tests, start the test database (port 54329, user, database and password `rowkery`):

```bash
docker compose -f docker-compose.test.yml up -d postgres
export ROWKERY_PG_HOST=127.0.0.1 ROWKERY_PG_PORT=54329 ROWKERY_PG_PASSWORD=rowkery
```

Set `ROWKERY_CONFIG_DIR` to a temporary folder when you run the app or the tests, so they leave your own connections and keychain alone.

## Quality gate

Run all of it before you push:

```bash
cd apps/rowkery-tauri && npm run typecheck && npx vitest run
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

With the test database up, add `--features rowkery-core/postgres-integration,rowkery-mcp/postgres-integration` to `cargo test` to run the Postgres integration tests too.

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request, with the Postgres integration tests, the website build, a macOS build check and a dependency audit (`deny.toml` for the crates, `npm audit` for the apps). A pull request merges once it's green. CI doesn't run the browser or latency proofs, so those stay yours.

A change to the app's Rust or npm dependencies regenerates `THIRD_PARTY_NOTICES.md` with `node scripts/notices.mjs` (needs `cargo install cargo-about --locked --features cli`).

## Browser proofs

Every UI change ships a browser proof: a script in `scripts/*-browser-proof.mjs` that serves the frontend with Vite, stubs Tauri's `invoke`, drives it in headless Chromium and checks what's on screen. Each script's header says what it proves. Re-run the existing proofs your change could affect, too.

The proofs use Playwright, a dev dependency of `apps/rowkery-tauri`:

```bash
cd apps/rowkery-tauri
npm install
npx playwright install chromium
npx vite --port 1420 &
cd ../..
NODE_PATH=apps/rowkery-tauri/node_modules node scripts/toast-browser-proof.mjs
```

Proofs find elements by stable attributes: a semantic `data-*` the app already uses, else a `data-testid`, and a class only when the class is what's under test. The conventions are in [scripts/lib/README.md](scripts/lib/README.md).

## Latency budgets

Rowkery is meant to feel instant, and the budgets keep it that way. They live in `scripts/budgets.json`. `scripts/lib/latency-judge.mjs` fails a run that is more than 25% + 15 ms slower than the reference run for its platform (`scripts/baselines/reference-*.json`), or that misses a budget the reference met.

A change to `crates/`, `apps/rowkery-tauri/src-tauri/` or the results path runs `scripts/latency-browser-proof.mjs` (the UI thread, in Chromium) and, on a Mac, `scripts/latency-proof.sh` (the packaged app against the test Postgres). Put the before and after numbers for the marks it touches in the pull request. Don't use the Chromium proof for what a browser can't see (process start, IPC, WebKit parsing).

## Commits, branches and pull requests

- **Branches** start with their type: `feat/`, `fix/`, `chore/`, `refactor/` or `perf/`, as in `fix/chip-editor-scroll`.
- **Commit messages** follow the same types, with an optional scope: `fix(ui): keep the chip editor's list in view`.
- **Pull requests** stay under about 1,500 changed lines. Split bigger work into stacked branches.
- **The description is the changelog.** Say what changed, the decisions a reviewer should know about, and how you verified it (which tests and proofs ran, and the latency numbers when they apply). The [pull request template](.github/pull_request_template.md) lays this out.

## Reporting bugs and security issues

Use **Help › Report an Issue…** in the app, or [open a GitHub issue](https://github.com/rowkery/rowkery/issues/new/choose). Questions and ideas go in [Discussions](https://github.com/rowkery/rowkery/discussions). Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
