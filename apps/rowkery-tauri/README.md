# Rowkery app

The Rowkery desktop app: a Tauri 2 shell (`src-tauri/`) around a React and TypeScript front end built with Vite (`src/`). The database work happens in the Rust crates under `crates/` at the repo root.

```bash
npm install
npm run tauri dev   # the app with hot reload (Vite on :1420)
```

What Rowkery is and how to install it is in the root [README.md](../../README.md); building from source, the checks a change has to pass and how pull requests are shaped are in [CONTRIBUTING.md](../../CONTRIBUTING.md).
