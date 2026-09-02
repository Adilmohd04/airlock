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
import fc from "fast-check";
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

// ---------------------------------------------------------------------------
// Regression: a comment marker INSIDE a literal must not delete the redacted
// column from the scan copy.
//
// Both guards above used to build their scan by stripping comments with one
// regex and emptying string literals with another, comments first. A `--`,
// `/*` or `*/` sitting inside a string literal therefore truncated the *scan
// copy* while the original fragment — still naming the blindfolded column, or
// still carrying a `SELECT *` — is what DuckDB actually ran:
//
//   SELECT x FROM dataset WHERE note = '--' AND y = ssn
//
// `stripComments` deleted `--' AND y = ssn`, so `ssn` never appeared in the
// scan and the query was ACCEPTED. `assertSelectOnly` does not catch it either:
// it is otherwise perfectly legal read-only SQL. That defeats redaction
// outright. Both guards now read `scanCopies().identifiersIntact`, the third
// copy of the single-pass lexer: comments blanked, string VALUES emptied,
// quoted IDENTIFIERS verbatim.
// ---------------------------------------------------------------------------

/** Every literal form the lexer tracks, as a wrapper around a comment marker. */
const LITERAL_WRAPPERS: { name: string; wrap: (m: string) => string }[] = [
  { name: "single-quoted string", wrap: (m) => `'${m}'` },
  { name: "dollar-quoted string", wrap: (m) => `$$${m}$$` },
  { name: "tagged dollar-quoted string", wrap: (m) => `$tag$${m}$tag$` },
  { name: "double-quoted identifier", wrap: (m) => `"note${m}"` },
];

const MARKERS = ["--", "/*", "*/"] as const;

describe("assertNoRedactedColumns — literal-borne comment markers cannot hide the column", () => {
  // The confirmed bypass, spelled out, plus the same trick in every other
  // literal form. Each must now be refused.
  it.each([
    "SELECT x FROM dataset WHERE note = '--' AND y = ssn",
    "SELECT x FROM dataset WHERE note = '/*' AND y = ssn AND z = '*/'",
    "SELECT x FROM dataset WHERE note = $$--$$ AND y = ssn",
    "SELECT x FROM dataset WHERE note = $tag$/*$tag$ AND y = salary",
    "SELECT x FROM dataset WHERE note = 'a--b' AND y = dataset.ssn",
    "SELECT 'x--' AS tag, ssn FROM dataset",
  ])("refuses a reference hidden behind a string-borne marker: %s", (sql) => {
    expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
  });

  // A marker inside a DOUBLE-quoted identifier is not a comment either — and
  // the identifier itself stays verbatim in the scan, so `"ssn"` still trips.
  it.each([
    'SELECT x FROM dataset WHERE "note--" = 1 AND y = ssn',
    'SELECT "col/*x" , ssn FROM dataset',
    'SELECT "ssn--alias" FROM dataset',
  ])("refuses a reference hidden behind an identifier-borne marker: %s", (sql) => {
    expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
  });

  // A real comment still separates two tokens, exactly as DuckDB's own lexer
  // does: `a,/*note*/ssn` is a column reference there, so it must be one here.
  it("refuses a reference glued to a block comment", () => {
    expect(() =>
      assertNoRedactedColumns("SELECT a,/*note*/ssn FROM dataset", REDACTED)
    ).toThrow(/redacted/);
  });

  it("rejects the redacted name after a marker in any literal form (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MARKERS),
        fc.constantFrom(...LITERAL_WRAPPERS.map((w) => w.name)),
        fc.constantFrom("ssn", "salary", "SSN", "dataset.salary"),
        (marker, wrapperName, col) => {
          const wrap = LITERAL_WRAPPERS.find((w) => w.name === wrapperName)!.wrap;
          const sql = `SELECT id FROM dataset WHERE note = ${wrap(marker)} AND y = ${col}`;
          expect(() => assertNoRedactedColumns(sql, REDACTED)).toThrow(/redacted/);
        }
      ),
      { numRuns: 100 }
    );
  });

  // The other direction: a marker inside a VALUE is inert, and a guard that
  // cries wolf on ordinary analyst SQL is a regression, not a fix.
  it.each([
    "SELECT department FROM dataset WHERE note = 'dropped ssn from payroll'",
    "SELECT department FROM dataset WHERE note = 'a -- b /* c */'",
    "SELECT department FROM dataset WHERE note = '*/ end'",
    "SELECT department FROM dataset WHERE path = 'C:/*/logs'",
    "SELECT department FROM dataset /* ssn is redacted, skipping it */",
  ])("still accepts a marker or the word inside a value: %s", (sql) => {
    expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql);
  });

  // Newly correct: a dollar-quoted VALUE is a value. The old scan only emptied
  // single-quoted literals, so this false-tripped.
  it("accepts the redacted word inside a dollar-quoted value", () => {
    const sql = "SELECT department FROM dataset WHERE note = $$ssn on file$$";
    expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql);
  });

  it("accepts a value containing a marker in any literal form (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MARKERS),
        fc.constantFrom("'", "$$", "$tag$"),
        fc.constantFrom("", " ssn", " salary here"),
        (marker, quote, trailer) => {
          const sql = `SELECT department FROM dataset WHERE note = ${quote}${marker}${trailer}${quote}`;
          expect(assertNoRedactedColumns(sql, REDACTED)).toBe(sql);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("assertNoStarProjection — literal-borne comment markers cannot hide a star", () => {
  it.each([
    "SELECT a FROM dataset WHERE note = '--' AND b IN (SELECT * FROM other)",
    "SELECT a FROM dataset WHERE note = '/*' AND b IN (SELECT * FROM other) AND c = '*/'",
    "SELECT a FROM dataset WHERE note = $$--$$ AND b IN (SELECT * FROM other)",
    "SELECT a FROM dataset WHERE note = $tag$--$tag$ AND b IN (SELECT COLUMNS('.*') FROM other)",
    "SELECT a FROM dataset WHERE note = '--' AND b IN (SELECT column_name FROM (SUMMARIZE dataset))",
    'SELECT "note--" , * FROM dataset',
  ])("refuses a star hidden behind a literal-borne marker: %s", (sql) => {
    expect(() => assertNoStarProjection(sql, ["ssn"])).toThrow(
      /disabled while a column is redacted/
    );
  });

  it("rejects a star after a marker in any literal form (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MARKERS),
        fc.constantFrom(...LITERAL_WRAPPERS.map((w) => w.name)),
        fc.constantFrom("SELECT * FROM other", "SELECT COLUMNS('x') FROM other"),
        (marker, wrapperName, tail) => {
          const wrap = LITERAL_WRAPPERS.find((w) => w.name === wrapperName)!.wrap;
          const sql = `SELECT a FROM dataset WHERE note = ${wrap(marker)} AND b IN (${tail})`;
          expect(() => assertNoStarProjection(sql, ["ssn"])).toThrow(
            /disabled while a column is redacted/
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it.each([
    "SELECT id FROM dataset WHERE note = 'a -- b /* c */'",
    "SELECT id, count(*) AS n FROM dataset WHERE note = '--' GROUP BY id",
    "SELECT base * 1.1 AS bumped FROM dataset WHERE note = '/*'",
    "SELECT id FROM dataset -- everything else is fine",
  ])("still accepts legitimate SQL carrying a marker: %s", (sql) => {
    expect(assertNoStarProjection(sql, ["ssn"])).toBe(sql);
  });
});
