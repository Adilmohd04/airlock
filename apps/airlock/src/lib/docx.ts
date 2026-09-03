/**
 * docx.ts — DOCX → CSV text extraction, fully client-side.
 *
 * Self-hosted `mammoth` (MIT), lazy-imported so it lands in its own async
 * chunk and costs nothing on the initial load. Zero egress: pure JS zip+XML
 * parse, no worker, no fetch — bytes never leave the tab, same discipline
 * as every other importer.
 *
 * Output shape: one CSV row per non-empty paragraph/table-cell line, with a
 * 1-based para index. That keeps documents queryable the same way PDFs are
 * (`lib/pdf.ts` yields (page, text); we yield (para, text)) — the agent's
 * read tools work unchanged.
 */

import { rowsToCsv } from "./csv";

export const DOCX_IMPORT_NOTE =
  "DOCX text is extracted per paragraph into (para, text) columns; embedded images are not OCR'd here — import the image itself for that.";

export interface DocxExtractResult {
  /** CSV text with header `para,text`. */
  csv: string;
  paras: number;
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxExtractResult> {
  const { default: mammoth } = await import("mammoth");
  // Mammoth wants an ArrayBuffer copy; slice() detaches from any pool.
  const { value } = await mammoth.extractRawText({
    arrayBuffer: bytes.slice().buffer as ArrayBuffer,
  });
  const rows: { para: number; text: string }[] = [];
  let n = 0;
  for (const line of String(value ?? "").split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (!t) continue;
    n += 1;
    rows.push({ para: n, text: t });
  }
  return {
    csv: rowsToCsv(["para", "text"], rows as unknown as Record<string, unknown>[]),
    paras: n,
  };
}
