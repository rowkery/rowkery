// MySQL and MariaDB split as the mysql client reads them: `#` comments,
// `--` only before a space, backslash escapes, no `$$` bodies, and a
// routine's BEGIN … END body kept whole.
import { describe, expect, test } from "vitest";
import { sqlStatementRanges } from "../src/sqlStatements";

const split = (text: string, mysql = true) =>
  sqlStatementRanges(text, mysql ? "mysql" : undefined).map((r) => text.slice(r.start, r.end));

describe("MySQL statement split", () => {
  test("a # comment hides its ;", () => {
    expect(split("select 1 # one; two\nfrom dual; select 2")).toEqual(["select 1 # one; two\nfrom dual;", "select 2"]);
  });

  test("-- is a comment only before a space or the end", () => {
    expect(split("select 1--1; select 2")).toEqual(["select 1--1;", "select 2"]);
    expect(split("select 1 -- x; y\n; select 2")).toEqual(["select 1 -- x; y\n;", "select 2"]);
    expect(split("select 1 --")).toEqual(["select 1 --"]);
    // Postgres and SQLite keep their rule.
    expect(split("select 1--1; select 2", false)).toEqual(["select 1--1; select 2"]);
  });

  test("a backslash escapes a quote", () => {
    expect(split("select 'it\\'s; ok'; select \"a\\\"; b\"; select 3")).toEqual([
      "select 'it\\'s; ok';",
      "select \"a\\\"; b\";",
      "select 3",
    ]);
    // Not in a backticked name.
    expect(split("select `a\\`; select 2")).toEqual(["select `a\\`;", "select 2"]);
  });

  test("$$ is no body", () => {
    expect(split("select $$; select 2")).toEqual(["select $$;", "select 2"]);
  });

  test("a procedure's BEGIN … END stays whole, with its IF, WHILE and CASE", () => {
    const proc = [
      "CREATE DEFINER=`root`@`%` PROCEDURE p(n INT)",
      "BEGIN",
      "  IF n > 0 THEN SELECT 1; END IF;",
      "  WHILE n > 0 DO SET n = n - 1; END WHILE;",
      "  CASE n WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE;",
      "  lbl: LOOP LEAVE lbl; END LOOP lbl;",
      "  REPEAT SET n = n + 1; UNTIL n > 3 END REPEAT;",
      "  SELECT CASE WHEN n THEN 1 END;",
      "  BEGIN DECLARE x INT; END;",
      "END;",
    ].join("\n");
    expect(split(`${proc}\nselect 9`)).toEqual([proc, "select 9"]);
  });

  test("functions, triggers and events too", () => {
    const fn = "CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN DECLARE x INT; SET x = 1; RETURN x; END;";
    const trg = "CREATE TRIGGER t BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END;";
    const ev = "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; DELETE FROM u; END;";
    expect(split(`${fn} ${trg} ${ev} select 1`)).toEqual([fn, trg, ev, "select 1"]);
    // One without BEGIN ends at its ;.
    expect(split("CREATE FUNCTION g() RETURNS INT RETURN 1; select 2")).toEqual([
      "CREATE FUNCTION g() RETURNS INT RETURN 1;",
      "select 2",
    ]);
  });

  test("a transaction's BEGIN is no body", () => {
    expect(split("BEGIN; UPDATE t SET a = 1; COMMIT;")).toEqual(["BEGIN;", "UPDATE t SET a = 1;", "COMMIT;"]);
  });
});
