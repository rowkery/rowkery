#!/usr/bin/env bash
# Run SQL file at scale: generates a SIZE_GB .sql file (scripts/sql-file-gen.mjs,
# never committed), then times Rowkery's run (the sql_file_bench example: the
# app's own scan + run code) against the native tool on the same file:
#   Postgres  pg_dump-shaped file (COPY … FROM stdin)  vs  psql --single-transaction -f
#   SQLite    sqlite3 .dump-shaped file (INSERTs)       vs  sqlite3 DB < file
# and a Cancel partway through each, which must leave nothing behind.
# Prints wall time and peak memory (RSS) for each. Needs node, psql, sqlite3
# and GNU time; Postgres from ROWKERY_PG_* (default the test server on 54329).
#
#   scripts/sql-file-load-test.sh [SIZE_GB] [WORK_DIR] [CANCEL_AFTER_S]
set -euo pipefail

SIZE=${1:-5}
DIR=${2:-$(mktemp -d)}
CANCEL_AFTER=${3:-30}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export ROWKERY_PG_HOST=${ROWKERY_PG_HOST:-127.0.0.1}
export ROWKERY_PG_PORT=${ROWKERY_PG_PORT:-54329}
export ROWKERY_PG_USER=${ROWKERY_PG_USER:-rowkery}
export ROWKERY_PG_DB=${ROWKERY_PG_DB:-rowkery}
export PGPASSWORD=${ROWKERY_PG_PASSWORD:-rowkery}
export ROWKERY_CONFIG_DIR=${ROWKERY_CONFIG_DIR:-$DIR/config}
mkdir -p "$DIR" "$ROWKERY_CONFIG_DIR"

PSQL=(psql -X -q -h "$ROWKERY_PG_HOST" -p "$ROWKERY_PG_PORT" -U "$ROWKERY_PG_USER" -d "$ROWKERY_PG_DB")
TIME=(/usr/bin/time -f '%e s wall, %M KiB peak RSS')

(cd "$ROOT" && cargo build --release -q -p rowkery-core --example sql_file_bench)
BENCH="$ROOT/target/release/examples/sql_file_bench"

pg_reset() { "${PSQL[@]}" -c 'DROP TABLE IF EXISTS public.orders, public.customers' >/dev/null 2>&1; }
pg_rows() { "${PSQL[@]}" -tAc 'SELECT count(*) FROM public.orders' 2>/dev/null || echo 'no table'; }
lite_rows() { sqlite3 "$1" 'SELECT count(*) FROM orders' 2>/dev/null || echo 'no table'; }

echo "== Postgres: ${SIZE} GB pg_dump-shaped file"
node "$ROOT/scripts/sql-file-gen.mjs" pg "$DIR/pg.sql" "$SIZE"
pg_reset
echo "-- psql --single-transaction -f"
"${TIME[@]}" "${PSQL[@]}" -v ON_ERROR_STOP=1 --single-transaction -f "$DIR/pg.sql" >/dev/null
echo "   rows: $(pg_rows)"
pg_reset
echo "-- Rowkery, whole file"
"$BENCH" "$DIR/pg.sql" postgres
echo "   rows: $(pg_rows)"
pg_reset
echo "-- Rowkery, Cancel after ${CANCEL_AFTER} s"
"$BENCH" "$DIR/pg.sql" postgres --cancel-after "$CANCEL_AFTER"
echo "   rows after cancel: $(pg_rows)"
pg_reset
rm -f "$DIR/pg.sql"

echo "== SQLite: ${SIZE} GB sqlite3 .dump-shaped file"
node "$ROOT/scripts/sql-file-gen.mjs" sqlite "$DIR/lite.sql" "$SIZE"
rm -f "$DIR/native.db" "$DIR/rowkery.db"
echo "-- sqlite3 DB < file"
"${TIME[@]}" sh -c "sqlite3 '$DIR/native.db' < '$DIR/lite.sql'"
echo "   rows: $(lite_rows "$DIR/native.db")"
rm -f "$DIR/native.db"
echo "-- Rowkery, whole file"
sqlite3 "$DIR/rowkery.db" 'VACUUM'
"$BENCH" "$DIR/lite.sql" "sqlite:$DIR/rowkery.db"
echo "   rows: $(lite_rows "$DIR/rowkery.db")"
rm -f "$DIR/rowkery.db"
echo "-- Rowkery, Cancel after ${CANCEL_AFTER} s"
sqlite3 "$DIR/rowkery.db" 'VACUUM'
"$BENCH" "$DIR/lite.sql" "sqlite:$DIR/rowkery.db" --cancel-after "$CANCEL_AFTER"
echo "   rows after cancel: $(lite_rows "$DIR/rowkery.db")"
rm -f "$DIR/rowkery.db" "$DIR/lite.sql"
