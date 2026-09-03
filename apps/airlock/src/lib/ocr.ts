/**
 * ocr.ts — image → CSV text extraction (OCR), fully client-side.
 *
 * Self-hosted `tesseract.js` (Apache-2.0), lazy-imported so it costs nothing
 * until the first image import. Zero egress by construction:
 * - `workerPath` is a same-origin Vite `?url` asset, never the jsdelivr CDN
 *   default (`src/worker/browser/defaultOptions.js`).
 * - `langPath` is same-origin `/tessdata/` (populated by
 *   `scripts/fetch-tessdata.mjs`, gitignored like `/models/`). The default
 *   jsdelivr lang URL is never used.
 * - Bytes never leave the tab — same discipline as every other importer.
 *
 * Output shape: one CSV row per non-empty OCR text line, with a 1-based line
 * number. That keeps images queryable ("which line mentions X?") the same way
 * PDFs (`lib/pdf.ts` → (page, text)) and DOCX (`lib/docx.ts` → (para, text))
 * are — the agent's read tools work unchanged.
 */

import { rowsToCsv } from "./csv";

export const OCR_IMPORT_NOTE =
  "Image text is OCR'd on-device into (line, text) columns; handwriting and low-contrast photos may yield little or no text.";
export const TESSDATA_HINT =
  "Image OCR needs the on-device language data at /tessdata/eng.traineddata.gz (run: node scripts/fetch-tessdata.mjs).";

function origin(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "";
}

/** Same-origin probe — HEAD, no body, never third-party. */
async function hasTessdata(): Promise<boolean> {
  try {
    const res = await fetch(`${origin()}/tessdata/eng.traineddata.gz`, {
      method: "HEAD",
    });
    return res.ok;
  } catch {
    return false;
  }
}

let workerUrlPromise: Promise<string> | null = null;
function workerUrl(): Promise<string> {
  workerUrlPromise ??= import("tesseract.js/dist/worker.min.js?url").then(
    (m) => (m as { default: string }).default
  );
  return workerUrlPromise;
}

export interface OcrExtractResult {
  /** CSV text with header `line,text`. */
  csv: string;
  lines: number;
}

export async function extractImageText(bytes: Uint8Array): Promise<OcrExtractResult> {
  if (typeof window === "undefined") {
    throw new Error("Image OCR runs in the browser only.");
  }
  if (!(await hasTessdata())) throw new Error(TESSDATA_HINT);

  const [Tesseract, workerPath] = await Promise.all([
    import("tesseract.js"),
    workerUrl(),
  ]);
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    workerPath,
    langPath: `${origin()}/tessdata`,
    gzip: true,
  } as Record<string, unknown>);
  try {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer]);
    const {
      data: { text },
    } = await worker.recognize(blob);
    const rows: { line: number; text: string }[] = [];
    let n = 0;
    for (const raw of String(text ?? "").split(/\r\n|\r|\n/)) {
      const t = raw.trim();
      if (!t) continue;
      n += 1;
      rows.push({ line: n, text: t });
    }
    return {
      csv: rowsToCsv(["line", "text"], rows as unknown as Record<string, unknown>[]),
      lines: n,
    };
  } finally {
    await worker.terminate();
  }
}
