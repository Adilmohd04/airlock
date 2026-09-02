/**
 * pdf.test.ts — PDF import: format detection routes to the new "pdf" kind,
 * and extraction turns a real (fixture) PDF into (page, text) CSV rows.
 * Extraction runs pdfjs-dist's real parser; in Node it uses the fake-worker
 * fallback, same text pipeline as the browser.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectFormat } from "./importFormats";
import { extractPdf } from "./pdf";

const here = dirname(fileURLToPath(import.meta.url));

describe("format detection accepts documents", () => {
  it("routes .pdf (and application/pdf) to the pdf importer", () => {
    expect(detectFormat("report.pdf")).toBe("pdf");
    expect(detectFormat("report.PDF")).toBe("pdf");
    expect(detectFormat("x.bin", "application/pdf")).toBe("pdf");
  });

  it("routes .md and .log through the csv text path", () => {
    expect(detectFormat("notes.md")).toBe("csv");
    expect(detectFormat("server.log")).toBe("csv");
  });

  it("still rejects unknown types honestly", () => {
    expect(detectFormat("photo.png")).toBeNull();
  });
});

describe("extractPdf", () => {
  it("extracts per-line (page, text) CSV from a real PDF", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(here, "__fixtures__", "minimal.pdf"), "latin1")
        .split("")
        .map((c) => c.charCodeAt(0) & 0xff)
    );
    const result = await extractPdf(bytes);
    expect(result.pages).toBe(1);
    expect(result.emptyPages).toEqual([]);
    const lines = result.csv.split("\n");
    expect(lines[0]).toBe("page,text");
    const text = result.csv.toLowerCase();
    expect(text).toContain("hello airlock");
    expect(text).toContain("pay equity analysis");
    // Every row carries its 1-based page number.
    const body = lines.slice(1).filter(Boolean);
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row.startsWith("1,")).toBe(true);
    }
  });

  it("refuses non-PDF bytes with a parse error", async () => {
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await expect(extractPdf(junk)).rejects.toThrow();
  });
});
