// MySQL and MariaDB split as the mysql client reads them: `#` comments,
// `--` only before a space, backslash escapes, no `$$` bodies, and a
// routine's BEGIN … END body kept whole. `DELIMITER` lines read as the Run
// SQL file reader reads them (`crates/rowkery-core/src/sql_file.rs`).
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

  test("a block closed by END; doesn't eat the next block's IF, CASE or WHILE", () => {
    const procs = [
      "CREATE PROCEDURE p() BEGIN BEGIN SELECT 1; END; IF 1 THEN SELECT 2; END IF; END;",
      "CREATE PROCEDURE p() BEGIN SET @x = CASE WHEN 1 THEN 1 END; IF @x THEN SELECT 1; END IF; END;",
      "CREATE PROCEDURE p() BEGIN DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN SET @d = 1; END; WHILE 0 DO SELECT 1; END WHILE; END;",
      "CREATE PROCEDURE p() BEGIN BEGIN SELECT 1; END; CASE 1 WHEN 1 THEN SELECT 1; END CASE; SELECT 3; END;",
      // MariaDB's FOR … END FOR.
      "CREATE PROCEDURE p() BEGIN FOR i IN 1..3 DO SELECT i; END FOR; SELECT 2; END;",
    ];
    for (const proc of procs) expect(split(`${proc} select 9;`)).toEqual([proc, "select 9;"]);
  });

  test("a transaction's BEGIN is no body", () => {
    expect(split("BEGIN; UPDATE t SET a = 1; COMMIT;")).toEqual(["BEGIN;", "UPDATE t SET a = 1;", "COMMIT;"]);
    expect(split("BEGIN WORK; SELECT 1; END")).toEqual(["BEGIN WORK;", "SELECT 1;", "END"]);
    expect(split("BEGIN NOT; SELECT 1")).toEqual(["BEGIN NOT;", "SELECT 1"]);
  });

  test("MariaDB's BEGIN NOT ATOMIC … END stays whole", () => {
    const block = "BEGIN NOT ATOMIC\n  IF 1 THEN SELECT 1; END IF;\n  BEGIN SELECT 2; END;\n  SELECT 3;\nEND";
    expect(split(`SELECT 0; ${block}; SELECT 4`)).toEqual(["SELECT 0;", `${block};`, "SELECT 4"]);
    expect(split("begin not atomic select 1; select 2; end")).toEqual(["begin not atomic select 1; select 2; end"]);
    // Postgres and SQLite have no such block.
    expect(split("BEGIN NOT ATOMIC SELECT 1; END", false)).toEqual(["BEGIN NOT ATOMIC SELECT 1;", "END"]);
  });

  test("a DELIMITER line sets what ends a statement, and neither is sent", () => {
    const proc = "CREATE PROCEDURE p() BEGIN SELECT 3; SELECT 4; END";
    expect(split(`DELIMITER //\n${proc}//\nDELIMITER ;\nSELECT 5; SELECT 6;`)).toEqual([proc, "SELECT 5;", "SELECT 6;"]);
    // Any case, any delimiter (one that starts a comment or a string too), the rest of its line unread.
    expect(split("delimiter // and more\nSELECT 1; SELECT 2//\nSELECT '//'//\nDelimiter ;\nSELECT 3;")).toEqual([
      "SELECT 1; SELECT 2",
      "SELECT '//'",
      "SELECT 3;",
    ]);
    expect(split("DELIMITER --\nSELECT 1-- SELECT `--`--")).toEqual(["SELECT 1", "SELECT `--`"]);
    // Inside a word or a /*! … */ as the client finds it; not in a string, a name or a plain comment.
    expect(split("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;\n")).toEqual([
      "CREATE PROCEDURE p() BEGIN SELECT 1; END",
      "SELECT 2;",
    ]);
    expect(split("DELIMITER ab\nSELECT cab SELECT 1")).toEqual(["SELECT c", "SELECT 1"]);
    expect(split("DELIMITER $$\nSELECT /*!50000 1 $$\nSELECT /* 3 $$ */ 4$$\nSELECT 'x$$'$$\n# no $$ here\nSELECT 5")).toEqual([
      "SELECT /*!50000 1",
      "SELECT /* 3 $$ */ 4",
      "SELECT 'x$$'",
      "# no $$ here\nSELECT 5",
    ]);
    // After a statement on its own line; Windows line ends.
    expect(split("SELECT 1;\r\nDELIMITER ;;\r\nSELECT 2;;\r\nSELECT 3")).toEqual(["SELECT 1;", "SELECT 2", "SELECT 3"]);
  });

  test("DELIMITER is the client's word only where a statement starts", () => {
    expect(split("SELECT\ndelimiter FROM t; SELECT 2")).toEqual(["SELECT\ndelimiter FROM t;", "SELECT 2"]);
    expect(split("(SELECT 1)\nDELIMITER //\n; SELECT 2")).toEqual(["(SELECT 1)\nDELIMITER //\n;", "SELECT 2"]);
    // Nothing to set, or a backslash: left for the server to answer.
    expect(split("DELIMITER\nSELECT 1; SELECT 2")).toEqual(["DELIMITER\nSELECT 1;", "SELECT 2"]);
    expect(split("DELIMITER \\\\\nSELECT 1; SELECT 2")).toEqual(["DELIMITER \\\\\nSELECT 1;", "SELECT 2"]);
    // Postgres and SQLite have no such line.
    expect(split("DELIMITER //\nSELECT 1; SELECT 2//", false)).toEqual(["DELIMITER //\nSELECT 1;", "SELECT 2//"]);
  });
});
