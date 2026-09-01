/**
 * Import format detection + delimiter sniffing. Pure string logic — the seam
 * every load path dispatches on (`workspaceStore.importSource`) and the feedback
 * the clipboard-paste affordance shows before it imports anything.
 */
import { describe, it, expect } from "vitest";
import {
  BINARY_FORMATS,
  detectFormat,
  fileExtension,
  sniffDelimiter,
} from "./importFormats";

describe("fileExtension", () => {
  it.each([
    ["data.csv", "csv"],
    ["archive.tar.gz", "gz"],
    ["noext", ""],
    ["  trailing.parquet  ", "parquet"],
  ])("%s -> %s", (name, ext) => {
    expect(fileExtension(name)).toBe(ext);
  });
});

describe("detectFormat", () => {
  it.each([
    ["sales.csv", "csv"],
    ["export.tsv", "tsv"],
    ["dump.tab", "tsv"],
    ["records.json", "json"],
    ["log.ndjson", "json"],
    ["events.parquet", "parquet"],
    ["events.pq", "parquet"],
    ["NOTES.TXT", "csv"],
  ] as const)("by extension: %s", (name, fmt) => {
    expect(detectFormat(name)).toBe(fmt);
  });

  it("falls back to MIME when the extension is unknown", () => {
    expect(detectFormat("blob", "text/csv")).toBe("csv");
    expect(detectFormat("f", "application/x-parquet")).toBe("parquet");
  });

  it("prefers the extension over a misleading MIME", () => {
    // Drag-drop often reports octet-stream for .parquet; the name still wins.
    expect(detectFormat("real.parquet", "application/octet-stream")).toBe("parquet");
  });

  it("returns null for genuinely unsupported files", () => {
    expect(detectFormat("photo.png", "image/png")).toBeNull();
    expect(detectFormat("archive.zip")).toBeNull();
    expect(detectFormat("mystery")).toBeNull();
  });

  it("marks parquet as binary, csv/tsv/json as text", () => {
    expect(BINARY_FORMATS.has("parquet")).toBe(true);
    expect(BINARY_FORMATS.has("csv")).toBe(false);
    expect(BINARY_FORMATS.has("tsv")).toBe(false);
    expect(BINARY_FORMATS.has("json")).toBe(false);
  });
});

describe("sniffDelimiter", () => {
  it("detects tab-separated paste out of a spreadsheet", () => {
    const g = sniffDelimiter("id\tname\tsalary\n1\tAda\t100\n2\tBob\t120");
    expect(g.delimiter).toBe("\t");
    expect(g.label).toBe("tab");
    expect(g.columns).toBe(3);
    expect(g.consistent).toBe(true);
  });

  it("detects comma CSV", () => {
    const g = sniffDelimiter("a,b,c\n1,2,3\n4,5,6");
    expect(g.delimiter).toBe(",");
    expect(g.columns).toBe(3);
  });

  it("detects semicolon (European CSV)", () => {
    const g = sniffDelimiter("a;b\n1;2\n3;4");
    expect(g.delimiter).toBe(";");
  });

  it("detects pipe-separated", () => {
    const g = sniffDelimiter("a|b|c\n1|2|3");
    expect(g.delimiter).toBe("|");
  });

  it("ignores delimiters inside quoted fields", () => {
    const g = sniffDelimiter('name,note\n"Ada","a, b, c"\n"Bob","x"');
    expect(g.delimiter).toBe(",");
    expect(g.columns).toBe(2);
  });

  it("does not trip on a comma inside a quoted TSV field", () => {
    const g = sniffDelimiter('a\tb\n"1,2,3,4"\tx\n"5,6"\ty');
    expect(g.delimiter).toBe("\t");
  });

  it("flags inconsistent column counts", () => {
    const g = sniffDelimiter("a,b,c\n1,2\n3,4,5,6");
    expect(g.delimiter).toBe(",");
    expect(g.consistent).toBe(false);
  });

  it("falls back to comma for a single-column paste", () => {
    const g = sniffDelimiter("value\n1\n2\n3");
    expect(g.delimiter).toBe(",");
    expect(g.columns).toBe(1);
    expect(g.consistent).toBe(true);
  });

  it("falls back to comma for empty input", () => {
    expect(sniffDelimiter("").delimiter).toBe(",");
    expect(sniffDelimiter("   \n  \n").delimiter).toBe(",");
  });

  it("skips blank lines when sampling", () => {
    const g = sniffDelimiter("a\tb\n\n1\t2\n\n3\t4\n");
    expect(g.delimiter).toBe("\t");
    expect(g.consistent).toBe(true);
  });
});
