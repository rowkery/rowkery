# Proof helpers

- `frames-shim.js`: lets a stubbed `invoke` answer `run_query` with a whole result while the app expects frames. It also pins the platform to Linux (below).
- `linux-platform.js`: the same platform pin, for a proof that doesn't load `frames-shim.js`.
- `latency-judge.mjs`: judges a latency run against `scripts/budgets.json` and the platform's reference run.

## Keys and the platform

Proofs pass on the Linux runner and on a Mac alike.

- The app is told it runs on Linux: `frames-shim.js` (or `linux-platform.js`) pins `navigator.platform` and the user agent, so it shows Ctrl keys and Linux labels wherever Chromium runs. A proof about macOS keys sets `navigator.platform` to `MacIntel` in its stub, after the pin.
- Press app shortcuts as the app's platform has them: `Control+K` under the pin, `Meta+K` in a proof that pins macOS.
- Editing inside a text field follows the machine running Chromium: select all is `ControlOrMeta+A`; the start / end of the text is `Meta+ArrowUp` / `Meta+ArrowRight` when `process.platform === "darwin"`, else `Control+Home` / `End`.
- A ⌘- or Ctrl-click is `{ modifiers: ["ControlOrMeta"] }`: Chromium on a Mac turns a Ctrl-click into a right-click.
- Count a grid's rows and columns with `data-row-count` / `data-col-count`. `aria-rowcount` / `aria-colcount` include the header row and the row-number column.

## Selectors in proofs

Proofs find elements by stable attributes, never by CSS class or visible text, so a restyle or a copy change doesn't break them.

- An element the app already marks with a semantic `data-*` attribute of its own is found by it: `[data-row="3"] [data-col="2"]`, `[data-header="amount"]`, `[data-sql-line]`, `[data-item="cmd:timings"]`, `[data-menu]`, `[data-toast]`, `[data-conn-id="pg"]`, `[data-table="wallet.public.wallet_tx"]`. Don't add a `data-testid` beside one. (`data-item` is shared by palette rows and menu items, so palette rows also carry `data-testid="cp-row"`.)
- Everything else carries `data-testid`, named after the element's role in kebab-case (usually its component class: `data-testid="query-tab"`). One element, one test id; give its variants a data attribute instead (`[data-testid="rail-mark"][data-kind="warn"]`).
- State is an attribute, not a class: `aria-selected="true"`, `aria-pressed`, `data-on`, `data-preview`, `data-state="running"`, `data-cursor`, `data-sidebar-hidden`.
- Pick tabs and columns by their data (`[data-title="Query 2"]`, `[data-header="status"]`), not by `:has-text`, `text=` or `nth-child`.
- A proof that checks a visual class on purpose (a syntax colour, an animation, a dim prefill) may select it, with a `// Class on purpose:` comment saying why. The same goes for text that is itself under test (`// Text on purpose:`).
