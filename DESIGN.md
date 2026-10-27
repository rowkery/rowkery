---
name: Rowkery
description: A database tool printed on paper. Opaque rounded sheets on a quiet canvas in black, grey and white, hairline rules, ink that commits and one orange for what you ask.
colors:
  canvas: "#f1f1f0"
  paper: "#ffffff"
  panel: "#f7f7f7"
  bar: "#f3f3f3"
  line: "#e6e6e6"
  line-control: "#d6d6d6"
  row-rule: "#efefef"
  hover: "#ededed"
  fill: "rgba(0, 0, 0, 0.05)"
  fill-hover: "rgba(0, 0, 0, 0.085)"
  text: "#0a0a0a"
  text-2: "#2b2b2b"
  mute: "#5c5c5c"
  dim: "#6b6b6b"
  faint: "#adadad"
  orange: "#d9641a"
  orange-deep: "#c2560f"
  ink: "#0a0a0a"
  ink-fg: "#ffffff"
  ok: "#2e8b57"
  delete: "#c43d3d"
  key-blue: "#2f5bb7"
  warning: "#b7791f"
  sql-keyword: "#8a3fb8"
  sql-function: "#1c6fb5"
  sql-string: "#2e8b57"
  sql-number: "#c2611a"
  sql-comment: "#8c8c8c"
  env-prd: "#d6433f"
  env-stg: "#e38a2e"
  env-dev: "#2f5bb7"
  env-local: "#2e8b57"
  dark-canvas: "#121212"
  dark-paper: "#1a1a1a"
  dark-panel: "#212121"
  dark-bar: "#1e1e1e"
  dark-line: "#2e2e2e"
  dark-line-control: "#3d3d3d"
  dark-hover: "#2a2a2a"
  dark-fill: "rgba(255, 255, 255, 0.06)"
  dark-fill-hover: "rgba(255, 255, 255, 0.1)"
  dark-text: "#ffffff"
  dark-mute: "#a4a8ae"
  dark-dim: "#8b9097"
  dark-orange: "#ff8a3d"
  dark-ok: "#5cc98c"
  dark-delete: "#ef6b6b"
typography:
  display:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.1
  headline:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
  title:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  control:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
  label:
    fontFamily: "IBM Plex Sans, -apple-system, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.08em"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
  editor:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13px"
    lineHeight: "21px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
  window-pill: "10px"
  switch: "10px"
  palette: "16px"
  window: "12px"
spacing:
  title-bar: "48px"
  schema-column: "264px"
  sheet-inset: "8px"
  sheet-gap: "8px"
  tab-row: "42px"
  tab-pill: "28px"
  grid-row: "30px"
  grid-header: "46px"
  foot-bar: "48px"
  inspector: "340px"
components:
  sheet:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    inset: "{spacing.sheet-inset}"
  button-run:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 14px"
  button-run-hover:
    backgroundColor: "{colors.orange-deep}"
  button-commit:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.md}"
    height: "28px"
  button-filled:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 10px"
  button-icon-small:
    rounded: "{rounded.sm}"
    height: "24px"
  input:
    backgroundColor: "{colors.fill}"
    rounded: "{rounded.md}"
    height: "28px"
  chip-filter:
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    height: "26px"
    typography: "{typography.data}"
  badge:
    rounded: "{rounded.xs}"
  query-tab-selected:
    backgroundColor: "{colors.hover}"
    rounded: "{rounded.md}"
    height: "{spacing.tab-pill}"
  window-pill:
    rounded: "{rounded.window-pill}"
    height: "28px"
  card-start:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    padding: "16px 18px"
  list-start:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    padding: "4px"
  list-start-row:
    rounded: "10px"
  view-switch:
    rounded: "{rounded.switch}"
    padding: "3px"
  view-switch-thumb:
    rounded: "7px"
  palette:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.palette}"
    padding: "6px"
  palette-row:
    rounded: "10px"
  inspector-column:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    width: "340px"
  edits-bar:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
    height: "48px"
    inset: "{spacing.sheet-inset}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.pill}"
    height: "34px"
---

# Design System: Rowkery

## Overview

**Creative North Star: "The Printed Sheet"**

Rowkery is a database tool printed on paper: opaque sheets with hairline rules, where every control is a softly filled, familiar component and colour is spent on two things only. Orange marks what you are asking for: the statement under the caret, the filters in the WHERE, Run. Ink commits: the near-black button that writes to the database. Everything else is paper, rule and type. This file is the source of truth for that look (chosen 2026-10-10): the tokens above and the rules below.

The window is dense the way a good ledger is dense: 30 px rows, mono data, tight labels, generous rules between groups rather than boxes around them. The work rests on sheets laid on a canvas (2026-10-24): the title bar and the schema column sit directly on the canvas, and the main column and the inspector are each a rounded sheet of opaque paper, set in from the window's edges. The sheets are still paper, not glass, and inside a sheet regions are still separated by rules, not boxed. Light and dark are the same sheet at two times of day, in the website's colours: white and neutral greys in light, #1a1a1a sheets with #212121 panels on a #121212 canvas and the site's cool greys in the dark, a step greyer than the site's #0a0a0a (2026-10-16); the theme follows macOS (Auto); the schema column's Appearance button cycles Auto / Light / Dark and is the only theme control.

**Key Characteristics:**
- Opaque paper sheets with rounded corners on a grey canvas, in black, grey and white; inside a sheet, structure is 1 px rules, never glass.
- Ink commits, orange is what you ask for; nothing else is coloured except data meaning (ok, delete, key links, environments).
- Fills mean controls: buttons, inputs, chips and pressable cards sit on a soft --fill wash with no border (2026-10-27).
- 600-weight sans names places (connection, Results, Connect to start, a row's title); mono is data and SQL.
- One hover highlight per list that glides from row to row.
- Light and dark follow macOS; both are first-class.

## Colors

The website's palette: white or black sheets, neutral grey rules, black or white ink, one orange.

### Primary
- **Burnt Orange** (orange; dark-orange in the dark): Run, the active statement's bar in the editor, filter chips and their washes (10% / 18%), switches when on, the focus ring. The selected query tab is a neutral --hover pill, not orange (2026-10-24). Hover deepens to orange-deep (dark: #ffa366).

### Secondary
- **Ink** (ink, with ink-fg on it): the button that commits (Commit, Save and connect, Send, Done) and the toast on paper. In the dark the ink is the light text colour with dark paper on it; the dark toast is the panel lifted by the popover shadow instead.

### Neutral
- **Canvas** (canvas; dark-canvas #121212): the window's ground, a step below paper. The title bar and the schema column sit on it with no fill of their own, and the empty window's sheet rests on it (2026-10-24).
- **Paper** (paper): the sheets themselves (the main column and the inspector column) and everything printed on them: grid, editor, modal sheets, cards.
- **Panel** (panel): a half-step darker paper inside a sheet: the edits bar, the dark toast. The schema column and the inspector no longer use it; one sits on the canvas, the other is a paper sheet (2026-10-24).
- **Bar** (bar): head and foot strips inside a sheet.
- **Rule** (line) and **Control Rule** (line-control): 1 px structural rules; line-control is also the pressed chip's wash. **Fill** (fill, fill-hover): the translucent wash every control and card sits on, darker under the pointer; it reads on paper, panel and canvas alike. **Row Rule** (row-rule) rules grid rows; **Hover** (hover) is the glide highlight and keycap ground.
- **Text** (text, text-2), **Mute** (mute), **Dim** (dim), **Faint** (faint): text from strongest to faintest. Faint is for disabled and decoration only, never words a person must read.

### Tertiary (meaning, not decoration)
- **Ok Green**, **Delete Red**, **Key Blue**, **Warning Amber**: new rows and success, deleted rows and errors, foreign-key links, refusals. Washes at 7–14%.
- **Environment tags**: prd red, stg orange, dev blue, local green, as a dot plus a word on a 14–16% wash.
- **SQL tokens**: keyword violet, function blue, string green, number orange-brown, comment grey; brighter twins in the dark.

### Named Rules
**The Ink Commits Rule.** The button that writes to the database is ink (white on black in light; black on white in the dark, like the website's white button). Never orange, never red.

**The Orange Is What You Ask Rule.** Orange appears only on Run, the active statement, the WHERE chips, switches that are on and the focus ring. If orange marks anything else, it is wrong. The selected query tab left this list on 2026-10-24: where you are is not something you asked for, so it is a neutral pill.

**The Text On Fills Rule.** Words on a solid fill use `--onfill`: white on paper, ink in the dark, where the fills are lighter (white on dark orange is 2.3:1, ink 7.4:1). Words on a wash mix 40% ink into their hue on paper (`--tagmix` 60%) and 34% light text in the dark (66%), so env tags and verdict pills clear 4.5:1.

**The Dim Floor Rule.** `--dim` is #6b6b6b on white, so 10.5–12.5 px labels, counts and hints reach 4.5:1 on paper and panel (5:1). Where small text sits on --hover, --kbd or a selected row, it moves to `--mute` instead of retokening --dim.

## Typography

**Display Font:** IBM Plex Sans at 600, behind `--font-display` (no serif; the website's headings are Plex Sans at 500)
**Body Font:** IBM Plex Sans (with the system sans)
**Label/Mono Font:** IBM Plex Mono (with SF Mono, Menlo)

**Character:** One plain, slightly technical sans, the website's: 600 names the places, 400–500 runs the controls; mono carries every value and every line of SQL. The display face is one variable so it can be swapped.

### Hierarchy
- **Display** (600, 30px, 1.1): Connect to start and Couldn't connect.
- **Headline** (600, 24px): the Quick Look row title.
- **Title** (600, 17px, 1.2): the connection name in the schema head; 15px for Results and sheet titles.
- **Body** (400, 13px, 1.4): prose, hints, form text.
- **Control** (500, 12.5px): buttons, tabs, menu rows; 11.5px for meta lines.
- **Label** (600, 10.5px, 0.08em, uppercase): section labels (TABLES, QUERY, WHERE, ACTIVITY).
- **Data** (400, 12.5px mono): grid cells, table names, chips; **Editor** (13px mono on 21px lines).

### Named Rules
**The Heading Names Places Rule.** The 600 display weight is for the names of places and things you are looking at, never for controls or data.

## Layout

A fixed desktop frame on a 12 px-radius window whose ground is the canvas. Inset sheets on that canvas (2026-10-24): the 48 px title bar across the top and the schema column under it at the left (264 px, dragged between 240 and 360) sit directly on the canvas, with no fill of their own and no rule between them and the rest. The title bar holds the traffic lights, one pill per window and +; the shown pill carries its safe mode shield and agent mark, and nothing sits at the right. The main column is a sheet: opaque paper with a 14 px radius (`--r-xl`) and the sheet ring, starting directly under the title bar and at the schema column's edge, inset 8 px from the window's right and bottom edges (and from its left edge only when the schema column is hidden).

The main sheet stacks a 42 px tab row, the table head (QUERY row and WHERE row of chips), the grid (46 px header, 30 px rows, 44 px gutter; row rules only in the body, see Grid) and, while edits wait, the 48 px edits bar docked at its foot. Inside the sheet, regions are still separated by 1 px rules. Query tabs put the editor above a Results card with its own row (count, Export, the zone menu).

The inspector column opens on the right for Quick Look (340 px; 280 under 1100 px; resizable), Review SQL (340 px) and New connection (380 px). It is its own sheet, made the same way as the main one: inset 8 px from the window's right and bottom edges, with an 8 px gap of canvas between it and the main sheet. The grid ends where the gap begins and keeps its column widths. With no connection, the schema column folds and the empty window (Connect to start) is one sheet inset 8 px on every side below the title bar; the title bar keeps only +. The full-window pages (Agents, Settings, a proposal page) are one inset sheet each in the same way, never full-bleed paper under the canvas title bar (2026-10-24). ⌘K opens a card centred near the top of the window. There is no status bar and no footer; confirmations are toasts.

### Named Rules
**The Inspector Column Rule.** A row, a review or a new connection opens in one column on the right, beside the data, never over it: its own sheet beside the main one, across the canvas gap, never layered on top of it. One inspector at a time.

**The Foot Bar Rule.** Staged edits are counted in a bar at the grid's foot (edited / deleted / new, Discard, Review SQL, Commit), not in a floating tray. The bar is a docked capsule: it takes its own space in the main sheet's layout below the last row, so it never floats over or covers a row (2026-10-24). Toasts lift above it.

## Elevation & Depth

Flat inside a sheet. Depth is tonal (canvas, paper, panel, bar) and ruled (1 px lines, often drawn as inset shadows so they take no space), not shadowed. Beyond the small control shadow, two things carry a shadow: the sheets themselves, with a faint ring and a soft drop that lift them off the canvas (2026-10-24), and anything that floats over a sheet.

"Sheet" names two things in this file: the inset sheets (the main and inspector columns, and the empty window) that rest on the canvas, and the modal sheets (Timings, Shortcuts, Connect an agent, Report, Notices) that float over the window as popover cards.

### Shadow Vocabulary
- **Control** (`box-shadow: 0 1px 2px rgba(31, 27, 22, 0.12)`; dark `rgba(0, 0, 0, 0.4)`): raised thumbs (the selected window pill, a selected schema row) and switch knobs.
- **Sheet** (`--sheet-ring`: `box-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04), 0 4px 16px -6px rgba(0,0,0,.06)`; dark `0 0 0 1px rgba(255,255,255,.07), 0 4px 16px -6px rgba(0,0,0,.6)`): the inset sheets on the canvas. The ring is depth, not a border (2026-10-24).
- **Popover** (`box-shadow: 0 12px 32px -8px rgba(31, 27, 22, 0.25), 0 0 0 1px var(--line)`; dark `rgba(0,0,0,.45)` with --line2): menus, pickers, ⌘K, modal sheets.
- **Scrim** (`--scrim`, rgba(31,27,22,.12) / rgba(0,0,0,.4)): the layer behind a modal sheet; it only catches the click away.

### Named Rules
**The Opaque Sheet Rule.** No backdrop-filter on anything; surfaces are opaque paper, and so is the canvas beneath them. The one exception is ⌘K's scrim, which blurs and dims the window behind it so the search stands alone (2026-10-17).

## Shapes

Rounded on a scale, from the keycap up to the sheet (2026-10-24). The CSS reads these tokens instead of hard-coding a radius:

- `--r-xs` **4px**: badges, keycaps, NULL chips.
- `--r-sm` **6px**: small icon buttons (24 px and under).
- `--r-md` **8px**: buttons (Run included), inputs, list rows, query tabs. The window pills in the title bar and the Data / Structure switch are a step rounder, 10px.
- `--r-lg` **12px**: cards, popovers and menus, modal sheets, the edits bar.
- `--r-xl` **14px**: the inset sheets, the cards and grouped lists on Connect to start. ⌘K is a step rounder, 16px.
- `--r-pill` **999px**: filter chips, env tags, the key strip, the toast.

The window itself keeps its 12 px corner. Rules are 1 px structure; controls are fills, not borders.

### Named Rules
**The Concentric Rule.** A rounded thing held snugly inside another rounded thing takes the outer radius minus the padding between them, so the two curves run parallel. The Data / Structure switch is 10px outside with 3px padding, so its thumb is 7px; ⌘K is 16px with 6px padding, so its rows are 10px; a grouped list on Connect to start is 14px with 4px padding, so its rows are 10px. The rule is for snug nesting (padding under 8px). Something set a full 8 px inset away takes its own step on the scale and reads as its own shape: a sheet in the window, the edits bar in the main sheet (2026-10-24).

**The Fills Mean Controls Rule.** A soft --fill wash says something can be pressed or typed in (buttons, inputs, chips, cards on Connect to start, and the grouped lists there, every row of which connects). No grey border around a control: it read cheap (2026-10-27). Controls keep a transparent 1 px border so focus and drag states can colour it orange without moving anything. Two exceptions: a tick box keeps a --dim edge (an empty box on a fill would vanish), and pills floating over rows (the key strip, the tip line) keep their --line ring, which is depth like a sheet's. Regions inside a sheet are separated by rules, not boxed. A sheet's ring is not a border: it is depth, the sheet resting on the canvas.

## Components

### Buttons
- **Shape:** `--r-md` (8px), 28px tall (Run 32px). Small icon buttons (24px and under) take `--r-sm` (6px).
- **Run:** burnt orange fill, `--onfill` text, the run keys beside the word. Flat: no gradient, no glow. Hover orange-deep. On paper the prototype's white on orange is 3.6:1 for the 12.5px bold label (under 4.5:1); kept as drawn, the one known exception, and the dark theme's ink on orange is 5.3:1.
- **Commit (ink):** ink fill, ink-fg text; disabled at 0.5–0.6 opacity.
- **Filled:** --fill ground, no visible border, text colour; hover --fill-hover. Ghost buttons drop the fill.
- **Focus:** a 2px --acc outline at 1px offset, from one zero-specificity rule; components may draw their own.

### Chips
- **Filter chips:** 26px pills (`--r-pill`), orange wash, mono text you can read as SQL; × removes. "+ Filter ⌘F" is a --fill pill.
- **Env tags:** a dot plus the word on its own wash (see the Text On Fills rule), `--r-pill`. **NULL:** a 9.5px uppercase chip in --mute on --hover, `--r-xs`.

### Cards / Containers
- **Corner Style:** `--r-lg` (12px); on Connect to start, `--r-xl` (14px).
- **Background:** --fill, no border; on the Agents page a shared connection is a raised --fill card with the control shadow, and one not shared is flat with no fill.
- **Shadow Strategy:** none at rest.
- **Connect to start** (2026-10-24): the four action cards are `--r-xl` on --fill and 16px 18px padding. Each list (Your connections, Found on this Mac) is grouped on one --fill card: `--r-xl`, 4px padding, 44px rows at 10px (the Concentric Rule), sharing one glide hover.

### Inputs / Fields
- **Style:** --fill ground, no visible border, `--r-md` (8px), 28–30px tall; focus draws the orange ring.
- **Focus:** the orange focus ring.

### Navigation
- **Title bar:** 48px, directly on the canvas: no fill and no rule under it (2026-10-24). Windows are 28px pills at 10px radius (engine logo or the penguin, the name, a 7px environment dot, a spinner / ⚠ when it connects, runs out of sight or failed; × on hover and on the shown one); the shown pill is raised on paper with the control shadow (2026-10-13). The shown pill also carries the safe mode shield while connected and an agent mark while its connection is shared; another pill shows the agent mark, with a green dot, only while an agent read it in the last minute (2026-10-17).
- **Schema column:** directly on the canvas, no fill and no rule against the main sheet (2026-10-24); its rows and filter field are `--r-md`. **Foot:** past a rule, one row of 28px icon buttons 4px apart: Agents (green dot while shared, orange while its page is up), Appearance (sun, moon or half disc for Auto) and Help; names and keys in the tooltips.
- **Tabs:** 42px row; the selected query tab sits on a neutral --hover pill (`--r-md`, 28px tall, centred in the row) that glides from tab to tab when the selection moves. No orange and no underline (2026-10-24).
- **Data / Structure switch:** a segmented control, 10px outside with 3px padding and a 7px thumb (the Concentric Rule).
- **Lists:** schema, pickers, ⌘K, menus and saved connections share the glide hover. ⌘K is a 16px card with 6px padding and 10px rows.

### Grid
A ledger, not a spreadsheet cage (2026-10-24): the body has row rules only (row-rule, `--rowline`), with no vertical rules between cells. The 46px header keeps short vertical separators between columns, a 1px --line inset 14px from its top and bottom, as the affordance for dragging a column wider.

### Glide Hover (signature)
One highlight per list (`useGlideHover`) slides to the row under the pointer instead of each row painting its own :hover. The keyboard cursor keeps its own fill.

### Inspector Column (signature)
Quick Look, Review SQL and New connection: a paper sheet on the right (`--r-xl`, the sheet ring, 8px from the window's right and bottom edges and 8px from the main sheet), 42px head with a serif or mono title and ×, a foot of 24px icon buttons; slides in 24px, leaves faster.

### Edits Bar
A docked capsule at the grid's foot (2026-10-24): 48px tall, inset 8px from the main sheet's sides and bottom, `--r-lg`, panel ground with a 1px --line ring, its buttons `--r-md`. It is part of the layout, below the last row, so it never covers one. Inside: "n changes" with dotted counts, Discard, Review SQL, Commit (ink). While Confirm writes holds a commit, Commit is disabled and the count says it is waiting.

### Toast
An ink capsule (34px, `--r-pill`, `0 8px 24px rgba(0,0,0,.18)`) centred at the bottom of the main column, its action (Undo, View) in orange; in the dark the panel lifted by the popover shadow with a control-rule ring. Reversible actions offer Undo instead of a confirm dialog.

### The Penguin
The posture penguin (Ready / Tilted, the original hand drawing) appears only at dead ends: Connect to start and Couldn't connect.

## Do's and Don'ts

### Do:
- **Do** separate regions inside a sheet with 1px --line rules and set controls on --fill with no visible border.
- **Do** keep orange to Run, the active statement, chips, switches that are on and the focus ring.
- **Do** set the main and inspector columns as paper sheets on the canvas (`--r-xl`, the sheet ring, 8px insets and gap), and take every radius from the scale, nested ones by the Concentric Rule.
- **Do** make the committing button ink.
- **Do** check both themes: every colour is a token defined in light and dark; `scripts/paper-finish-browser-proof.mjs` fails on a light-only colour in dark.
- **Do** keep small text (≤ 12.5px) at 4.5:1 on whatever it sits on, hover included; use --mute, not --dim, on --hover / --kbd / selected rows and for keycaps, hints and placeholders on a --fill.
- **Do** make exits shorter than entries; keyboard-opened overlays appear at once; honour prefers-reduced-motion.

### Don't:
- **Don't** draw a grey border around a button, input, chip or card; give it --fill.
- **Don't** use glass, backdrop-filter or glow; the sheets and the canvas are opaque (⌘K's scrim is the one blur).
- **Don't** hard-code a radius; take it from the `--r-*` scale, or from the Concentric Rule when one shape is nested snugly in another (the window pills, the Data / Structure switch and ⌘K are the named steps between).
- **Don't** draw vertical rules between grid body cells.
- **Don't** colour a commit orange or red.
- **Don't** add a status bar or a footer.
- **Don't** float a row or a form over the data; it opens in the inspector column.
- **Don't** let rows paint their own hover background inside a glide list.
- **Don't** put the penguin on a work surface or beside a running query.
- **Don't** hard-code a hex outside the token blocks in App.css (engine logo colours and the traffic lights excepted).
