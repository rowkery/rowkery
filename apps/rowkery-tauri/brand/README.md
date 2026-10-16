# Rowkery brand

The mark is Lucas's own drawing of a penguin (side view, white belly and eye, ground shadow), traced to vector with smooth curves. It is used as drawn: no redesign, only colour and size. One path with `fill-rule="evenodd"`, so the belly and eye are holes.

- `rowkery-mark.svg` — the mark with its ground shadow, `currentColor`.
- `rowkery-mark-no-shadow.svg` — the penguin alone on a flat base, `currentColor`. The app and the website draw this one (`PenguinMark.tsx`, `apps/web/components/Mark.tsx`); `test/penguin.test.ts` checks its checksum and that both draw its path verbatim.
- `rowkery-poses.svg` (CC0) — the penguin's two poses, Ready and Tilted, from the unmodified path. In the app they are a CSS transform (`PenguinMark.tsx`).
- `dmg-background.svg` / `.png` (CC0) — the DMG window's background (660×400, the penguin above the arrow from the app to Applications). `scripts/dmg.sh` passes the PNG to the bundler; re-render it with `node scripts/dmg-background.mjs`.
- `app-icon.svg` — 1024×1024 app icon source: the orange tile with the penguin on Apple's grid (824px tile, 100px margin).

The platform icons (`.icns`, `.ico` and every PNG size) in `src-tauri/icons/` are generated from `app-icon.svg`.

Regenerate every platform icon after changing `app-icon.svg`:

```bash
# render app-icon.svg to a 1024×1024 transparent PNG first, then:
npx tauri icon path/to/app-icon.png -o src-tauri/icons
```
