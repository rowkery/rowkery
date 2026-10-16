-- The sample database (`sample.rs`): a small arcade chain. Six tables and a
-- view, with foreign keys to follow. Deterministic: no random(), so a reset
-- always puts back the same rows.
PRAGMA foreign_keys = ON;

CREATE TABLE kiosks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  opened_on DATE NOT NULL
);

CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  genre TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL UNIQUE,
  email TEXT,
  joined_at TIMESTAMP NOT NULL
);

CREATE TABLE wallets (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR'
);

CREATE TABLE wallet_tx (
  id INTEGER PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('top_up', 'play', 'refund')),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE kiosk_sessions (
  id INTEGER PRIMARY KEY,
  kiosk_id INTEGER NOT NULL REFERENCES kiosks(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  game_id INTEGER NOT NULL REFERENCES games(id),
  started_at TIMESTAMP NOT NULL,
  minutes INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL
);

CREATE INDEX kiosk_sessions_kiosk ON kiosk_sessions (kiosk_id, started_at);
CREATE INDEX wallet_tx_wallet ON wallet_tx (wallet_id);

INSERT INTO kiosks (id, name, city, opened_on) VALUES
  (1, 'Harbour Front', 'Lisbon', '2021-03-14'),
  (2, 'Old Mill', 'Porto', '2021-06-02'),
  (3, 'Station Hall', 'Utrecht', '2021-09-20'),
  (4, 'Canal Corner', 'Amsterdam', '2022-01-11'),
  (5, 'Market Arcade', 'Ghent', '2022-04-30'),
  (6, 'Riverside', 'Lyon', '2022-08-08'),
  (7, 'Tram Depot', 'Zurich', '2022-11-19'),
  (8, 'Night Pier', 'Brighton', '2023-02-25'),
  (9, 'Glasshouse', 'Copenhagen', '2023-06-17'),
  (10, 'Ferry Gate', 'Hamburg', '2023-10-03'),
  (11, 'Lantern Row', 'Valencia', '2024-03-09'),
  (12, 'North Quay', 'Bergen', '2024-07-21');

INSERT INTO games (id, title, genre, price_cents) VALUES
  (1, 'Neon Drift', 'racing', 200),
  (2, 'Pixel Siege', 'shooter', 150),
  (3, 'Tide Runner', 'platformer', 100),
  (4, 'Glyph Duel', 'fighting', 150),
  (5, 'Orbit Golf', 'sports', 100),
  (6, 'Cave Echo', 'puzzle', 50),
  (7, 'Thunder Lane', 'racing', 250),
  (8, 'Moss Kingdom', 'adventure', 100);

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
INSERT INTO players (id, nickname, email, joined_at)
SELECT i,
  (CASE i % 8 WHEN 0 THEN 'ace' WHEN 1 THEN 'blink' WHEN 2 THEN 'comet' WHEN 3 THEN 'dash'
     WHEN 4 THEN 'echo' WHEN 5 THEN 'fizz' WHEN 6 THEN 'glow' ELSE 'hex' END) || '_' || i,
  CASE WHEN i % 5 = 0 THEN NULL ELSE 'player' || i || '@example.com' END,
  datetime('2023-01-01', '+' || (i * 9) || ' days', '+' || (i * 37 % 1440) || ' minutes')
FROM n;

INSERT INTO wallets (id, player_id, balance_cents, currency)
SELECT id, id, 0, CASE WHEN id % 7 = 0 THEN 'GBP' WHEN id % 11 = 0 THEN 'DKK' ELSE 'EUR' END
FROM players;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
INSERT INTO kiosk_sessions (id, kiosk_id, player_id, game_id, started_at, minutes, paid_cents)
SELECT i,
  1 + (i * 7) % 12,
  1 + (i * 13) % 40,
  1 + (i * 5) % 8,
  datetime('2024-01-01', '+' || (i / 4) || ' days', '+' || (600 + i * 53 % 660) || ' minutes'),
  3 + (i * 17) % 25,
  (SELECT price_cents FROM games WHERE id = 1 + (i * 5) % 8) * (1 + i % 3)
FROM n;

-- Top-ups, one per player per ten sessions, then every session as a play.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
INSERT INTO wallet_tx (wallet_id, amount_cents, kind, created_at)
SELECT 1 + (i * 13) % 40, 2000 + (i % 4) * 1000, 'top_up',
  datetime('2024-01-01', '+' || (i * 5 / 4) || ' days')
FROM n;

INSERT INTO wallet_tx (wallet_id, amount_cents, kind, created_at)
SELECT player_id, -paid_cents, 'play', started_at FROM kiosk_sessions;

INSERT INTO wallet_tx (wallet_id, amount_cents, kind, created_at)
SELECT player_id, paid_cents, 'refund', datetime(started_at, '+1 hour')
FROM kiosk_sessions WHERE id % 50 = 0;

UPDATE wallets SET balance_cents = (
  SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_tx WHERE wallet_tx.wallet_id = wallets.id
);

CREATE VIEW daily_takings AS
SELECT date(s.started_at) AS day, k.city, COUNT(*) AS sessions, SUM(s.paid_cents) AS takings_cents
FROM kiosk_sessions s
JOIN kiosks k ON k.id = s.kiosk_id
GROUP BY day, k.city;
