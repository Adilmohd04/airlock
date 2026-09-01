/**
 * SQL-guard trust-boundary test suite (submission-hardening, Requirements 4.1–4.9).
 *
 * These tests pin the ACTUAL behavior of the three exported guards in
 * `../duckdb` — `assertSelectOnly`, `assertExpression`, `assertIdentifier`.
 * They are imported directly (the module's `?url` asset imports resolve to
 * harmless URL strings under Vitest's Vite-based resolution; no Worker/wasm is
 * instantiated because `createDb()` is never called).
 *
 * The guards throw on rejection and return the trimmed SQL/identifier on
 * acceptance. Tests assert observable behavior verified from the source, and
 * where a message is asserted it is a substring confirmed to exist in
 * `duckdb.ts`. Error message text is NOT invented.
 *
 * Fixed 2026-09-01: the NETWORKISH check now runs on the pre-`stripComments`
 * text, so a networkish scheme hidden only inside a line or block comment is
 * rejected too, closing the gap between code and the design's Property 2 text
 * (previously `assertNoAbuse` tested the comment-stripped copy, so a
 * comment-only URL slipped through).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  assertSelectOnly,
  assertExpression,
  assertIdentifier,
} from "../duckdb";

const RUNS = { numRuns: 100 } as const;

// The exact keyword set the task enumerates for Property 1 example rows. Each is
// a real token in the guard's FORBIDDEN_TOKENS alternation.
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "create",
  "alter",
  "attach",
  "detach",
  "copy",
  "truncate",
  "replace",
  "pragma",
  "set",
  "call",
  "install",
  "load",
  "read_csv",
  "read_parquet",
  "parquet_scan",
  "glob",
] as const;

// Allowed leading tokens for assertSelectOnly (Property 4 accept rows).
const ALLOWED_LEADING = [
  "select",
  "with",
  "values",
  "explain",
  "table",
  "from",
  "pivot",
  "unpivot",
] as const;

// Networkish schemes (Property 2). Matches the NETWORKISH regex in duckdb.ts.
const NETWORK_SCHEMES = ["http://", "https://", "s3://", "file://"] as const;

// ---------------------------------------------------------------------------
// Property 1 (R4.1, R4.6): forbidden tokens outside literals/comments → reject
// ---------------------------------------------------------------------------
describe("Property 1 — forbidden tokens outside literals/comments are rejected", () => {
  // Feature: submission-hardening, Property 1: a Forbidden_Token as a real
  // token (outside literals/comments) makes assertSelectOnly AND
  // assertExpression throw.
  it("rejects a forbidden token used as a real token (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_KEYWORDS),
        // A benign SELECT scaffold so the ONLY offending element is the keyword.
        fc.constantFrom("SELECT 1 ", "SELECT * FROM t ", "SELECT a "),
        (kw, prefix) => {
          const fragment = `${prefix}${kw} x`;
          expect(() => assertSelectOnly(fragment)).toThrow();
          expect(() => assertExpression(fragment)).toThrow();
        }
      ),
      RUNS
    );
  });

  // Feature: submission-hardening, Property 1: matching is case-insensitive.
  it("rejects forbidden tokens regardless of case (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_KEYWORDS),
        fc.boolean(),
        (kw, upper) => {
          const token = upper ? kw.toUpperCase() : kw;
          const fragment = `SELECT 1 ${token} y`;
          expect(() => assertExpression(fragment)).toThrow();
        }
      ),
      RUNS
    );
  });

  // Table-driven example rows: one per enumerated keyword.
  it.each(FORBIDDEN_KEYWORDS)(
    "rejects the forbidden keyword %s in both guards",
    (kw) => {
      const fragment = `SELECT 1 WHERE ${kw} col`;
      expect(() => assertSelectOnly(fragment)).toThrow(/isn't allowed/);
      expect(() => assertExpression(fragment)).toThrow(/isn't allowed/);
    }
  );
});

// ---------------------------------------------------------------------------
// Property 2 (R4.2, R4.6): networkish references → reject, incl. inside literal
// ---------------------------------------------------------------------------
describe("Property 2 — networkish references are rejected (bare and inside literals)", () => {
  // Feature: submission-hardening, Property 2: a Networkish_Reference in bare
  // SQL or inside a string literal makes both guards throw the remote-URL error.
  it("rejects networkish references in bare SQL and inside string literals (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NETWORK_SCHEMES),
        fc.constantFrom("bare", "single-literal", "double-literal"),
        (scheme, placement) => {
          const url = `${scheme}evil.example/data.csv`;
          let fragment: string;
          if (placement === "bare") {
            // Bare URL after FROM (a replacement-scan shape).
            fragment = `SELECT * FROM ${url}`;
          } else if (placement === "single-literal") {
            fragment = `SELECT * FROM t WHERE u = '${url}'`;
          } else {
            fragment = `SELECT * FROM t WHERE u = "${url}"`;
          }
          expect(() => assertSelectOnly(fragment)).toThrow(/Remote URLs/);
          expect(() => assertExpression(fragment)).toThrow(/Remote URLs/);
        }
      ),
      RUNS
    );
  });

  it.each(NETWORK_SCHEMES)(
    "rejects the %s scheme inside a string literal",
    (scheme) => {
      const fragment = `SELECT * FROM t WHERE note = '${scheme}host/x'`;
      expect(() => assertSelectOnly(fragment)).toThrow(/Remote URLs/);
      expect(() => assertExpression(fragment)).toThrow(/Remote URLs/);
    }
  );

  // Regression test for the fixed comment-hole: a networkish scheme hidden
  // only inside a `--` or `/* */` comment must still be rejected, even though
  // the comment itself never reaches DuckDB.
  it("rejects a networkish scheme that appears only inside a comment", () => {
    const fragment = "SELECT 1 -- see https://example.com/notes";
    expect(() => assertSelectOnly(fragment)).toThrow(/Remote URLs/);
    expect(() => assertExpression(fragment)).toThrow(/Remote URLs/);
    // Block comment form.
    const block = "SELECT 1 /* https://example.com */";
    expect(() => assertSelectOnly(block)).toThrow(/Remote URLs/);
    expect(() => assertExpression(block)).toThrow(/Remote URLs/);
  });
});

// ---------------------------------------------------------------------------
// Property 3 (R4.3, R4.6): stacked statements → reject; ; in literal → allowed
// ---------------------------------------------------------------------------
describe("Property 3 — stacked statements are rejected", () => {
  // Feature: submission-hardening, Property 3: a top-level semicolon separating
  // two statements makes both guards throw the multiple-statements error.
  it("rejects two statements joined by a top-level semicolon (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("SELECT 1", "SELECT * FROM t", "SELECT a, b FROM t"),
        fc.constantFrom("SELECT 2", "SELECT c FROM u", "VALUES (1)"),
        (first, second) => {
          const fragment = `${first}; ${second}`;
          expect(() => assertSelectOnly(fragment)).toThrow(
            /Multiple statements/
          );
          expect(() => assertExpression(fragment)).toThrow(
            /Multiple statements/
          );
        }
      ),
      RUNS
    );
  });

  // Control (feeds Property 5): a semicolon INSIDE a string literal is NOT a
  // statement separator — the multi-statement rule must not fire.
  it("does not treat a semicolon inside a string literal as a statement separator (property)", () => {
    fc.assert(
      fc.property(
        // A tail built only from safe chars (letters, digits, spaces, extra
        // semicolons) — deterministic, and free of quotes / comment markers /
        // URL schemes that would trip a *different* guard rule.
        fc.array(fc.constantFrom(..."abcXYZ 0123;,._".split("")), {
          maxLength: 8,
        }),
        (chars) => {
          const safeTail = chars.join("");
          const fragment = `SELECT * FROM t WHERE note = 'a; b ${safeTail}'`;
          // Must NOT throw the multiple-statements error (the ';' is in a literal).
          expect(() => assertSelectOnly(fragment)).not.toThrow(
            /Multiple statements/
          );
        }
      ),
      RUNS
    );
  });

  it("rejects a stacked statement even when the first is otherwise valid (example)", () => {
    expect(() => assertSelectOnly("SELECT 1; SELECT 2")).toThrow(
      /Multiple statements/
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 (R4.4): assertSelectOnly rejects any non-read leading token
// ---------------------------------------------------------------------------
describe("Property 4 — assertSelectOnly rejects non-read leading tokens", () => {
  // Feature: submission-hardening, Property 4: a fragment whose leading token is
  // not an allowed read keyword makes assertSelectOnly throw the
  // only-read-queries error.
  it("rejects fragments led by a non-read identifier token (property)", () => {
    fc.assert(
      fc.property(
        // Bare identifier-like leading tokens that are neither allowed leading
        // keywords nor forbidden tokens (so the ONLY reason to reject is the
        // leading-token rule).
        fc.constantFrom("show", "describe", "list", "foo", "bar", "col", "x1"),
        (lead) => {
          const fragment = `${lead} something`;
          expect(() => assertSelectOnly(fragment)).toThrow(
            /Only read queries/
          );
        }
      ),
      RUNS
    );
  });

  // Table-driven: each allowed leading keyword is accepted by assertSelectOnly.
  it.each(ALLOWED_LEADING)(
    "accepts a fragment led by the allowed keyword %s",
    (lead) => {
      const fragment = `${lead} 1`;
      // Should not throw; returns the trimmed input.
      expect(assertSelectOnly(fragment)).toBe(fragment);
    }
  );
});

// ---------------------------------------------------------------------------
// Property 5 (R4.5, R4.9): safe queries accepted + trimmed; empty → throw
// ---------------------------------------------------------------------------
describe("Property 5 — safe fragments accepted and returned trimmed; empty rejected", () => {
  // Feature: submission-hardening, Property 5: a forbidden-looking substring or
  // a semicolon that appears only inside a string literal is accepted, and the
  // return equals the input trimmed of surrounding whitespace and one trailing ';'.
  it("accepts safe queries with forbidden-looking content only inside a literal, returning trimmed (property)", () => {
    fc.assert(
      fc.property(
        // Explicit whitespace padding (deterministic — no arbitrary strings).
        fc.constantFrom("", " ", "  ", "\t", "\n", " \n ", "\t "),
        fc.constantFrom("", " ", "  ", "\t", "\n", " \n ", "\t "),
        fc.boolean(),
        (lead, trail, trailingSemi) => {
          // A safe read query where 'drop' / ';' live only inside a literal.
          const core = "SELECT * FROM t WHERE note = 'please drop; the mic'";
          const raw = `${lead}${core}${trailingSemi ? ";" : ""}${trail}`;
          const expected = core; // trimmed of surrounding ws and single trailing ;
          expect(assertSelectOnly(raw)).toBe(expected);
        }
      ),
      RUNS
    );
  });

  // Feature: submission-hardening, Property 5: a valid column name that merely
  // contains a forbidden substring (e.g. `update_ts`) does not false-trip.
  it("accepts a valid column identifier containing a forbidden-looking substring (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "update_ts",
          "created_at",
          "dropped_flag",
          "insert_count",
          "loaded_rows"
        ),
        (col) => {
          const fragment = `SELECT ${col} FROM t`;
          expect(assertSelectOnly(fragment)).toBe(fragment);
          expect(assertExpression(`${col} > 0`)).toBe(`${col} > 0`);
        }
      ),
      RUNS
    );
  });

  it("trims surrounding whitespace and a single trailing semicolon (examples)", () => {
    expect(assertSelectOnly("   SELECT 1   ")).toBe("SELECT 1");
    expect(assertSelectOnly("SELECT 1;")).toBe("SELECT 1");
    // NOTE (real behavior): the guard trims outer whitespace first, then strips
    // `;\s*$`. It removes the trailing ';' and any whitespace AFTER it, but not
    // the space that sat BEFORE the ';'. So "  SELECT 1 ;  " → "SELECT 1 "
    // (a single trailing space remains). Tests follow the code.
    expect(assertSelectOnly("  SELECT 1 ;  ")).toBe("SELECT 1 ");
    expect(assertSelectOnly("SELECT 1  ;")).toBe("SELECT 1  ");
    expect(assertExpression("  a = 1  ")).toBe("a = 1");
  });

  // Feature: submission-hardening, Property 5 (empty edge): empty / whitespace /
  // only-trailing-semicolon inputs throw the empty-SQL error.
  it("rejects empty, whitespace-only, and semicolon-only inputs (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", " ", "  ", "\t", "\n", " \n\t "),
        fc.boolean(),
        (ws, withSemi) => {
          const input = withSemi ? `${ws};${ws}` : ws;
          expect(() => assertSelectOnly(input)).toThrow(/Empty SQL/);
          expect(() => assertExpression(input)).toThrow(/Empty SQL/);
        }
      ),
      RUNS
    );
  });

  it.each(["", "   ", ";", "  ;  "])(
    "throws Empty SQL for %j",
    (input) => {
      expect(() => assertSelectOnly(input)).toThrow(/Empty SQL/);
      expect(() => assertExpression(input)).toThrow(/Empty SQL/);
    }
  );
});

// ---------------------------------------------------------------------------
// Property 6 (R4.6, R4.7, R4.8, R4.9): assertIdentifier ⇔ bare-identifier lang
// ---------------------------------------------------------------------------
describe("Property 6 — assertIdentifier accepts exactly the bare-identifier language", () => {
  // Feature: submission-hardening, Property 6: assertIdentifier returns the
  // trimmed value iff the trimmed value matches ^[A-Za-z_][A-Za-z0-9_]*$,
  // otherwise it throws.
  //
  // Deterministic by construction: rather than feed arbitrary `fc.string()` and
  // mirror the guard's regex as an oracle (which risks whitespace/Unicode edge
  // cases where the two regexes subtly disagree — flaky for a trust test), we
  // generate explicitly-valid and explicitly-invalid identifiers and assert the
  // branch each one must take.
  it("accepts valid identifiers and rejects invalid ones (property)", () => {
    const identChar = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
    const headChar = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";

    // A guaranteed-valid bare identifier: a head char + any tail of ident chars.
    const validIdent = fc
      .tuple(
        fc.constantFrom(...headChar.split("")),
        fc.array(fc.constantFrom(...identChar.split("")), { maxLength: 15 })
      )
      .map(([h, tail]) => h + tail.join(""));

    // A guaranteed-invalid value: inject a char the grammar forbids, or lead
    // with a digit, or make it empty — every branch the guard must reject.
    const invalidIdent = fc.oneof(
      // leading digit
      fc.tuple(
        fc.constantFrom(..."0123456789".split("")),
        fc.array(fc.constantFrom(...identChar.split("")), { maxLength: 8 })
      ).map(([d, tail]) => d + tail.join("")),
      // contains a forbidden char (punctuation, quote, symbol) in the MIDDLE,
      // so trimming can't rescue it. Whitespace is excluded here because the
      // guard trims leading/trailing space first (a trailing-space name like
      // "a " is valid) — embedded-whitespace rejection is covered by the
      // example rows below.
      fc.tuple(
        fc.constantFrom(...headChar.split("")),
        fc.constantFrom(..."-.;'\"()[]{}!@#$%/\\,:".split("")),
        fc.constantFrom(...identChar.split(""))
      ).map(([h, bad, t]) => h + bad + t),
      // empty / whitespace-only
      fc.constantFrom("", " ", "   ", "\t")
    );

    fc.assert(
      fc.property(
        validIdent,
        fc.constantFrom("", " ", "  ", "\t "),
        fc.constantFrom("", " ", "  ", " \t"),
        (ident, lead, trail) => {
          // Valid identifier, optionally padded → accepted, returned trimmed.
          expect(assertIdentifier(`${lead}${ident}${trail}`)).toBe(ident);
        }
      ),
      RUNS
    );

    fc.assert(
      fc.property(invalidIdent, (bad) => {
        expect(() => assertIdentifier(bad)).toThrow(/not a valid column name/);
      }),
      RUNS
    );
  });

  // Feature: submission-hardening, Property 6: valid identifiers are always
  // accepted and returned trimmed.
  it("always accepts generated valid identifiers, returning them trimmed (property)", () => {
    const validIdent = fc
      .tuple(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("")),
        fc.array(
          fc.constantFrom(
            ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("")
          ),
          { maxLength: 12 }
        )
      )
      .map(([head, tail]) => head + tail.join(""));
    fc.assert(
      fc.property(
        validIdent,
        fc.constantFrom("", " ", "  ", "\t"),
        fc.constantFrom("", " ", "  ", "\t"),
        (ident, lead, trail) => {
          expect(assertIdentifier(`${lead}${ident}${trail}`)).toBe(ident);
        }
      ),
      RUNS
    );
  });

  it.each([
    ["1col", "leading digit"],
    ["a b", "embedded whitespace"],
    ['"col"', "double quotes"],
    ["'col'", "single quotes"],
    ["col-name", "hyphen punctuation"],
    ["col.name", "dot punctuation"],
    ["col;", "semicolon"],
    ["", "empty"],
    ["   ", "whitespace only"],
    ["9", "bare digit"],
  ])("rejects %j (%s)", (bad) => {
    expect(() => assertIdentifier(bad)).toThrow(/not a valid column name/);
  });

  it.each(["col", "_private", "a1", "snake_case_name", "X", "_", "col_2b"])(
    "accepts valid identifier %j and returns it trimmed",
    (good) => {
      expect(assertIdentifier(`  ${good}  `)).toBe(good);
    }
  );
});
