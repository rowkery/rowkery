#!/usr/bin/env bash
# Check out the latest version of a branch (or PR) and launch the Tauri app.
#
#   scripts/dev.sh                  # current branch, synced to origin
#   scripts/dev.sh feat/some-thing  # that branch, synced to origin
#   scripts/dev.sh 35               # pull request #35
#
# The local branch is reset to origin, since agent threads force-push their
# branches after rebases. It stops instead if you have uncommitted changes.
# It runs as Rowkery Dev (the same settings as `make dmg-dev`): its own config
# folder, keychain items and agent setup, so a branch never sees the
# connections saved in Rowkery. Usually run through `make dev`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"
cd "$root"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

target="${1:-}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short --untracked-files=no
  die "you have uncommitted changes. Commit or stash them first (git stash), then run this again."
fi

if [[ -z "$target" ]]; then
  target="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD is detached; name a branch, e.g. make dev b=main"
fi

if [[ "$target" =~ ^#?[0-9]+$ ]]; then
  pr="${target#\#}"
  branch="pr/$pr"
  say "Fetching pull request #$pr"
  git fetch origin "+pull/$pr/head:refs/remotes/origin/$branch"
else
  branch="$target"
  say "Fetching $branch"
  git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch" \
    || die "no branch '$branch' on origin"
fi

# -B creates the branch or resets it to origin: same as checkout + reset --hard.
git checkout -B "$branch" "origin/$branch" --quiet
git branch --quiet --set-upstream-to="origin/$branch" "$branch" 2>/dev/null || true
say "On $branch at $(git log -1 --format='%h %s')"

# Install npm packages only when the lockfile changed since the last install.
cd "$app"
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  say "Installing npm packages"
  npm install
fi

say "Starting Rowkery Dev (Ctrl+C to stop)"
export ROWKERY_CHANNEL=dev
exec npm run tauri dev -- --config src-tauri/tauri.dev.conf.json
