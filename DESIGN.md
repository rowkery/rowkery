---
name: Rowkery
description: A database tool printed on paper. One opaque sheet in black, grey and white, hairline rules, ink that commits and one orange for what you ask.
colors:
  paper: "#ffffff"
  panel: "#f7f7f7"
  bar: "#f3f3f3"
  line: "#e6e6e6"
  line-control: "#d6d6d6"
  row-rule: "#efefef"
  hover: "#ededed"
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
  dark-paper: "#1a1a1a"
  dark-panel: "#212121"
  dark-bar: "#1e1e1e"
  dark-line: "#2e2e2e"
  dark-line-control: "#3d3d3d"
  dark-hover: "#2a2a2a"
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
  badge: "3px"
  control: "6px"
  card: "8px"
  window: "12px"
  chip: "13px"
spacing:
  title-bar: "48px"
  schema-column: "264px"
  tab-row: "42px"
  grid-row: "30px"
  grid-header: "46px"
  foot-bar: "46px"
  inspector: "340px"
components:
  button-run:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 14px"
  button-run-hover:
    backgroundColor: "{colors.orange-deep}"
  button-commit:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.control}"
    height: "28px"
  button-bordered:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "28px"
    padding: "0 10px"
  chip-filter:
    textColor: "{colors.text}"
    rounded: "{rounded.chip}"
    height: "26px"
    typography: "{typography.data}"
  card-start:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  inspector-column:
    backgroundColor: "{colors.panel}"
    width: "340px"
  edits-bar:
    backgroundColor: "{colors.panel}"
    height: "46px"
---

# Design System: Rowkery

## Overview

**Creative North Star: "The Printed Sheet"**

Rowkery is a database tool printed on paper: one opaque sheet with hairline rules, where every control is a bordered, familiar component and colour is spent on two things only. Orange marks what you are asking for: the statement under the caret, the filters in the WHERE, the active tab, Run. Ink commits: the near-black button that writes to the database. Everything else is paper, rule and type. This file is the source of truth for that look (chosen 2026-10-10): the tokens above and the rules below.

The window is dense the way a good ledger is dense: 30 px rows, mono data, tight labels, generous rules between groups rather than boxes around them. Panels are slightly darker paper, not cards floating on a void. Light and dark are the same sheet at two times of day, in the website's colours: white and neutral greys in light, #1a1a1a with #212121 panels and the site's cool greys in the dark, a step greyer than the site's #0a0a0a (2026-10-16); the theme follows macOS (Auto); the schema column's Appearance button cycles Auto / Light / Dark and is the only theme control.

**Key Characteristics:**
- An opaque black, grey and white ground; structure is 1 px rules, never glass.
- Ink commits, orange is what you ask for; nothing else is coloured except data meaning (ok, delete, key links, environments).
- Borders mean controls: anything with a 1 px border is something you can press.
- 600-weight sans names places (connection, Results, Connect to start, a row's title); mono is data and SQL.
- One hover highlight per list that glides from row to row.
- Light and dark follow macOS; both are first-class.

## Colors

The website's palette: white or black sheets, neutral grey rules, black or white ink, one orange.

### Primary
- **Burnt Orange** (orange; dark-orange in the dark): Run, the active statement's bar in the editor, filter chips and their washes (10% / 18%), the active tab's 2 px underline, switches when on, the focus ring. Hover deepens to orange-deep (dark: #ffa366).

### Secondary
- **Ink** (ink, with ink-fg on it): the button that commits (Commit, Save and connect, Send, Done) and the toast on paper. In the dark the ink is the light text colour with dark paper on it; the dark toast is the panel lifted by the popover shadow instead.

### Neutral
- **Paper** (paper): the sheet itself: main column, grid, editor, sheets, cards.
- **Panel** (panel): the schema column, the inspector column, the edits bar: a half-step darker sheet.
- **Bar** (bar): head and foot strips.
- **Rule** (line) and **Control Rule** (line-control): 1 px structural rules and control borders. **Row Rule** (row-rule) rules grid rows; **Hover** (hover) is the glide highlight and keycap ground.
- **Text** (text, text-2), **Mute** (mute), **Dim** (dim), **Faint** (faint): text from strongest to faintest. Faint is for disabled and decoration only, never words a person must read.

### Tertiary (meaning, not decoration)
- **Ok Green**, **Delete Red**, **Key Blue**, **Warning Amber**: new rows and success, deleted rows and errors, foreign-key links, refusals. Washes at 7–14%.
- **Environment tags**: prd red, stg orange, dev blue, local green, as a dot plus a word on a 14–16% wash.
- **SQL tokens**: keyword violet, function blue, string green, number orange-brown, comment grey; brighter twins in the dark.

### Named Rules
**The Ink Commits Rule.** The button that writes to the database is ink (white on black in light; black on white in the dark, like the website's white button). Never orange, never red.

**The Orange Is What You Ask Rule.** Orange appears only on Run, the active statement, the WHERE chips, the active tab, switches that are on and the focus ring. If orange marks anything else, it is wrong.

**The Text On Fills Rule.** Words on a solid fill use `--onfill`: white on paper, ink in the dark, where the fills are lighter (white on dark orange is 2.3:1, ink 7.4:1). Words on a wash mix 40% ink into their hue on paper (`--tagmix` 60%) and 34% light text in the dark (66%), so env tags and verdict pills clear 4.5:1.

**The Dim Floor Rule.** `--dim` is #6b6b6b on white, so 10.5–12.5 px labels, counts and hints reach 4.5:1 on paper and panel (5:1). Where small text sits on --hover, --kbd or a selected row, it moves to `--mute` instead of retokening --dim.

## Typography

**Display Font:** IBM Plex Sans at 600, behind `--font-display` (like the website; no serif)
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

A fixed desktop frame on a 12 px-radius window: the 48 px title bar across the top (bar ground, a rule under it: traffic lights, one pill per window, +; the shown pill carries its safe mode shield and agent mark, and nothing sits at the right), the schema column under it at the left (264 px, dragged between 240 and 360), then the main column on the paper. The main column stacks a 42 px tab row, the table head (QUERY row and WHERE row of chips), the grid (46 px header, 30 px rows, 44 px gutter) and, while edits wait, the 46 px edits bar at its foot. Query tabs put the editor above a Results card with its own row (count, Export, the zone menu).

The inspector column opens on the right of the main column for Quick Look (340 px; 280 under 1100 px; resizable), Review SQL (340 px) and New connection (380 px); the grid ends where it begins and keeps its column widths. With no connection, the schema column folds and the main column spans the window; the title bar keeps only +. ⌘K opens a card centred near the top of the window. There is no status bar and no footer; confirmations are toasts.

### Named Rules
**The Inspector Column Rule.** A row, a review or a new connection opens in one column on the right, beside the data, never over it. One inspector at a time.

**The Foot Bar Rule.** Staged edits are counted in a bar at the grid's foot (edited / deleted / new, Discard, Review SQL, Commit), not in a floating tray. Toasts lift above it.

## Elevation & Depth

Flat by default. Depth is tonal (paper, panel, bar) and ruled (1 px lines, often drawn as inset shadows so they take no space), not shadowed. Shadows exist only where something floats over the sheet.

### Shadow Vocabulary
- **Control** (`box-shadow: 0 1px 2px rgba(31, 27, 22, 0.12)`; dark `rgba(0, 0, 0, 0.4)`): bordered buttons and switch knobs.
- **Popover** (`box-shadow: 0 12px 32px -8px rgba(31, 27, 22, 0.25), 0 0 0 1px var(--line)`; dark `rgba(0,0,0,.45)` with --line2): menus, pickers, ⌘K, sheets.
- **Scrim** (`--scrim`, rgba(31,27,22,.12) / rgba(0,0,0,.4)): the layer behind a sheet; it only catches the click away.

### Named Rules
**The Opaque Sheet Rule.** No backdrop-filter on anything; surfaces are opaque paper. The one exception is ⌘K's scrim, which blurs and dims the window behind it so the search stands alone (2026-10-17).

## Shapes

Gently rounded: 3 px badges, 6 px controls, 8 px cards and sheets, 13 px pill chips, the 12 px window. Borders are 1 px. Rules are structure; borders are controls.

### Named Rules
**The Borders Mean Controls Rule.** A 1 px border around something says it can be pressed (buttons, inputs, cards on Connect to start). Panels and sections are separated by rules, not boxed.

## Components

### Buttons
- **Shape:** 6px radius, 28px tall (Run 32px).
- **Run:** burnt orange fill, `--onfill` text, the run keys beside the word. Flat: no gradient, no glow. Hover orange-deep. On paper the prototype's white on orange is 3.6:1 for the 12.5px bold label (under 4.5:1); kept as drawn, the one known exception, and the dark theme's ink on orange is 5.3:1.
- **Commit (ink):** ink fill, ink-fg text; disabled at 0.5–0.6 opacity.
- **Bordered:** paper ground, 1px control rule, text colour; hover --hover. Ghost buttons drop the border.
- **Focus:** a 2px --acc outline at 1px offset, from one zero-specificity rule; components may draw their own.

### Chips
- **Filter chips:** 26px pills (13px radius), orange wash, mono text you can read as SQL; × removes. "+ Filter ⌘F" is dashed.
- **Env tags:** a dot plus the word on its own wash (see the Text On Fills rule). **NULL:** a 9.5px uppercase chip in --mute on --hover.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** paper on paper with a 1px control rule (Connect to start cards); Agents connection cards the same.
- **Shadow Strategy:** none at rest.

### Inputs / Fields
- **Style:** paper ground, 1px control rule, 6px radius, 28–30px tall.
- **Focus:** the orange focus ring.

### Navigation
- **Title bar:** bar ground, 48px. Windows are 28px pills (engine logo or the penguin, the name, a 7px environment dot, a spinner / ⚠ when it connects, runs out of sight or failed; × on hover and on the shown one); the shown pill is raised on paper with the control shadow (2026-10-13). The shown pill also carries the safe mode shield while connected and an agent mark while its connection is shared; another pill shows the agent mark, with a green dot, only while an agent read it in the last minute (2026-10-17).
- **Schema column foot:** past a rule, one row of 28px icon buttons 4px apart: Agents (green dot while shared, orange while its page is up), Appearance (sun, moon or half disc for Auto) and Help; names and keys in the tooltips.
- **Tabs:** 42px row; the active tab is underlined 2px in orange.
- **Lists:** schema, pickers, ⌘K, menus and saved connections share the glide hover.

### Glide Hover (signature)
One highlight per list (`useGlideHover`) slides to the row under the pointer instead of each row painting its own :hover. The keyboard cursor keeps its own fill.

### Inspector Column (signature)
Quick Look, Review SQL and New connection: a panel-ground column on the right, 42px head with a serif or mono title and ×, a foot of 24px icon buttons; slides in 24px, leaves faster.

### Edits Bar
46px panel strip at the grid's foot: "n changes" with dotted counts, Discard, Review SQL, Commit (ink). While Confirm writes holds a commit, Commit is disabled and the count says it is waiting.

### Toast
An ink card (34px, 8px radius, `0 8px 24px rgba(0,0,0,.18)`) centred at the bottom of the main column, its action (Undo, View) in orange; in the dark the panel lifted by the popover shadow with a control-rule ring. Reversible actions offer Undo instead of a confirm dialog.

### The Penguin
The posture penguin (Ready / Tilted, the original hand drawing) appears only at dead ends: Connect to start and Couldn't connect.

## Do's and Don'ts

### Do:
- **Do** separate regions with 1px --line rules and give controls a 1px --line2 border.
- **Do** keep orange to Run, the active statement, chips, the active tab, switches that are on and the focus ring.
- **Do** make the committing button ink.
- **Do** check both themes: every colour is a token defined in light and dark; `scripts/paper-finish-browser-proof.mjs` fails on a light-only colour in dark.
- **Do** keep small text (≤ 12.5px) at 4.5:1 on whatever it sits on; use --mute, not --dim, on --hover / --kbd / selected rows.
- **Do** make exits shorter than entries; keyboard-opened overlays appear at once; honour prefers-reduced-motion.

### Don't:
- **Don't** use glass, backdrop-filter or glow; the sheet is opaque (⌘K's scrim is the one blur).
- **Don't** colour a commit orange or red.
- **Don't** add a status bar or a footer.
- **Don't** float a row or a form over the data; it opens in the inspector column.
- **Don't** let rows paint their own hover background inside a glide list.
- **Don't** put the penguin on a work surface or beside a running query.
- **Don't** hard-code a hex outside the token blocks in App.css (engine logo colours and the traffic lights excepted).
