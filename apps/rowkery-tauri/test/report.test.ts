// What the Report an Issue sheet sends (`report.ts`): hosts, users, databases
// and paths masked in errors, the app line and the plain-text form.
// @ts-nocheck -- fixtures are partial connection objects
import { test } from "vitest";
import assert from "node:assert/strict";
import * as r from "../src/report";

const pg = {
  kind: "postgres",
  id: "prd",
  name: "wallet",
  host: "wallet-prd.db.internal",
  port: 5432,
  database: "wallet",
  username: "app",
  ssh: { host: "bastion.acme.io", port: 22, username: "alice", auth_method: "keyfile" },
};

test("masks the connection's host, user and database", () => {
  assert.equal(
    r.maskSensitive("error connecting to wallet-prd.db.internal:5432: Connection refused", pg),
    "error connecting to ‹host›:5432: Connection refused",
  );
  assert.equal(
    r.maskSensitive('password authentication failed for user "app"', pg),
    'password authentication failed for user "‹user›"',
  );
  assert.equal(r.maskSensitive('database "wallet" does not exist', pg), 'database "‹database›" does not exist');
  assert.equal(r.maskSensitive("ssh to bastion.acme.io as alice failed", pg), "ssh to ‹host› as ‹user› failed");
});

test("leaves table names and words that only contain those values", () => {
  assert.equal(
    r.maskSensitive('relation "public.wallet_tx" does not exist', pg),
    'relation "public.wallet_tx" does not exist',
  );
  assert.equal(r.maskSensitive("the application stopped", pg), "the application stopped");
  assert.equal(
    r.maskSensitive("operator does not exist: text ~ integer at 12:30:45, try x::int", pg),
    "operator does not exist: text ~ integer at 12:30:45, try x::int",
  );
});

test("masks stray IPs, host names and home paths without a connection", () => {
  assert.equal(r.maskSensitive("timeout to 10.0.3.12:5432", null), "timeout to ‹host›:5432");
  assert.equal(r.maskSensitive("refused by fe80::1ff:fe23:4567:890a", null), "refused by ‹host›");
  assert.equal(r.maskSensitive("no route to db.eu-west-1.rds.amazonaws.com", null), "no route to ‹host›");
  assert.equal(r.maskSensitive("key ~/.ssh/id_ed25519 not found", null), "key ‹path› not found");
  assert.equal(r.maskSensitive("PostgreSQL 16.4.2 said no", null), "PostgreSQL 16.4.2 said no");
});

test("masks a SQLite file path", () => {
  const lite = { kind: "sqlite", id: "c", name: "cache", path: "/Users/me/data/cache.db" };
  assert.equal(r.maskSensitive("unable to open /Users/me/data/cache.db", lite), "unable to open ‹path›");
});

test("describes the app and database in one line each", () => {
  assert.equal(
    r.describeApp({ version: "0.1.0", os: "macos", os_version: "26.0", arch: "aarch64" }),
    "Rowkery 0.1.0 · macOS 26.0 · Apple Silicon",
  );
  assert.equal(
    r.describeApp({ version: "0.1.0", os: "windows", os_version: null, arch: "x86_64" }),
    "Rowkery 0.1.0 · Windows · x86_64",
  );
  assert.equal(r.describeDatabase(pg, "16.4"), "PostgreSQL 16.4 · over SSH");
  assert.equal(r.describeDatabase(null, null), null);
});

test("plain-text report carries only what was included", () => {
  const text = r.reportText({ description: "Broken", app: "Rowkery 0.1.0", error: "boom" });
  assert.equal(text, "Broken\n\nRowkery 0.1.0\n\nError:\nboom");
});

test("masks a Cloud SQL instance's project and name, and Google project numbers", () => {
  const cloud = {
    ...pg,
    host: "acme-prod:asia-southeast1:orders-prd",
    ssh: null,
    cloud_sql: { instance: "acme-prod:asia-southeast1:orders-prd", ip_type: "public", credentials: "gcloud" },
  };
  assert.equal(
    r.maskSensitive("Cloud SQL: orders-prd is in asia-southeast1, not us-central1. Check the instance name", cloud),
    "Cloud SQL: ‹host› is in asia-southeast1, not us-central1. Check the instance name",
  );
  assert.equal(
    r.maskSensitive("Cloud SQL Admin API: 403 Cloud SQL Admin API has not been used in project 123456789 before", cloud),
    "Cloud SQL Admin API: 403 Cloud SQL Admin API has not been used in project ‹project› before",
  );
  assert.equal(r.maskSensitive("It needs the Cloud SQL Client role on acme-prod.", cloud), "It needs the Cloud SQL Client role on ‹project›.");
});
