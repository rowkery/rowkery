#!/usr/bin/env bash
# Build a release DMG of Rowkery on a Mac.
#
#   scripts/dmg.sh            # for this Mac's chip
#   scripts/dmg.sh universal  # one DMG for Apple Silicon and Intel
#
# The app is unsigned: on another Mac, drag it to Applications, then run
#   xattr -dr com.apple.quarantine /Applications/Rowkery.app
# (or System Settings > Privacy & Security > Open Anyway).
# Usually run through `make dmg`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "a DMG can only be built on macOS."

# The DMG window (tauri.macos.conf.json): the penguin's background
# (brand/dmg-background.png, rendered from the SVG by
# scripts/dmg-background.mjs), the app left, Applications right.
background="$app/brand/dmg-background.png"
[[ -f "$background" ]] || die "missing $background; run node scripts/dmg-background.mjs"

args=(--bundles dmg)
out="$root/target/release/bundle/dmg"
case "${1:-}" in
  "") ;;
  universal)
    say "adding the Apple Silicon and Intel Rust targets"
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    args+=(--target universal-apple-darwin)
    out="$root/target/universal-apple-darwin/release/bundle/dmg"
    ;;
  *) die "unknown option '$1'; use 'make dmg' or 'make dmg universal'" ;;
esac

cd "$app"
say "npm install"
npm install
say "npm run tauri build -- ${args[*]}"
npm run tauri build -- "${args[@]}"

dmg="$(ls -t "$out"/*.dmg 2>/dev/null | head -1)"
[[ -n "$dmg" ]] || die "the build finished but no .dmg is in $out"
say "built $dmg"
[[ -n "${CI:-}" ]] || open -R "$dmg"
