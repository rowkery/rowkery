#!/usr/bin/env bash
# Check out the latest version of a branch or pull request, as on origin.
#
#   scripts/checkout.sh                  # current branch, synced to origin
#   scripts/checkout.sh feat/some-thing  # that branch
#   scripts/checkout.sh 35               # pull request #35 (or #35)
#
# The local branch is reset to origin, since agent threads force-push their
# branches after rebases. It stops instead if you have uncommitted changes.
# Used by scripts/dev.sh and scripts/dmg.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

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
  git fetch origin "+pull/$pr/head:refs/remotes/origin/$branch" \
    || die "no pull request #$pr on origin"
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
