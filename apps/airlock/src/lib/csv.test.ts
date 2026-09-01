/**
 * Delimited-text parsing + re-serialization. `loadPastedText` and the TSV import
 * path both run pasted/dropped text through `parseDelimited` -> `gridToCsv` so
 * everything downstream of the import is plain comma CSV.
 */
import { describe, it, expect } from "vitest";
import { parseDelimited, gridToCsv, rowsToCsv } from "./csv";

describe("parseDelimited", () => {
  it("splits a simple TSV grid", () => {
    expect(parseDelimited("a\tb\n1\t2\n3\t4", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("honours RFC-4180 quoting: embedded delimiter, newline, escaped quote", () => {
    const text = 'name,note\n"Ada","a, b"\n"Bob","line1\nline2"\n"Cy","say ""hi"""';
    expect(parseDelimited(text, ",")).toEqual([
      ["name", "note"],
      ["Ada", "a, b"],
      ["Bob", "line1\nline2"],
      ["Cy", 'say "hi"'],
    ]);
  });

  it("normalizes CRLF and lone CR line endings", () => {
    expect(parseDelimited("a,b\r\n1,2\r3,4", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseDelimited("a,b,c\n1,,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("does not emit a phantom trailing row for a final newline", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("gridToCsv", () => {
  it("re-quotes only fields that need it", () => {
    const csv = gridToCsv([
      ["name", "note"],
      ["Ada", "a, b"],
      ["Bob", 'say "hi"'],
    ]);
    expect(csv).toBe('name,note\nAda,"a, b"\nBob,"say ""hi"""');
  });

  it("round-trips TSV -> grid -> CSV -> grid unchanged", () => {
    const tsv = 'id\tlabel\n1\t"a,b"\n2\thas\ttab-lookalike';
    const once = parseDelimited(tsv, "\t");
    const csv = gridToCsv(once);
    expect(parseDelimited(csv, ",")).toEqual(once);
  });
});

describe("rowsToCsv", () => {
  it("emits header + body and blanks null/undefined", () => {
    const csv = rowsToCsv(
      ["a", "b"],
      [
        { a: 1, b: null },
        { a: "x,y", b: undefined },
      ]
    );
    expect(csv).toBe('a,b\n1,\n"x,y",');
  });
});
