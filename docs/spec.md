# Rowkery: the product spec

What Rowkery is and how it behaves, as it is on `main`. The code is the source of truth. Where this file and the code disagree, the code wins and this file gets fixed.

- **How it looks:** [`DESIGN.md`](../DESIGN.md) holds the visual system: tokens, type, layout sizes, components and the named rules. The tokens themselves live in `apps/rowkery-tauri/src/App.css` (`:root` and `:root[data-theme="dark"]`).
- **Rules for changing it:** [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md) (the quality gate, browser proofs, latency budgets).
- **Commands and keys:** `apps/rowkery-tauri/src/commands.ts` is the one registry. This file names the main keys; the registry and the in-app shortcut sheet (⇧⌘/) are the full list.

Keys are written for macOS. Off the Mac, ⌘ is Ctrl; the registry holds the few chords that differ.

## Principles

- **Opens into rows.** A first launch shows the sample database with its first query already run. An empty window lists the ways to connect, with their keys.
- **The SQL is always visible and honest.** On a table tab every gesture (sort, filter, page size, hiding a column) rewrites the one query shown above the grid. Hand-written SQL is never parsed into chips, wrapped or rewritten.
- **The control carries its key.** ⌘K, the macOS menu bar, context menus, tooltips, the key strips, the ⌘-hold hints and the shortcut sheet all read `commands.ts`, so none can drift, and none advertises a key that can't run now.
- **Undo instead of confirm.** Reversible actions happen at once and the toast offers Undo. The only confirmation left is a write to the database, through safe mode.
- **Only you change your data.** Edits are staged and committed by you. Agents read through a guarded, read-only server; a change they propose runs only when you commit it.
- **Environment is a label; safe mode is behaviour.** prd / stg / dev / local colour a connection and never change what it does. Safe mode (Off, Confirm writes, Read-only) is what the database will let you do. Neither is preselected.
- **Speed is measured.** Every interaction on the hot path has a millisecond budget a script enforces (see Speed).
- **No status bar and no footer.** Confirmations are a toast.

## The window

One opaque paper sheet (DESIGN.md, Layout):

- **Title bar** (48 px): the traffic lights, one pill per window (engine logo or the penguin, the connection's name, its environment dot, a spinner or ⚠ while it connects, runs out of sight or failed, × on hover and on the shown one), + for a new window (⌘T). Pills drag to reorder; ⌘1–⌘9 follow the order. On the right, the shown window's Safe mode and MCP (only while connected) and the ⌘K search.
- **Schema column** (left, 264 px, dragged between 240 and 360; ⌘B hides it): a head naming the database in the serif (its chevron opens the database switcher) over a line with the host, latency and environment, the filter box (/), then Pinned, Tables and Views with counts. Its foot is a row of icon buttons: Agents (a green dot while this connection is shared, the count of proposals waiting), Presenting, and Settings (Updates, Appearance, the only theme control, Keyboard with the shortcut sheet, and Agents).
- **Main column:** the tab row (query tabs and table tabs, ‹ › history, +), then the tab's content.
- **Inspector column** (right): Quick Look, Review SQL, New connection, a picked session on the Sessions tab, or a proposal. One at a time, beside the data, never over it. Each kind keeps its dragged width.
- **Edits bar** at the grid's foot while edits are staged, and the **toast** above it.

Each window is one connection and one database. Windows are restored on launch without connecting until one is shown.

## Getting connected

**First launch.** The sample database, a small SQLite file (kiosks, games, players, wallets, wallet_tx, kiosk_sessions and the daily_takings view), is written beside `config.json` from SQL built into the binary (`crates/rowkery-core/src/sample.rs`) and opened writable with safe mode Off. Its Getting started tab has run its SELECT already. ⌘K "Reset the sample database" writes it back; "Open the sample database" brings it back after it was deleted.

**Connect to start** (a window with no connection): the penguin (Ready) above New connection ⌘N, Open a SQLite file… ⌘O, Paste a postgres:// URL ⌘V and Open the sample database ↵; then the saved connections (pinned first, at most eight, then Show all…); then, on macOS, "Found on this Mac": Postgres servers answering on loopback ports 5432, 5433 and 54329 (`local.rs`, a TCP connect, nothing sent). Nothing connects on its own.

**Paste to connect.** ⌘V outside a text field with a `postgres://` / `postgresql://` URL, a libpq keyword string, a `psql -h … -U …` line or a `DATABASE_URL=` line opens New connection filled in. Pasted into the editor, it stays text and the toast offers to connect. ⌘O, a dropped `.sqlite` / `.db` file or a path typed into ⌘K opens a SQLite file, reusing the saved connection on that path when there is one.

**New connection** (inspector column): identity first (name, host, port, database, user, password) with libpq's defaults; a probe runs once host, database and user are filled (never the same values twice, and it stops after two auth failures until a field changes) and a server error lands under the field it is about. Then SSL (Disable, Prefer, Require, Verify; only Verify checks the certificate, against the system store or a CA file), an SSH tunnel (password or key file), and Prefetch on hover. Then Environment (suggested from the name and host: `prod` reads as prd, localhost as local) and Safe mode. Save and connect is the ink button. Editing a saved connection keeps a blank password as the stored one. Delete is one step with Undo.

**Google Cloud SQL.** A Postgres instance on Cloud SQL connects without the Cloud SQL Auth Proxy: `crates/rowkery-core/src/cloudsql/` speaks the same connector protocol in-process. The Admin API's `connectSettings` names the instance's address (public, private or PSC) and its CA; `generateEphemeralCert` signs an hour-long client certificate for an RSA 2048 key made once per run and kept in memory; each session is plain Postgres inside a TLS stream to the instance's port 3307 (`connect_raw`, and a cancel goes the same way). No proxy process and no local port another program could reach. The server certificate must chain to the instance's CA and, unless that CA is the instance's own (`GOOGLE_MANAGED_INTERNAL_CA`), carry one of the instance's DNS names. One dialer per connection is shared by its windows, prefetch and the MCP server while any session is open; within four minutes of expiry a certificate is renewed in the background while it still serves dials, and only a dial with under 30 s left waits for the new one (open sessions don't need it again). A dial that fails on a cached address and certificate, or a session the instance drops right after the handshake, fetches both again and tries once more; a whole dial has 30 s. The Google login is gcloud's Application Default Credentials file (read, never copied: `gcloud auth application-default login`) or a service account key (only that kind of file) in the connection's keychain item, or in the encrypted secrets file where the keychain can't hold it (Windows' Credential Manager); tokens stay in memory. The database login is a password (IAM database login is for later). `host` then only names the instance on screen.

**Couldn't connect** replaces the editor and results: the penguin Tilted, a one-line cause from the error class (`explain.rs`: refused, timeout, DNS, TLS, auth, role, database, SSH auth / timeout / unknown or changed host key, and Cloud SQL's: no gcloud login, missing Cloud SQL Client role, no such instance, Admin API off, no address of that type, Google unreachable, instance unreachable), the raw error in mono, then Retry ⌘R, Edit… ⌘E and Report….

**Switching.** ⇧⌘O switches the window's connection, ⇧⌘D its database. Pins sort to the top of every picker.

## Query tabs

- **Editor:** SQL with syntax colour, the statement under the caret marked by an orange bar, completion from the catalog (⌃Space, or as you type), ranked by your keyword habits. ⌘↵ runs the statement under the caret, ⌥⌘↵ runs them all; ⌘. or Esc cancels. Tab right after `*` in a SELECT list spells out the columns.
- **Results:** the Results card with the count and time, Export… ⇧⌘E (CSV, TSV, JSON or SQL INSERTs, streamed to a file through the native save dialog) and the zone's `…` menu. A free-form read pages through a SQL cursor on the tab's own session (1,000 rows a page; 5,000 or All in the page-size control) and Load more fetches the next page. ⌘K "Copy all results as CSV / TSV" streams the whole result with a count and Cancel. A query with its own LIMIT is left alone.
- **In the grid:** a header click sorts the loaded rows; ⌘F finds in the loaded rows (↵ / ⇧↵ step). A block of cells shows count · sum · avg. ⌘C copies the cell or the block as CSV, ⇧⌘C with column names. When a query reads one table, the cell menu offers Open as table tab.
- **A failed run** shows the server's sentence, the name it probably meant ("Did you mean name?", within two edits, from the completion index) with Replace and run, and the raw text with its SQLSTATE; the editor jumps to the error's position.
- **Plan (⌘E):** the statement's plan in place of the results, as a short tree: one row per step with its own share of the time (or of the cost, for an estimate), the slowest step tinted, row guesses ten times off tagged, and at most one plain hint (`plan.rs`). Explain with timings runs it with ANALYZE; a write goes through safe mode and is rolled back.
- **Session:** each query tab keeps its own warm session between runs, so `SET` and `BEGIN … COMMIT` carry across runs and cancel only ever hits that tab's backend.

## Table tabs

A click in the schema column opens the table in the window's **Preview** tab, which the next click reuses; ⌘-click or a double-click opens a tab of its own. ‹ › (⌘[ ⌘]) walk where the Preview tab has been. ⌥⌘1 / ⌥⌘2 switch between Data and Structure.

The table head has two rows (SqlLine.tsx):

- **QUERY:** the exact SQL that produced the rows, coloured like the editor, its LIMIT as the page-size control, and Edit SQL ⌘E (a new query tab holding exactly this SQL).
- **WHERE:** the filters as orange chips joined by AND, wrapping onto more lines, the dashed + Filter ⌘F, then the count and time, ≈ (click it for an exact COUNT), Load more, Clear sort, refresh and the `…` menu.

A gesture lights the clause it rewrote for a moment with a neutral wash. **Filters:** ⌘F opens the chip editor (column ▾ · operator ▾ · value, value focused first, with completion); the operator reads as a word and writes the SQL the chip shows. Right-click a value for Only rows where / Hide rows where it, or IS NULL. Typing on a selected cell starts a chip on its column once you have made a filter yourself. **Sort:** a header click sorts on the server, asc → desc → off; ⇧-click adds a secondary sort. **Hide a column** from its header menu, with Undo.

**Paging** is by keyset on (sort columns…, primary key), so every row has one place and a page never skips or repeats; a table without a key pages with OFFSET. **Structure** shows columns, keys, indexes and comments. ⌘K "All tables as rows" lists the database's tables as a result. ⌘K "Show sessions" opens the **Sessions** tab (Postgres): every other session on the database, what it waits on and who blocks it, refreshed while it is in front; pick one to cancel its query or end it, through safe mode, on a session of the window's own.

## Quick Look

Space on a row opens it in the inspector column (`QuickLook.tsx`): titled by its name-like value, one field per line, foreign keys followed to a short label of the row they point at, and **Incoming**: the tables whose rows point at this one. ↑↓ walk the rows; ⇥ moves between key lines and → follows the focused one into the Preview tab (⌘→ into a tab of its own); ⌘C copies the row as JSON (numbers stay exact); ⌫ marks it for delete; Esc or Space closes it. In the grid, ⌘↵ follows a cell's foreign key.

## Editing data

Cells are editable on a table tab whose table has a primary key (or SQLite's rowid), on a connection that isn't Read-only. ↵, F2 or a double-click edits a cell with an editor for its type; ⌥⇧N sets NULL; ⌘I inserts a row; ⌘D duplicates one; ⌫ on selected rows marks them for delete. A cell left by a click elsewhere keeps its value as a staged edit; Esc in the cell reverts it.

Staged edits are marked at the cell's edge and in the gutter, and counted in the **edits bar** at the grid's foot: "3 changes" with edited / deleted / new, Review SQL ⇧⌘P, Discard and Commit ⌘S in ink. Esc with nothing open discards them all, with Undo.

**Review SQL** shows the exact transaction. `crates/rowkery-core/src/edits.rs` builds one INSERT, UPDATE or DELETE per row with typed literals and a predicate on the whole primary key. Commit runs them in one transaction that rolls back unless every statement changed exactly one row; the bar then names the row and offers Retry. Edits never run inside a transaction of yours that is open on the tab, and a COMMIT whose connection dropped is never retried.

## Safe mode and environments

- **Safe mode** (Safe mode in the title bar, or ⌘K "Change safe mode…"): Off (the default), Confirm writes, Read-only. `safety.rs` classifies statements in one pass over the SQL with the editor's quoting rules. Under Confirm writes, a write stops before it reaches the database and a strip at the top of the results shows the exact statements: ⇧⌘↵ runs them, Esc drops them (a table tab's edits stay staged). Read-only refuses writes and also opens its sessions read-only at the server, which catches what the classifier can't see (`SELECT delete_user(1)`).
- **Environment** is the window pill's dot plus a word tag on its own wash: prd red, stg orange, dev blue, local green. It never changes behaviour.
- **Presenting** (the schema column's foot) shows a connection's masked columns as dots on screen and hides the host and user, for every window, kept across a restart. Copy still copies the real value.

## Agents (MCP)

`Rowkery --mcp` is a stdio MCP server (`crates/rowkery-mcp`). It reads the same `config.json` and keychain as the app on every call, so sharing changes take effect at once.

- **Tools:** `list_connections`, `list_databases`, `list_tables`, `search_schema`, `describe_table`, `explain`, `query`, `sessions`, `propose_change`, `check_proposal`.
- **Sharing:** only connections with sharing on are visible, and on each only the databases and tables picked in Settings › Agents (`access.rs`), optionally until a time.
- **The guard** (`guard.rs`): every query is one SELECT, runs on a read-only session with a 10 s statement timeout, is capped with a LIMIT, and is refused when its plan reads a big table end to end or reads a table that isn't shared. Functions a read-only session still lets run that signal other sessions, touch server files or settings, hold locks or run a query given as text are refused, found by name in the plan.
- **Masked columns** (`mask.rs`): an agent only ever gets a stand-in (`masked:` and ten hex digits of an HMAC under the connection's own key), and a masked column may only be returned as it is or counted, never filtered on, checked against Postgres's VERBOSE plan.
- **`sessions`** shows what's running with every literal replaced by `?`; a query naming a table that isn't shared is blanked.
- **Proposals** (`proposals.rs`, `change.rs`): `propose_change` takes INSERT / UPDATE / DELETE statements on shared tables with a reason and queues them in `proposals.jsonl`; the agent never gets a session that can write. The app shows each one on the proposal screen (⌘K "Review proposed changes") as a dry run in a transaction it rolls back, old values struck through above the new. Commit (⇧⌘↵) checks the proposal again and runs it only if every statement changes the rows the dry run showed. The queue is untrusted: the connection, the tables and the SQL are checked again before the preview and before the commit. A proposal nobody decides on expires after a day.
- **The Agents page** (⇧⌘A, the foot's Agents button, or the window pill's agent mark, which looks pressed while it shows), in place of the editor and grid: an inbox. Its left column lists Waiting for you (the agents' proposed changes) over Activity (every call, newest first, All or Refused); the picked item shows beside it (a proposal with Dry run and Commit, or a call with what was shared then, the request as sent and the start of the response). A back button naming the window (‹ shop-prd esc) leads the head, on Settings too. Sharing (the connection cards with each one's switch, how long and what it shares; Edit access, which picks databases, then tables; Connect an agent; What can the agent do; Clear log) lives in Settings › Agents, opened from the inbox's Sharing button. The log is `mcp-log.jsonl` and never holds rows; `mcp-samples.jsonl` keeps the first part of each response for 24 hours unless the connection turns samples off.
- **Connect an agent** (⌘K): adds the server to Claude Code (`claude mcp add`) or Claude Desktop (its config file) after showing exactly what will run.

## Keys and learning

- **⌘K** finds tables, recent queries, connections and commands; group headers print their scope prefix, rows print their keys, synonyms match the words people type (help, keys, sample, bug, timings…). A pasted URL or SQLite path is the first row. ↵ opens, ⌥↵ inserts a name into the editor, ⌘↵ opens a table's Structure.
- **Holding ⌘** (Ctrl off the Mac) alone shows a small key pill under every control that has a command, and the window numbers on the pills (`CmdHints.tsx`).
- **Key strips:** the editor's and the grid's foot always show a line of the keys that can run there, at half strength until the pointer is on them. The schema column's strip shows while it has focus and retires once each of its keys has been used three times; ⌘K "Show key hints" brings it back.
- **The shortcut sheet** (⇧⌘/, ? in the grid or the schema column, Help): every command with a key, under the active keymap, plus the gestures; keys you have pressed read bright ("Used n of m"). The keymap picker (Rowkery, TablePlus, DataGrip) swaps only the handful of chords that collide with those apps' habits.
- **The zone `…` menus** (results head, editor foot, schema head) list the zone's commands that can run now, so nothing is ⌘K-only.
- **Tips** (`Tips.ts`): five, earned one at a time, each a 12 px line under its control, retired for good once you do what it teaches. At most one shows, at most one a day, none while a query runs; ⌘K "Hide tips" turns them off.
- **Tooltips** are a verb phrase and the key, read from the registry.

## Undo and Esc

- **Undo, not confirm:** closing a tab or a window, deleting a connection (asked first in its form, as Keep / Delete; its keychain entry is removed only once the toast has gone), discarding staged edits, hiding a column, closing the table tabs a database switch leaves behind. The toast holds 10 s; Undo is its button or ⌥⌘Z wherever focus is. ⌘Z in a text field stays the native text undo.
- **Reopen closed tab** (⇧⌘T) works any time this session: a tab comes back with its SQL, chips and staged edits. It keeps its rows only while the Undo toast is up; reopened later, a table tab browses again and a query tab waits for ⌘↵.
- **⌘W** closes the shown query tab or the shown window, whichever area you used last.
- **Esc** dismisses the nearest thing first (completion, a chip draft, a menu or sheet, Quick Look, a held write, the selection) and cancels the running query when nothing else is open.

## Persistence

Everything the app remembers lives in `config.json` in the app-support folder (`ROWKERY_CONFIG_DIR` overrides it), written through `persist.ts` and core's writer thread (`config_writer.rs`): connections and theme, windows and their tabs with SQL, chips, sort, page size and hidden columns, staged edits, column and panel widths, pins, query history, keyword habits, tips, used keys and the prefetch switch. Writes reach disk at most once a second, as a temp file renamed over the old one, off every hot thread; SQL is saved on blur or idle, never per keystroke. Passwords and other secrets go to the OS keychain, one item per connection (`secrets.rs`); when no keychain is available, or `ROWKERY_CONFIG_DIR` is set, they go to an encrypted file beside the config. Beside `config.json` also live the catalog cache (`catalog/`), the MCP log, samples and the proposal queue.

## Speed

### Budgets

The budgets are in `scripts/budgets.json`; the latency judge (`scripts/lib/latency-judge.mjs`) fails a run more than 25% + 15 ms slower than the platform's reference run, or over a budget the reference met.

| Mark | Budget | Measured by |
| --- | --- | --- |
| Window painted (shell-painted − process-start, warm launch) | ≤ 400 ms | the packaged app |
| Socket warm before the webview is ready | ≤ 0 ms | the packaged app |
| Schema column painted from the cache (after the shell) | ≤ 16 ms | budgeted; no mark records it yet |
| ⌘↵ → first frame, warm session, local Postgres | ≤ 50 ms | the packaged app |
| ⌘↵ → first frame painted | ≤ 66 ms | the packaged app |
| Click a table → its rows painted | ≤ 30 ms | the packaged app |
| ⌘K painted | ≤ 16 ms | Chromium |
| Window switch painted | ≤ 16 ms | Chromium |
| Editor keystroke at 5,000 lines | ≤ 8 ms | Chromium |
| Longest scroll step, 40 columns × 5,000 rows | ≤ 10 ms | Chromium |

### How it gets there

- **Streaming.** A run resolves at once with its query id and streams on a Tauri channel: a JSON columns frame, binary rows frames (Wire format, below) and a JSON done frame. The webview decodes rows into a column store outside React (`resultStore.ts`) that commits at most once per animation frame. Frames are sized to arrive in about 8 ms from the bytes/ms the webview measured on earlier ones (16 KB to 1 MB; 256 KB on WebView2), and rows wait at most 16 ms for more to join their frame.
- **Profiles** (the histogram or top values under each header) are computed once in Rust over the first 5,000 rows (`profile.rs`) and sent in the rows frame that completes the sample. Nothing scans rows in the webview.
- **Paging.** A query tab's free-form read pages through a SQL cursor (`rowkery_page`) on its own session, only when no transaction of yours is open there; it's never wrapped in READ ONLY, so `SELECT nextval()` keeps working. Table tabs page by keyset (above).
- **Warm sessions** (`pool.rs`): each tab keeps its session; each window keeps the session its schema load used as a spare for the first run. Nothing is sent to check a session when it is leased: one known to be closed is replaced first, and a read that fails on a dead socket retries once. Sessions idle for over a minute are pinged in the background when the webview regains focus (the nearest thing to a wake-from-sleep signal); anything unused for 5 minutes is closed. The launch window's connection starts in Rust from `config.json` while the webview boots.
- **Catalog cache** (`catalog_cache.rs`): one file per connection and database, so the schema column paints the moment a window opens; one round trip confirms it against a fingerprint of the catalog's shape and the server version. It is never written after a failed connect, and a file that doesn't parse is a miss.
- **Hover prefetch** (`prefetch.rs`), a per-connection switch, off by default: the first page of the table the pointer rests on, read on the window's own prefetch session as the first FETCH of a cursor the click then continues. One in flight at a time, cancelled on the server by a newer one, a click or the pointer leaving; any write in the window drops the cache; it never prefetches a write.
- **SQLite** runs each query on a dedicated connection with an interrupt handle, so cancel stops it at once.

## Wire format

Each run gets its own `tauri::ipc::Channel` (`on_frame`). On it, in order:

1. **Columns** (JSON): `{ "t": "columns", "query_id", "columns": [{ "name", "type_name" }] }`.
2. **Rows** (binary), any number, described below and in `crates/rowkery-core/src/frames.rs`.
3. **Done** (JSON), the only completion signal: `{ "t": "done", "query_id", "status": "ok" | "error" | "cancelled" | "held", "row_count", "affected_rows", "elapsed_ms", "first_row_ms", "frames", "bytes", "error", "sqlstate", "error_position", "hold", "paged", "more" }`. `error_position` is a 1-based character offset into the statement; `hold` is the safe-mode hold (its action, the mode and the statements) when safe mode stopped the run; `paged` / `more` say the rows are a cursor page and whether `fetch_more` has more.

Every frame carries `query_id`, so a tab drops frames from a run it has replaced or cancelled.

**Rows frames** are little-endian:

```text
header   u32 magic 0x494E4C31 ("INL1") · u8 frame_type (2 = rows) · u8 flags
         (bit0 last rows frame, bit1 profile attached) · u16 reserved ·
         u64 query_id · u32 seq · f64 sent_at_ms (unix epoch ms)       = 28 bytes
rows     u32 row_count · u16 column_count · per column:
         u8 wire_kind · null bitmap (ceil(row_count / 8) bytes, bit set = NULL) · its block
profile  (when flags bit1) the profile block, after the last column
```

Blocks by wire kind. A NULL keeps its slot: zero in a fixed-width block, an empty entry in a string block.

| wire_kind | Block | Holds |
| --- | --- | --- |
| 1 `BOOL` | `u8` per row | booleans |
| 2 `INT32` | `i32` per row | integers that fit in 32 bits |
| 3 `INT64` | string block | larger integers as exact decimal digits |
| 4 `F64` | `f64` per row | floats |
| 5 `NUMERIC` | string block | `numeric` / `decimal` text, never parsed to a double |
| 6 `STRING` | string block | text, dates, times, uuids, arrays and every other type as text |
| 7 `JSON` | string block | `json` / `jsonb` text |
| 8 `BYTES` | per row `u32 length` + the first 16 bytes, zero-padded | `bytea` / blobs (the grid shows `<N bytes>`) |
| 9 `MIXED` | `u8 tag` per row, then for tags 1–6 a `u32 count` and that tag's block holding only its rows, in row order | a column whose cells aren't all one kind (SQLite). Tags: 0 null, 1 int32, 2 int64 (string), 3 f64, 4 string, 5 bytes, 6 bool |

A **string block** is `u32 offsets[row_count + 1]` then the UTF-8 bytes. A column's kind is the one kind all its non-null cells share; a mix of 32- and 64-bit integers is `INT64`; an all-NULL column is `STRING`.

The **profile block** (`profile.rs`) is `u16 n`, then per column: `u8 kind` (0 none, 1 numeric, 2 categorical, 3 boolean, 4 temporal, in epoch ms) · `u8 flags` (bit0 whole-number bins, one per value from `min`) · `u32 sample_rows` · `u32 nulls` · `u32 distinct` (`0xFFFFFFFF` = unique: over 256 distinct values) · `f64 min` · `f64 max` · `u32 bins[14]` · `u8 top_n` (at most 8), then per top value `u32 len` + UTF-8 bytes · `u32 count`.

**Golden files:** `crates/rowkery-core/tests/frames/golden.bin` / `golden.json` and `golden-profile.bin` / `golden-profile.json`. `cargo test -p rowkery-core frames` checks the encoder against them and `test/frames.test.ts` checks the webview's decoder against the same bytes; `UPDATE_GOLDEN=1 cargo test -p rowkery-core frames` rewrites them after a format change.

Exports and copy-all stream on their own channel as JSON progress frames (`{ "t": "progress", "rows" }`, then `{ "t": "done", "rows", "error", "cancelled", "path" }`); the rows never reach the webview.

## Measurement

`timings.ts` records `performance` marks from process start (Rust passes the process's start time to the webview): process-start, webview-ready, shell-painted, socket-warm, browse-click for a click on a table, and per query run-sent, first-frame, first-frame-painted and all-rows, with the done frame's `first_row_ms`, `elapsed_ms`, `frames` and `bytes`. ⌘K **Timings** shows the last ones against their budgets, with Copy.

- `scripts/latency-proof.sh` (macOS) runs the packaged app against the test Postgres with `ROWKERY_TIMINGS_OUT` set, cold then warm, and judges the app marks.
- `scripts/latency-browser-proof.mjs` measures UI-thread costs in Chromium: ⌘K, window switch, keystroke, scroll. It is never cited for what a browser can't see (process start, IPC, WebKit parsing).
- `.github/workflows/latency-webview2.yml` (manual) runs the same proof on Windows under WebView2.

Runs are written to `scripts/baselines/<date>-<platform>-<app|browser>.json`; `reference-*.json` are the runs the judge compares against.

## The penguin

The original hand drawing (`apps/rowkery-tauri/brand/`, `PenguinMark.tsx`), used as drawn: no redesign, only colour and size. Two postures by a CSS transform on the mark: **Ready** (upright) on Connect to start and as an empty window's pill mark, **Tilted** (leaning 10°) on Couldn't connect and the fatal error screen. Never on a work surface (grid, editor, tabs, ⌘K, pickers, sheets, toasts) and never while something loads or runs. No blinking, no idle animation. It never speaks.

## Words

**Used in the UI:** connection, database, schema, table, view, query tab, table tab, window, schema column (or sidebar), Quick Look, Preview (the reused tab), Sample database, Structure, safe mode, environment, Agents.

**Copy:** sentence case; a tooltip is a verb phrase and its key; an error says what happened and what to do, with the raw text beside it; numbers in SQL are printed as sent (`LIMIT 1000`, never `1,000`).
