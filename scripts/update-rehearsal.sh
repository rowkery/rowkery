#!/usr/bin/env bash
# Update rehearsal on a Mac: an
# installed build finds the next version on a local feed, downloads it,
# installs it when it quits and launches as the new version; a tampered bundle
# is refused and the app stays as it was.
#
# Both versions build the way scripts/release.sh builds (a signed update
# bundle, createUpdaterArtifacts) but with a throwaway key and a plain-HTTP
# feed on 127.0.0.1, so nothing is published and the real key is never used.
# The app's window shows during each run (about 45 s each, three runs).
#
#   scripts/update-rehearsal.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"
work="${ROWKERY_REHEARSAL_DIR:-$(mktemp -d)}"
port="${ROWKERY_REHEARSAL_PORT:-8771}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "the rehearsal installs a macOS app bundle; run it on a Mac."
current="$(node -p "require('$app/src-tauri/tauri.conf.json').version")"
next="$(node -p "'$current'.split('.').map(Number).map((n, i) => (i === 2 ? n + 1 : n)).join('.')")"
mkdir -p "$work/feed" "$work/old" "$work/cfg"
cd "$app"

say "a throwaway signing key in $work"
npx tauri signer generate --ci -w "$work/key" >/dev/null
export TAURI_SIGNING_PRIVATE_KEY="$work/key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
rehearsal="$(PUB="$(cat "$work/key.pub")" node -p '
  JSON.stringify({ plugins: { updater: { pubkey: process.env.PUB.trim(), dangerousInsecureTransportProtocol: true } } })')"
bundle="$root/target/release/bundle/macos"
build() { npm run tauri build -- --bundles app --config "$rehearsal" "$@" 2>&1 | tail -2; }

say "building $next, the update"
build --config "{\"version\":\"$next\",\"bundle\":{\"createUpdaterArtifacts\":true}}"
cp "$bundle/Rowkery.app.tar.gz" "$bundle/Rowkery.app.tar.gz.sig" "$work/feed/"
say "building $current, the installed app"
build
rm -rf "$work/old/Rowkery.app"
ditto "$bundle/Rowkery.app" "$work/old/Rowkery.app"

VERSION="$next" URL="http://127.0.0.1:$port/Rowkery.app.tar.gz" FEED="$work/feed" node -e '
  const fs = require("fs");
  const { VERSION: version, URL: url, FEED: feed } = process.env;
  const signature = fs.readFileSync(`${feed}/Rowkery.app.tar.gz.sig`, "utf8").trim();
  const entry = { signature, url };
  fs.writeFileSync(`${feed}/latest.json`, JSON.stringify({
    version, notes: "Rehearsal", pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  }));
'
python3 -m http.server "$port" --bind 127.0.0.1 -d "$work/feed" >"$work/http.log" 2>&1 &
http_pid=$!
trap 'kill "$http_pid" 2>/dev/null || true' EXIT

installed="$work/Applications/Rowkery.app"
install_old() {
  rm -rf "$installed"
  mkdir -p "$work/Applications"
  ditto "$work/old/Rowkery.app" "$installed"
}
version_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed/Contents/Info.plist"; }
# Runs the installed app for $2 ms; the page's quiet check fires 15 s after load.
run_app() {
  ROWKERY_CONFIG_DIR="$work/cfg" ROWKERY_UPDATE_URL="http://127.0.0.1:$port/latest.json" \
    ROWKERY_AUTO_QUIT_AFTER_MS="$2" "$installed/Contents/MacOS/rowkery-tauri" >"$work/$1.log" 2>&1 \
    || die "the app exited with $? ($work/$1.log)"
}

say "1 · $current finds $next, downloads it, installs it on quit"
install_old
[[ "$(version_of)" == "$current" ]] || die "the installed copy isn't $current"
run_app update 45000
grep -q 'GET /latest.json' "$work/http.log" || die "the app never asked the feed ($work/http.log)"
grep -q 'GET /Rowkery.app.tar.gz' "$work/http.log" || die "the app never downloaded the update ($work/update.log)"
[[ "$(version_of)" == "$next" ]] || die "still $(version_of) after quitting ($work/update.log)"
say "  installed $next"

say "2 · $next launches"
run_app relaunch 10000
say "  ran and quit cleanly"

say "3 · a tampered bundle is refused"
install_old
printf 'x' | dd of="$work/feed/Rowkery.app.tar.gz" bs=1 seek=4096 conv=notrunc 2>/dev/null
run_app tampered 45000
[[ "$(version_of)" == "$current" ]] || die "a tampered update was installed"
say "  refused; still $current"

say "rehearsal passed ($work)"
