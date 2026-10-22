#!/usr/bin/env node
// Writes a large .sql file for the Run SQL file load test
// (scripts/sql-file-load-test.sh): `pg` is shaped like `pg_dump -Fp`
// (SETs, CREATE TABLE, COPY … FROM stdin, then keys and an index), `sqlite`
// like `sqlite3 .dump` (one INSERT per row inside BEGIN … COMMIT). Never
// committed; generate it where you run the test.
//
//   node scripts/sql-file-gen.mjs pg|sqlite OUT.sql SIZE_GB

import { createWriteStream } from 'node:fs';

const [kind, out, sizeArg] = process.argv.slice(2);
if (!['pg', 'sqlite'].includes(kind) || !out) {
  console.error('usage: sql-file-gen.mjs pg|sqlite OUT.sql SIZE_GB');
  process.exit(2);
}
const target = Number(sizeArg || 5) * 1024 ** 3;
const file = createWriteStream(out, { highWaterMark: 4 << 20 });
let written = 0;
const write = (text) =>
  new Promise((done) => {
    written += Buffer.byteLength(text);
    if (file.write(text)) done();
    else file.once('drain', done);
  });

const CUSTOMERS = 100_000;
const statuses = ['pending', 'paid', 'shipped', 'refunded'];
const notes = [
  'leave at the door',
  'gift wrap; no receipt',
  "call before delivery, it's a flat",
  'tab\there and a back\\slash',
  '',
  'fragile',
];
const day = (n) => new Date(Date.UTC(2024, 0, 1) + (n % 900) * 86_400_000).toISOString().slice(0, 10);

function pgRow(id) {
  const note = notes[id % notes.length].replaceAll('\\', '\\\\').replaceAll('\t', '\\t');
  return `${id}\t${(id * 7919) % CUSTOMERS + 1}\tuser${id % 50_000}@mail.example.com\t${statuses[id % 4]}\t${((id % 9_000) + 99) / 100}\t${day(id)} 10:${String(id % 60).padStart(2, '0')}:00+00\t${note || '\\N'}\n`;
}

function sqliteRow(id) {
  const note = notes[id % notes.length].replaceAll("'", "''");
  return `INSERT INTO orders VALUES(${id},${(id * 7919) % CUSTOMERS + 1},'user${id % 50_000}@mail.example.com','${statuses[id % 4]}',${((id % 9_000) + 99) / 100},'${day(id)} 10:${String(id % 60).padStart(2, '0')}:00','${note}');\n`;
}

const tail = kind === 'pg' ? 600 : 300;

if (kind === 'pg') {
  await write(`--
-- PostgreSQL database dump
--

\\restrict loadtest

-- Dumped from database version 16.4
-- Dumped by pg_dump version 16.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

DROP TABLE IF EXISTS public.orders;
DROP TABLE IF EXISTS public.customers;

CREATE TABLE public.customers (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    email text NOT NULL,
    status text NOT NULL,
    total numeric(10,2) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    note text
);

COPY public.customers (id, name) FROM stdin;
`);
  let rows = '';
  for (let id = 1; id <= CUSTOMERS; id++) rows += `${id}\tCustomer ${id}\n`;
  await write(`${rows}\\.\n\nCOPY public.orders (id, customer_id, email, status, total, created_at, note) FROM stdin;\n`);
} else {
  await write(`PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, created_at TEXT NOT NULL, note TEXT);
`);
}

const row = kind === 'pg' ? pgRow : sqliteRow;
let id = 0;
while (written < target - tail) {
  let chunk = '';
  for (let i = 0; i < 20_000; i++) chunk += row(++id);
  await write(chunk);
}

if (kind === 'pg') {
  await write(`\\.

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

--
-- PostgreSQL database dump complete
--

\\unrestrict loadtest
`);
} else {
  await write(`CREATE INDEX orders_customer_id ON orders(customer_id);
COMMIT;
`);
}
file.end();
await new Promise((done) => file.on('finish', done));
console.error(`${out}: ${(written / 1024 ** 3).toFixed(2)} GB, ${id} rows`);
