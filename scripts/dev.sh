#!/usr/bin/env bash
# Check out the latest version of a branch (or PR) and launch the Tauri app.
#
#   scripts/dev.sh                  # current branch, synced to origin
#   scripts/dev.sh feat/some-thing  # that branch, synced to origin
#   scripts/dev.sh 35               # pull request #35
#
# The local branch is reset to origin (scripts/checkout.sh), since agent
# threads force-push their branches. It stops if you have uncommitted changes.
# It runs as Rowkery Dev (the same settings as `make dmg-dev`): its own config
# folder, keychain items and agent setup, so a branch never sees the
# connections saved in Rowkery. Usually run through `make dev`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"
cd "$root"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

"$root/scripts/checkout.sh" "${1:-}"

# Install npm packages only when the lockfile changed since the last install.
cd "$app"
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  say "Installing npm packages"
  npm install
fi

say "Starting Rowkery Dev (Ctrl+C to stop)"
export ROWKERY_CHANNEL=dev
exec npm run tauri dev -- --config src-tauri/tauri.dev.conf.json
