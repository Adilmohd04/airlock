/**
 * Redaction guard — adversarial test suite.
 *
 * A redacted column is a security boundary, not a UI nicety. These tests
 * enumerate the ways an agent would try to recover a redacted column's values
 * through SQL and pin that every one is refused by `assertNoRedactedColumns` /
 * `assertNoStarProjection` (both pure string guards in `./duckdb`, imported
 * directly — no Worker/wasm is instantiated).
 */
import { describe, it, expect } from "vitest";
import { assertNoRedactedColumns, assertNoStarProjection } from "./duckdb";

const REDACTED = ["ssn", "salary"];

describe("assertNoRedactedColumns — direct and disguised references are refused", () => {
  // Attack path 1: name the column outright.
  it("refuses a bare reference in the projection", () => {
    expect(() => assertNoRedactedColumns("SELECT ssn FROM dataset", REDACTED)).toThrow(
      /"ssn" is redacted/
    );
  });

  // Attack path 2: alias it to something innocuous.
  it("refuses an aliased reference (SELECT ssn AS x)", () => {
    expect(() =>
      assertNoRedactedColumns("SELECT ssn AS taxpayer_id FROM dataset", REDACTED)
    ).toThrow(/redacted/);
  });

  // Attack path 3: hide it inside a subquery / CTE and re-select.
  it("refuses a reference buried in a CTE", () => {
    expect(() =>
      assertNoRedactedColumns(
        "WITH t AS (SELECT ssn FROM dataset) SELECT * FROM t",
        REDACTED
      )
    ).toThrow(/redacted/);
  });

  it("refuses a reference buried in a derived-table subquery", () => {
    expect(() =>
      assertNoRedactedColumns(
        "SELECT x FROM (SELECT ssn AS x FROM dataset) s",
        REDACTED
      )
    ).toThrow(/redacted/);
  });

  // Attack path 4: string-concatenate it into another value.
  it("refuses string concatenation ('x' || ssn)", () => {
    expect(() =>
      assertNoRedactedColumns("SELECT 'id=' || ssn FROM dataset", REDACTED)
    ).toThrow(/redacted/);
  });

  // Attack path 5: smuggle it through a CASE expression.
  it("refuses a CASE expression over the column", () => {
    expect(() =>
      assertNoRedactedColumns(
        "SELECT CASE WHEN salary > 100000 THEN 'hi' ELSE 'lo' END AS band FROM dataset",
        REDACTED
      )
    ).toThrow(/redacted/);
  });

  // Attack path 6: aggregates / order statistics — min()/max() ARE real cells,
  // avg() + WHERE reconstructs one row. All refused (aggregates-over-redacted
  // is deliberately disallowed).
  it.each([
    "SELECT avg(salary) FROM dataset",
    "SELECT min(salary) FROM dataset",
    "SELECT max(salary) FROM dataset",
    "SELECT sum(salary) FROM dataset WHERE id = 5",
    "SELECT avg(salary) FILTER (WHERE id = 5) FROM dataset",
  ])("refuses aggregate form: %s", (sql) => {
    expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
  });

  // Attack path 7: reference only in WHERE / GROUP BY / ORDER BY (membership &
  // differencing probes).
  it.each([
    "SELECT id FROM dataset WHERE ssn = '123-45-6789'",
    "SELECT count(*) FROM dataset GROUP BY ssn",
    "SELECT id FROM dataset ORDER BY salary DESC LIMIT 1",
  ])("refuses a reference outside the projection: %s", (sql) => {
    expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
  });

  // Attack path 8: quoted identifier (case / delimiter games).
  it.each([
    'SELECT "ssn" FROM dataset',
    "SELECT SSN FROM dataset",
    "SELECT dataset.ssn FROM dataset",
    "SELECT t.SsN FROM dataset t",
  ])("refuses quoted / cased / qualified identifier: %s", (sql) => {
    expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
  });

  // Not fooled by the word appearing only in a string literal or a comment.
  it("does NOT trip on the word inside a string literal", () => {
    const sql = "SELECT department FROM dataset WHERE note = 'lost ssn form'";
    expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql);
  });

  it("does NOT trip on the word inside a comment", () => {
    const sql = "SELECT department FROM dataset -- ignoring ssn here";
    expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql);
  });

  // Not fooled into a false positive on a different column that merely contains
  // the redacted token as a substring.
  it.each([
    "SELECT ssn_verified FROM dataset",
    "SELECT verified_ssn_flag FROM dataset",
    "SELECT salary_band FROM dataset",
    "SELECT annual_salary_usd FROM dataset",
  ])("accepts a distinct column whose name contains the token: %s", (sql) => {
    expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql.trim());
  });

  it("is a no-op when nothing is redacted", () => {
    const sql = "SELECT ssn, salary FROM dataset";
    expect(assertNoRedactedColumns(sql, [])).toBe(sql);
  });

  it("handles a column name with spaces / hyphens", () => {
    expect(() =>
      assertNoRedactedColumns('SELECT "Home Address" FROM dataset', ["Home Address"])
    ).toThrow(/redacted/);
  });
});

describe("assertNoStarProjection — star expansion is refused while redactions exist", () => {
  // Attack path 9: SELECT * (and friends) expand to include the redacted column.
  it.each([
    "SELECT * FROM dataset",
    "SELECT *, id FROM dataset",
    "SELECT * EXCLUDE (department) FROM dataset",
    "SELECT dataset.* FROM dataset",
    "SELECT COLUMNS('.*') FROM dataset",
    "SELECT min(COLUMNS(*)) FROM dataset",
  ])("refuses a star / COLUMNS() projection: %s", (sql) => {
    expect(() => assertNoStarProjection(sql, ["ssn"])).toThrow(/disabled while a column is redacted/);
  });

  // Attack path 10: whole-relation shorthands that dump every column's values
  // or stats without ever naming a column.
  it.each([
    "SELECT column_name, min, max FROM (SUMMARIZE dataset)",
    "SUMMARIZE dataset",
    "TABLE dataset",
    "FROM dataset SELECT department",
    "PIVOT dataset ON department USING count(*)",
  ])("refuses a whole-relation shorthand: %s", (sql) => {
    expect(() => assertNoStarProjection(sql, ["ssn"])).toThrow(/disabled while a column is redacted/);
  });

  it("allows count(*) — the ordinary row-count idiom", () => {
    const sql = "SELECT count(*) AS n FROM dataset";
    expect(assertNoStarProjection(sql, ["ssn"])).toBe(sql);
  });

  it("allows explicit column lists", () => {
    const sql = "SELECT id, department FROM dataset";
    expect(assertNoStarProjection(sql, ["ssn"])).toBe(sql);
  });

  it("does not treat arithmetic '*' as a star projection", () => {
    const sql = "SELECT base * 1.1 AS bumped FROM dataset";
    expect(assertNoStarProjection(sql, ["ssn"])).toBe(sql);
  });

  it("is a no-op when nothing is redacted", () => {
    const sql = "SELECT * FROM dataset";
    expect(assertNoStarProjection(sql, [])).toBe(sql);
  });
});
