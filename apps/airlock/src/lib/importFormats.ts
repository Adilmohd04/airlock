/**
 * Import format detection + delimiter sniffing — pure string logic, no DuckDB.
 * `workspaceStore.loadFile` dispatches on `detectFormat`; the clipboard-paste
 * affordance in `FileDrop` uses `sniffDelimiter` to tell the human what it thinks
 * they pasted before importing it.
 *
 * The heavy parser (DuckDB's native reader for .parquet) lives behind this and is
 * only reached once a format is known — see `engine/duckdb.ts`.
 */

export type ImportFormat = "csv" | "tsv" | "json" | "parquet";

/** Formats that arrive as binary bytes rather than decodable text. */
export const BINARY_FORMATS: ReadonlySet<ImportFormat> = new Set<ImportFormat>([
  "parquet",
]);

const EXT_TO_FORMAT: Record<string, ImportFormat> = {
  csv: "csv",
  txt: "csv",
  tsv: "tsv",
  tab: "tsv",
  json: "json",
  ndjson: "json",
  parquet: "parquet",
  pq: "parquet",
};

// MIME is a weak hint (drag-drop and the FS Access API often report
// application/octet-stream) — used only when the extension is unknown.
const MIME_TO_FORMAT: Record<string, ImportFormat> = {
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "application/x-parquet": "parquet",
  "application/parquet": "parquet",
};

/** File extension, lower-cased, without the dot. `""` when there is none. */
export function fileExtension(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * Resolve a file to an import format, or `null` if unrecognised. Extension wins;
 * MIME is a fallback. The caller turns `null` into an honest "unsupported file"
 * error rather than guessing.
 */
export function detectFormat(
  fileName: string,
  mimeType?: string
): ImportFormat | null {
  const ext = fileExtension(fileName);
  if (ext && EXT_TO_FORMAT[ext]) return EXT_TO_FORMAT[ext];
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  if (mime && MIME_TO_FORMAT[mime]) return MIME_TO_FORMAT[mime];
  return null;
}

export interface DelimiterGuess {
  /** The delimiter character to hand DuckDB's CSV reader. */
  delimiter: string;
  /** Human label for the paste affordance ("tab", "comma", …). */
  label: string;
  /** Columns implied by the delimiter on the header row. */
  columns: number;
  /** True when every sampled row agrees on the column count. */
  consistent: boolean;
}

const CANDIDATES: { delimiter: string; label: string }[] = [
  { delimiter: "\t", label: "tab" },
  { delimiter: ",", label: "comma" },
  { delimiter: ";", label: "semicolon" },
  { delimiter: "|", label: "pipe" },
];

/** Count `delim` occurrences in one line, ignoring anything inside "double quotes". */
function countOutsideQuotes(line: string, delim: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // Doubled "" inside a quoted field is an escaped quote, not a toggle.
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delim) {
      n += 1;
    }
  }
  return n;
}

/**
 * Guess the delimiter of pasted / dropped delimited text. Samples the first
 * handful of non-empty lines and prefers the candidate whose per-line field
 * count is both positive and the most consistent. Falls back to comma so a
 * single-column paste still imports.
 */
export function sniffDelimiter(sample: string): DelimiterGuess {
  const lines = sample
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 12);

  if (lines.length === 0) {
    return { delimiter: ",", label: "comma", columns: 1, consistent: true };
  }

  let best: DelimiterGuess | null = null;
  for (const { delimiter, label } of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, delimiter));
    const firstRow = counts[0];
    if (firstRow === 0) continue; // delimiter absent from the header row
    const consistent = counts.every((c) => c === firstRow);
    const guess: DelimiterGuess = {
      delimiter,
      label,
      columns: firstRow + 1,
      consistent,
    };
    // Prefer a consistent guess; among equals prefer more columns; tab beats
    // comma at a tie because CANDIDATES is ordered that way.
    if (
      !best ||
      (guess.consistent && !best.consistent) ||
      (guess.consistent === best.consistent && guess.columns > best.columns)
    ) {
      best = guess;
    }
  }

  return best ?? { delimiter: ",", label: "comma", columns: 1, consistent: true };
}
