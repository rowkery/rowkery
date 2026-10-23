import { describe, expect, test } from "vitest";
import { parsePostgresUrl } from "../src/connectionUrl";

describe("parsePostgresUrl", () => {
  test("URL", () => {
    expect(parsePostgresUrl("postgres://app:s%40cret@db.internal:5433/wallet?sslmode=verify-full&sslrootcert=/ca.pem")).toEqual({
      host: "db.internal",
      port: "5433",
      database: "wallet",
      username: "app",
      password: "s@cret",
      ssl: "verify",
      sslRootCert: "/ca.pem",
    });
    expect(parsePostgresUrl("postgresql://localhost/app")).toEqual({ host: "localhost", port: "5432", database: "app" });
  });

  test("DATABASE_URL= prefix, quoted, with export", () => {
    expect(parsePostgresUrl('DATABASE_URL="postgres://u@h/d"')).toMatchObject({ host: "h", database: "d", username: "u" });
    expect(parsePostgresUrl("export PGURL=postgres://u@h/d")).toMatchObject({ host: "h", database: "d" });
  });

  test("libpq keyword string", () => {
    expect(parsePostgresUrl("host=db port=6432 dbname=app user=alice password='a b' sslmode=require")).toEqual({
      host: "db",
      port: "6432",
      database: "app",
      username: "alice",
      password: "a b",
      ssl: "require",
    });
  });

  test("psql line", () => {
    expect(parsePostgresUrl("psql -h db.internal -p 5433 -U app -d wallet")).toEqual({
      host: "db.internal",
      port: "5433",
      username: "app",
      database: "wallet",
    });
    expect(parsePostgresUrl("psql --host=db --username=app wallet")).toEqual({ host: "db", username: "app", database: "wallet" });
    expect(parsePostgresUrl("psql -hdb wallet app")).toEqual({ host: "db", database: "wallet", username: "app" });
    expect(parsePostgresUrl("psql postgres://u@h/d")).toMatchObject({ host: "h", database: "d", username: "u" });
  });

  test("not a connection string", () => {
    expect(parsePostgresUrl("hello world")).toBeNull();
    expect(parsePostgresUrl("SELECT 1")).toBeNull();
    expect(parsePostgresUrl("a=b")).toBeNull();
    expect(parsePostgresUrl("https://example.com")).toBeNull();
    expect(parsePostgresUrl("")).toBeNull();
  });

  test("a stray % never throws: the field keeps the text as typed", () => {
    expect(parsePostgresUrl("postgres://u:p%zz@db/app")).toEqual({
      host: "db",
      port: "5432",
      database: "app",
      username: "u",
      password: "p%zz",
    });
    expect(parsePostgresUrl("postgres://u%:p@db/a%e9b")).toMatchObject({ username: "u%", database: "a%e9b" });
    expect(parsePostgresUrl("DATABASE_URL=postgres://u:100%@db/app")).toMatchObject({ password: "100%" });
  });
});
