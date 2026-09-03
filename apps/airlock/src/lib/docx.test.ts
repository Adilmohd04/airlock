/**
 * docx.test.ts — DOCX import: format detection routes to the new "docx" kind,
 * and extraction refuses junk bytes honestly (mammoth parses real zips only).
 */
import { describe, it, expect } from "vitest";
import { detectFormat } from "./importFormats";
import { extractDocx } from "./docx";

describe("format detection accepts docx", () => {
  it("routes .docx (and its MIME) to the docx importer", () => {
    expect(detectFormat("report.docx")).toBe("docx");
    expect(detectFormat("REPORT.DOCX")).toBe("docx");
    expect(
      detectFormat(
        "x.bin",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("docx");
  });
});

describe("extractDocx", () => {
  it("refuses non-DOCX bytes with a parse error", async () => {
    const junk = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await expect(extractDocx(junk)).rejects.toThrow();
  });
});
