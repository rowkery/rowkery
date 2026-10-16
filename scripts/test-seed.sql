-- Test seed for the latency and end-to-end proofs: mixed-length table names + a wide result grid.
DROP TABLE IF EXISTS wide_metrics CASCADE;
DROP TABLE IF EXISTS failed_jobs CASCADE;
DROP TABLE IF EXISTS game_wallet_transactions_p0 CASCADE;
DROP TABLE IF EXISTS active_players CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;

CREATE TABLE active_players (
    id SERIAL PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT 'player'
);

CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    label TEXT NOT NULL DEFAULT 'key'
);

CREATE TABLE game_wallet_transactions_p0 (
    id BIGSERIAL PRIMARY KEY,
    timestamp_ms BIGINT NOT NULL,
    player_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    kiosk_id TEXT NOT NULL,
    wallet_db TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    currency TEXT NOT NULL,
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    reference_id TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    notes TEXT NOT NULL
);

CREATE TABLE wide_metrics (
    id SERIAL PRIMARY KEY,
    col_a TEXT,
    col_b TEXT,
    col_c TEXT,
    col_d TEXT,
    col_e TEXT,
    col_f TEXT,
    col_g TEXT,
    col_h TEXT,
    col_i TEXT,
    col_j TEXT,
    col_k TEXT,
    col_l TEXT,
    col_m TEXT,
    col_n TEXT,
    col_o TEXT,
    col_p TEXT,
    col_q TEXT,
    col_r TEXT,
    col_s TEXT,
    col_t TEXT
);

INSERT INTO active_players (nickname) VALUES ('alpha'), ('beta');
INSERT INTO api_keys (label) VALUES ('kiosk'), ('admin');
INSERT INTO game_wallet_transactions_p0 (
    timestamp_ms, player_id, entity_id, kiosk_id, wallet_db, wallet_id, server_id, type,
    amount_cents, currency, balance_before, balance_after, reference_id, external_ref,
    metadata_json, created_by, updated_by, notes
)
SELECT
    1_700_000_000_000 + g,
    'player-' || g,
    'entity-' || g,
    'kiosk-' || (g % 5),
    'wallet_db',
    'wallet-' || g,
    'srv-1',
    'credit',
    100 * g,
    'USD',
    1000,
    1000 + 100 * g,
    'ref-' || g,
    'ext-' || g,
    '{}',
    'seed',
    'seed',
    'ux verify'
FROM generate_series(1, 50) AS g;

INSERT INTO wide_metrics (col_a, col_b, col_c, col_d, col_e, col_f, col_g, col_h, col_i, col_j, col_k, col_l, col_m, col_n, col_o, col_p, col_q, col_r, col_s, col_t)
SELECT
    'a' || g, 'b' || g, 'c' || g, 'd' || g, 'e' || g, 'f' || g, 'g' || g, 'h' || g, 'i' || g, 'j' || g,
    'k' || g, 'l' || g, 'm' || g, 'n' || g, 'o' || g, 'p' || g, 'q' || g, 'r' || g, 's' || g, 't' || g
FROM generate_series(1, 20) AS g;

CREATE TABLE failed_jobs (
    id SERIAL PRIMARY KEY,
    uuid TEXT NOT NULL,
    connection TEXT NOT NULL,
    queue TEXT NOT NULL,
    payload TEXT NOT NULL,
    exception TEXT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO failed_jobs (uuid, connection, queue, payload, exception)
SELECT
    'uuid-' || g,
    'database',
    'default',
    '{"job":' || g || '}',
    'Exception for job ' || g
FROM generate_series(1, 120) AS g;

-- Extra tables so the schema sidebar must scroll (UX verification).
DO $$
DECLARE
    n INT;
BEGIN
    FOR n IN 1..28 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS schema_scroll_%s (id SERIAL PRIMARY KEY, label TEXT NOT NULL DEFAULT %L)',
            lpad(n::text, 2, '0'),
            'scroll-' || n
        );
    END LOOP;
END $$;

-- Tauri chrome proof: jsonb, bytea, bigint, long identifier (sidebar click / render safety).
DROP TABLE IF EXISTS verify_chrome_crash_types_long_name CASCADE;
CREATE TABLE verify_chrome_crash_types_long_name (
    id BIGSERIAL PRIMARY KEY,
    big_num BIGINT NOT NULL DEFAULT 9223372036854775807,
    payload JSONB NOT NULL DEFAULT '{"status":"ok","meta":{"n":1}}'::jsonb,
    raw_blob BYTEA NOT NULL DEFAULT decode('cafebabe', 'hex')
);
INSERT INTO verify_chrome_crash_types_long_name (big_num, payload, raw_blob)
VALUES
    (9223372036854775807, '{"tags":["a","b"],"n":42}', decode('0102030405', 'hex')),
    (-1, 'null', decode('00', 'hex'));

-- Structure view proof: defaults, unique + composite + GIN indexes, foreign keys both ways.
DROP TABLE IF EXISTS kiosk_sessions CASCADE;
DROP TABLE IF EXISTS kiosks CASCADE;
CREATE TABLE kiosks (
    id BIGSERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL DEFAULT 'sg',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE kiosk_sessions (
    id BIGSERIAL PRIMARY KEY,
    kiosk_id BIGINT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    player_id INT REFERENCES active_players(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    tags TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX kiosk_sessions_kiosk_started_idx ON kiosk_sessions (kiosk_id, started_at DESC);
CREATE INDEX kiosk_sessions_player_idx ON kiosk_sessions (player_id);
CREATE INDEX kiosk_sessions_tags_gin ON kiosk_sessions USING gin (tags);
COMMENT ON TABLE kiosk_sessions IS 'One row per player visit to a kiosk. Open sessions have no ended_at.';
COMMENT ON COLUMN kiosk_sessions.kiosk_id IS 'The kiosk the session ran on.';
COMMENT ON COLUMN kiosk_sessions.player_id IS 'Null for walk-ins who never signed in.';
INSERT INTO kiosks (code, region)
SELECT 'K' || lpad(g::text, 4, '0'), (ARRAY['sg', 'my', 'th'])[1 + g % 3]
FROM generate_series(1, 40) AS g;
INSERT INTO active_players (nickname) SELECT 'player' || g FROM generate_series(1, 20) AS g;
INSERT INTO kiosk_sessions (kiosk_id, player_id, started_at, tags)
SELECT 1 + g % 40, CASE WHEN g % 7 = 0 THEN NULL ELSE 1 + g % 20 END,
       NOW() - (g || ' minutes')::interval, ARRAY['walk-in']
FROM generate_series(1, 5000) AS g;
ANALYZE kiosks;
ANALYZE kiosk_sessions;
