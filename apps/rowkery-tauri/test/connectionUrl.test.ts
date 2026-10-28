import { describe, expect, test } from "vitest";
import { connectionUrlProblem, hidePassword, HIDDEN_PASSWORD, parsePostgresUrl } from "../src/connectionUrl";

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
    // The valid escapes around a stray % still decode; a broken UTF-8 one stays as typed.
    expect(parsePostgresUrl("postgres://u:a%41%zz@db/app")?.password).toBe("aA%zz");
    expect(parsePostgresUrl("postgres://u:%C3%A9%zz%C3@db/app")?.password).toBe("é%zz%C3");
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

describe("passwords that aren't encoded (rowkery/reports#57)", () => {
  test("#, ? and @ in the password read as libpq reads them", () => {
    for (const pw of ["pa#ss", "pa?ss", "p@ss", "12#34", "a#b?c@d"]) {
      expect(parsePostgresUrl(`postgres://app:${pw}@db2/wallet2?sslmode=require`)).toMatchObject({
        host: "db2",
        database: "wallet2",
        username: "app",
        password: pw,
        ssl: "require",
      });
    }
  });

  test("an @ after the path isn't the user part", () => {
    expect(parsePostgresUrl("postgres://db/w?sslrootcert=/Users/a@b/ca.pem")).toEqual({
      host: "db",
      port: "5432",
      database: "w",
      sslRootCert: "/Users/a@b/ca.pem",
    });
  });

  test("a socket: no host, ?host= names the directory", () => {
    expect(parsePostgresUrl("postgres://app:s@/wallet?host=/var/run/postgresql")).toMatchObject({
      host: "/var/run/postgresql",
      database: "wallet",
      username: "app",
      password: "s",
    });
    expect(parsePostgresUrl("postgres:///wallet")).toEqual({ port: "5432", database: "wallet" });
  });

  test("a / in the password can't be read, and says so", () => {
    expect(parsePostgresUrl("postgres://app:pa/ss@db/wallet")).toBeNull();
    expect(connectionUrlProblem("postgres://app:pa/ss@db/wallet")).toMatch(/%2F/);
    expect(connectionUrlProblem("postgres://app:pa%2Fss@db/wallet")).toBeNull();
    expect(connectionUrlProblem("SELECT 1")).toBeNull();
  });
});

describe("hidePassword (rowkery/reports#48)", () => {
  test("URL, query and keyword passwords", () => {
    expect(hidePassword("postgres://app:Sup3r#Secret@db.internal/wallet")).toBe(`postgres://app:${HIDDEN_PASSWORD}@db.internal/wallet`);
    expect(hidePassword("postgres://app@db/w?password=x&sslmode=require")).toBe(`postgres://app@db/w?password=${HIDDEN_PASSWORD}&sslmode=require`);
    expect(hidePassword("host=db password='a b' user=u")).toBe(`host=db password=${HIDDEN_PASSWORD} user=u`);
    expect(hidePassword("postgres://app@db/w")).toBe("postgres://app@db/w");
  });

  test("the hidden URL still reads, its password as the mask", () => {
    expect(parsePostgresUrl(hidePassword("postgres://app:pw@db/w"))).toMatchObject({ host: "db", password: HIDDEN_PASSWORD });
  });
});
