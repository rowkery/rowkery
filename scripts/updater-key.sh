#!/usr/bin/env bash
# Once, before the first release: the key that signs Rowkery's updates.
# Writes the private key to ~/.tauri/rowkery-updater.key (it asks for a
# password) and puts the public key in tauri.conf.json > plugins.updater.
#
# Back up the key file and its password outside this Mac (a password manager).
# Every installed copy only accepts updates signed by this key: lose it and no
# copy can ever update itself again.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/rowkery-tauri"
key="${1:-$HOME/.tauri/rowkery-updater.key}"

die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -e "$key" ]] && die "a key is already at $key: installed copies trust it, so keep using it"
mkdir -p "$(dirname "$key")"
chmod 700 "$(dirname "$key")"
cd "$app"
npx tauri signer generate -w "$key"
[[ -f "$key.pub" ]] || die "no public key at $key.pub"

PUB="$(cat "$key.pub")" CONF="$app/src-tauri/tauri.conf.json" node -e '
  const fs = require("fs");
  const conf = JSON.parse(fs.readFileSync(process.env.CONF, "utf8"));
  conf.plugins.updater.pubkey = process.env.PUB.trim();
  fs.writeFileSync(process.env.CONF, JSON.stringify(conf, null, 2) + "\n");
'
echo
echo "Public key written to apps/rowkery-tauri/src-tauri/tauri.conf.json: commit it."
echo "Now back up $key and its password outside this Mac."
