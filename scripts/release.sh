#!/usr/bin/env bash
# Build a release of Rowkery on a Mac: the universal DMG, the signed update
# bundle and the update feed (latest.json). Releases are published on the
# public repo's GitHub Releases (ROWKERY_RELEASES_REPO, default rowkery/rowkery):
#   <repo>/releases/latest/download/latest.json   the feed the app checks (built in here)
#   <repo>/releases/latest/download/Rowkery.dmg   the website's download link
# GitHub's "latest" is the newest published full release, never a draft or a
# pre-release.
#
#   scripts/release.sh           # build into target/release-out/v<version>/
#   scripts/release.sh publish   # build, then a DRAFT release here, tagged at
#                                # this commit; publish it to ship it
#
# Needs, once: scripts/updater-key.sh (the update signing key, with its public
# half in tauri.conf.json), and the repo public, since installed copies fetch
# the feed and the bundle without signing in. The key's password comes from
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD or a prompt. Help > Report an Issue needs
# VITE_ROWKERY_REPORT_URL (env or apps/rowkery-tauri/.env; ALLOW_NO_REPORT_URL=1
# builds without it). Release notes: docs/releases/v<version>.md if present.
#
# Signed and notarised with a Developer ID: Tauri signs with
# APPLE_SIGNING_IDENTITY (or bundle.macOS.signingIdentity) and notarises with
# an App Store Connect API key (APPLE_API_ISSUER, APPLE_API_KEY,
# APPLE_API_KEY_PATH) or an Apple ID (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID).
# Without them it stops; ALLOW_UNSIGNED=1 builds an unsigned copy on purpose
# (users then open it with System Settings > Privacy & Security > Open
# Anyway). Usually run through `make release`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"
conf="$app/src-tauri/tauri.conf.json"
repo="${ROWKERY_RELEASES_REPO:-rowkery/rowkery}"
key="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/rowkery-updater.key}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

publish=false
case "${1:-}" in
  "") ;;
  publish) publish=true ;;
  *) die "unknown option '$1'; use 'make release' or 'make release publish'" ;;
esac

[[ "$(uname -s)" == Darwin ]] || die "a release can only be built on macOS."
conf_get() { node -p "const c=require('$conf'); $1"; }
version="$(conf_get 'c.version')"
tag="v$version"
[[ -n "$(conf_get 'c.plugins.updater.pubkey')" ]] \
  || die "tauri.conf.json has no updater public key; run scripts/updater-key.sh once"
[[ -f "$key" ]] || die "no update signing key at $key; run scripts/updater-key.sh once"
pkg_version="$(node -p "require('$app/package.json').version")"
# The crates share [workspace.package] version in the root Cargo.toml.
crate_version="$(awk '/^\[/{w=($0=="[workspace.package]")} w && /^version *=/{gsub(/.*= *"|".*/,""); print; exit}' "$root/Cargo.toml")"
[[ "$pkg_version" == "$version" && "$crate_version" == "$version" ]] \
  || die "versions disagree: tauri.conf.json $version, package.json $pkg_version, Cargo.toml $crate_version"
git -C "$root" diff --quiet HEAD -- || die "uncommitted changes: a release must match a commit"
report_url="${VITE_ROWKERY_REPORT_URL:-$(sed -n 's/^VITE_ROWKERY_REPORT_URL=//p' "$app/.env" 2>/dev/null | head -1)}"
if [[ -z "$report_url" ]]; then
  [[ "${ALLOW_NO_REPORT_URL:-}" == 1 ]] \
    || die "VITE_ROWKERY_REPORT_URL is unset, so Report an Issue could only copy (ALLOW_NO_REPORT_URL=1 to build anyway)"
fi
identity="${APPLE_SIGNING_IDENTITY:-$(conf_get 'c.bundle?.macOS?.signingIdentity ?? ""')}"
notarise=false
[[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] && notarise=true
[[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] && notarise=true
signed=true
if [[ -z "$identity" ]] || ! $notarise; then
  [[ "${ALLOW_UNSIGNED:-}" == 1 ]] \
    || die "no Apple signing identity or notarisation credentials (see the top of this script), so Gatekeeper would block the build (ALLOW_UNSIGNED=1 to build it anyway)"
  signed=false
fi
if $signed; then
  [[ "$identity" != "-" ]] || die "an ad-hoc identity ('-') isn't a Developer ID"
  # Read whole first: `grep -q` quitting early can fail the pipe (pipefail).
  identities="$(security find-identity -v -p codesigning)"
  grep -F -- "$identity" <<<"$identities" >/dev/null \
    || die "the keychain has no code signing identity matching '$identity'"
fi
releases="https://github.com/$repo/releases"
feed="$releases/latest/download/latest.json"
if $publish; then
  command -v gh >/dev/null || die "publish needs the GitHub CLI (gh)"
  gh release view "$tag" --repo "$repo" >/dev/null 2>&1 && die "$repo already has a release $tag"
  [[ -n "$(git -C "$root" branch -r --contains HEAD 2>/dev/null)" ]] || die "push this commit first: the release is tagged at it"
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]]; then
  read -rsp "Password for $key: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
fi
export TAURI_SIGNING_PRIVATE_KEY="$key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD

say "Rowkery $version ($(git -C "$root" rev-parse --short HEAD)) for Apple Silicon and Intel"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd "$app"
npm install --no-audit --no-fund
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg \
  --config "{\"bundle\":{\"createUpdaterArtifacts\":true},\"plugins\":{\"updater\":{\"endpoints\":[\"$feed\"]}}}"

bundle="$root/target/universal-apple-darwin/release/bundle"
out="$root/target/release-out/$tag"
rm -rf "$out"
mkdir -p "$out"
dmg="$(ls -t "$bundle"/dmg/*.dmg | head -1)"
if $signed; then
  # What Gatekeeper will check on a user's Mac: signed, accepted, and the
  # notarisation ticket stapled to the app.
  say "checking the app's signature and notarisation"
  codesign --verify --deep --strict "$bundle/macos/Rowkery.app" || die "the app's signature doesn't verify"
  spctl --assess --type exec -vv "$bundle/macos/Rowkery.app" || die "Gatekeeper would refuse the app"
  xcrun stapler validate "$bundle/macos/Rowkery.app" || die "the app has no notarisation ticket stapled"
else
  say "NOT NOTARISED build (ALLOW_UNSIGNED=1): Gatekeeper will block it until users choose Open Anyway"
fi
# A stable name, so the website can link releases/latest/download/Rowkery.dmg.
cp "$dmg" "$out/Rowkery.dmg"
cp "$bundle/macos/Rowkery.app.tar.gz" "$out/Rowkery.app.tar.gz"
cp "$bundle/macos/Rowkery.app.tar.gz.sig" "$out/Rowkery.app.tar.gz.sig"

notes_file="$root/docs/releases/$tag.md"
if [[ -f "$notes_file" ]]; then cp "$notes_file" "$out/notes.md"; else echo "Rowkery $version" > "$out/notes.md"; fi

# The feed: both Mac architectures get the universal bundle.
# The bundle's URL names this tag, so a feed always fetches its own bundle.
URL="$releases/download/$tag/Rowkery.app.tar.gz" \
VERSION="$version" OUT="$out" node -e '
  const fs = require("fs");
  const { URL: url, VERSION: version, OUT: out } = process.env;
  const signature = fs.readFileSync(`${out}/Rowkery.app.tar.gz.sig`, "utf8").trim();
  const notes = fs.readFileSync(`${out}/notes.md`, "utf8").trim();
  const entry = { signature, url };
  const feed = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  };
  fs.writeFileSync(`${out}/latest.json`, JSON.stringify(feed, null, 2) + "\n");
'
(cd "$out" && shasum -a 256 Rowkery.dmg Rowkery.app.tar.gz > SHA256SUMS)
say "built $out (the app checks $feed)"
ls -lh "$out"

if $publish; then
  say "draft release $tag on $repo"
  gh release create "$tag" --repo "$repo" --target "$(git -C "$root" rev-parse HEAD)" --draft --title "Rowkery $version" \
    --notes-file "$out/notes.md" \
    "$out/Rowkery.dmg" "$out/Rowkery.app.tar.gz" "$out/Rowkery.app.tar.gz.sig" "$out/latest.json" "$out/SHA256SUMS"
  say "review it, then publish: gh release edit $tag --repo $repo --draft=false"
  say "(a full release, not a pre-release: GitHub's latest is only those)"
  say "then: $feed is the feed, $releases/latest/download/Rowkery.dmg the download link"
fi
