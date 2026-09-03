/**
 * ocr.test.ts — image import stays honest: format detection routes images,
 * and extraction refuses to run outside the browser (Node has no window,
 * no same-origin /tessdata/, no Web Worker OCR).
 */
import { describe, it, expect } from "vitest";
import { detectFormat } from "./importFormats";
import { extractImageText, TESSDATA_HINT } from "./ocr";

describe("format detection accepts images", () => {
  it("routes common raster extensions/MIMEs to the image importer", () => {
    expect(detectFormat("photo.png")).toBe("image");
    expect(detectFormat("scan.JPG")).toBe("image");
    expect(detectFormat("x.bin", "image/png")).toBe("image");
    expect(detectFormat("x.bin", "image/jpeg")).toBe("image");
  });
});

describe("extractImageText", () => {
  it("refuses outside the browser (Node has no OCR runtime)", async () => {
    await expect(extractImageText(new Uint8Array([0, 1, 2]))).rejects.toThrow();
  });

  it("publishes an honest tessdata hint for the missing-data path", () => {
    expect(TESSDATA_HINT).toContain("/tessdata/eng.traineddata.gz");
  });
});
