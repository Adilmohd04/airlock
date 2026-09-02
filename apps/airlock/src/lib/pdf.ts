/**
 * pdf.ts — PDF → CSV text extraction, fully client-side.
 *
 * Self-hosted `pdfjs-dist` (Mozilla, Apache-2.0), lazy-imported so it lands in
 * its own async chunk and costs nothing on the initial load. Zero egress: the
 * worker bundle is emitted by Vite from the same origin, and the bytes never
 * leave the tab — same discipline as every other importer.
 *
 * Output shape: one CSV row per non-empty extracted text line, with the 1-based
 * page number. That keeps documents queryable ("which page mentions X?") the
 * same way a spreadsheet is — the agent's read tools work unchanged.
 */

import { rowsToCsv } from "./csv";

export const PDF_IMPORT_NOTE =
  "PDF text is extracted per line into (page, text) columns; scanned image-only PDFs contain no extractable text.";

/** Lazy: resolve the worker URL once, from the same origin. */
let workerSrcPromise: Promise<string> | null = null;
function workerSrc(): Promise<string> {
  workerSrcPromise ??= import("pdfjs-dist/build/pdf.worker.min.mjs?url").then(
    (m) => (m as { default: string }).default
  );
  return workerSrcPromise;
}

export interface PdfExtractResult {
  /** CSV text with header `page,text`. */
  csv: string;
  pages: number;
  /** Pages that yielded no text at all (likely scanned images). */
  emptyPages: number[];
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtractResult> {
  const [pdfjs, workerUrl] = await Promise.all([
    import("pdfjs-dist"),
    workerSrc(),
  ]);
  // In Node (tests) pdfjs falls back to its fake worker via a plain module
  // import; the ?url asset only exists under Vite, i.e. in the browser.
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    // Keep everything local: no font rendering, no standard-font data fetch,
    // no eval — text extraction only.
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;

  const rows: { page: number; text: string }[] = [];
  const emptyPages: number[] = [];
  const numPages = doc.numPages;
  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    let lines = 0;
    const flush = () => {
      const t = line.trim();
      if (t) {
        rows.push({ page: p, text: t });
        lines += 1;
      }
      line = "";
    };
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) flush();
      else line += " ";
    }
    flush();
    if (lines === 0) emptyPages.push(p);
    page.cleanup();
  }
  await doc.destroy();

  return {
    csv: rowsToCsv(["page", "text"], rows as unknown as Record<string, unknown>[]),
    pages: numPages,
    emptyPages,
  };
}
