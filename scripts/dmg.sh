#!/usr/bin/env bash
# Build a release DMG of Rowkery on a Mac.
#
#   scripts/dmg.sh            # for this Mac's chip
#   scripts/dmg.sh universal  # one DMG for Apple Silicon and Intel
#   scripts/dmg.sh dev        # Rowkery Dev (also: dev universal; make dmg-dev)
#   scripts/dmg.sh dev 74     # Rowkery Dev of pull request #74 (or a branch:
#                             # dev feat/some-thing; make dmg-dev 74), then back
#
# Rowkery Dev is the build for testing a branch: its own name, bundle id
# (tauri.dev.conf.json), config folder, keychain items and agent entry, and no
# updater feed, so it installs beside Rowkery and never touches its data.
# Given a pull request or branch, it first checks that out as on origin
# (scripts/checkout.sh, like `make dev 74`) and returns to your branch after;
# without one it builds what is checked out now.
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

args=(--bundles dmg)
out="$root/target/release/bundle/dmg"
dev=""
universal=""
target=""
for opt in "$@"; do
  case "$opt" in
    universal)
      universal=1
      args+=(--target universal-apple-darwin)
      out="$root/target/universal-apple-darwin/release/bundle/dmg"
      ;;
    dev)
      dev=1
      export ROWKERY_CHANNEL=dev
      args+=(--config src-tauri/tauri.dev.conf.json)
      ;;
    *)
      # Release builds come from the current checkout only.
      [[ -z "$target" && -n "$dev" ]] \
        || die "unknown option '$opt'; use 'make dmg', 'make dmg universal', 'make dmg-dev' or 'make dmg-dev 74'"
      target="$opt"
      ;;
  esac
done

if [[ -n "$target" ]]; then
  # Go back to where you were afterwards, so the next `make dmg-dev 75` runs
  # this script rather than the pull request's own (maybe older) copy.
  back="$(git -C "$root" symbolic-ref --quiet --short HEAD || git -C "$root" rev-parse HEAD)"
  "$root/scripts/checkout.sh" "$target"
  trap 'git -C "$root" checkout --quiet "$back" && say "back on $back" || printf "\033[1;31merror:\033[0m could not go back to %s; run: git checkout %s\n" "$back" "$back" >&2' EXIT
fi
[[ -z "$dev" ]] || say "building Rowkery Dev"
if [[ -n "$universal" ]]; then
  say "adding the Apple Silicon and Intel Rust targets"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
fi

# The DMG window (tauri.macos.conf.json): the penguin's background
# (brand/dmg-background.png, rendered from the SVG by
# scripts/dmg-background.mjs), the app left, Applications right.
background="$app/brand/dmg-background.png"
[[ -f "$background" ]] || die "missing $background; run node scripts/dmg-background.mjs"

cd "$app"
say "npm install"
npm install
say "npm run tauri build -- ${args[*]}"
npm run tauri build -- "${args[@]}"

dmg="$(ls -t "$out"/*.dmg 2>/dev/null | head -1)"
[[ -n "$dmg" ]] || die "the build finished but no .dmg is in $out"
say "built $dmg"
[[ -n "${CI:-}" ]] || open -R "$dmg"
