## What changed

<!-- What this pull request does, and any decisions a reviewer should know about. The description is the changelog. -->

## How it was verified

<!-- Which tests and browser proofs ran. For a change to crates/, src-tauri/ or the results path, the before and after latency numbers. -->

## Checklist

- [ ] The branch starts with `feat/`, `fix/`, `chore/`, `refactor/` or `perf/`, and the change is under about 1,500 lines
- [ ] `cd apps/rowkery-tauri && npm run typecheck && npx vitest run`
- [ ] `cargo fmt --all`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] A UI change ships a browser proof, and the proofs it could affect still pass
- [ ] A dependency change regenerates `THIRD_PARTY_NOTICES.md` (`node scripts/notices.mjs`)

The details are in [CONTRIBUTING.md](https://github.com/rowkery/rowkery/blob/main/CONTRIBUTING.md).
