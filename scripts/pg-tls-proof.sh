#!/usr/bin/env bash
# Proves the Postgres SSL modes (Off / Prefer / Require / Verify) against two
# throwaway Docker servers: one with TLS on a private CA, one without TLS.
# Runs crates/rowkery-core/tests/postgres_tls.rs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$(mktemp -d)"
TLS_PORT=55431
PLAIN_PORT=55432
DOCKER=docker
docker ps >/dev/null 2>&1 || DOCKER="sudo docker"

cleanup() {
  $DOCKER rm -f rowkery-pg-tls rowkery-pg-plain >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

cd "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 \
  -subj "/CN=Rowkery Test CA" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout other-ca.key -out other-ca.crt -days 2 \
  -subj "/CN=Other CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 2 -extfile ext.cnf 2>/dev/null
# The postgres image runs as uid 999 and wants the key private to it.
mkdir certs && cp server.crt server.key certs/
chmod 600 certs/server.key
$DOCKER run --rm -v "$DIR/certs:/c" alpine chown -R 999:999 /c >/dev/null

$DOCKER rm -f rowkery-pg-tls rowkery-pg-plain >/dev/null 2>&1 || true
$DOCKER run -d --name rowkery-pg-tls -p "$TLS_PORT:5432" \
  -e POSTGRES_USER=rowkery -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$DIR/certs:/certs:ro" postgres:16 \
  -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key >/dev/null
$DOCKER run -d --name rowkery-pg-plain -p "$PLAIN_PORT:5432" \
  -e POSTGRES_USER=rowkery -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null

for name in rowkery-pg-tls rowkery-pg-plain; do
  for _ in $(seq 1 60); do
    $DOCKER exec "$name" pg_isready -h 127.0.0.1 -U rowkery >/dev/null 2>&1 && break
    sleep 1
  done
done

cd "$ROOT"
ROWKERY_TLS_DIR="$DIR" ROWKERY_TLS_PORT=$TLS_PORT ROWKERY_PLAIN_PORT=$PLAIN_PORT \
  cargo test -p rowkery-core --features postgres-integration --test postgres_tls -- --nocapture
