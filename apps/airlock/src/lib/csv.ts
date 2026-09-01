/** One CSV field, quoted only when it has to be. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows -> RFC-4180-ish CSV string, entirely in the browser. */
export function rowsToCsv(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  const head = columns.map(csvField).join(",");
  const body = rows
    .map((r) => columns.map((c) => csvField(r[c])).join(","))
    .join("\n");
  return body ? `${head}\n${body}` : head;
}

/**
 * Parse delimited text (RFC-4180 quoting, any single-char delimiter) into a
 * row-major grid. Used for clipboard paste — TSV/CSV/semicolon-separated text
 * the human copied out of a spreadsheet. Quotes protect embedded delimiters and
 * newlines; `""` is a literal quote.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Row-major grid -> comma CSV. The inverse container for `parseDelimited`. */
export function gridToCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n");
}

/**
 * Trigger a client-side download. This is the one place bytes intentionally
 * leave the page — into the user's own Downloads folder, on their explicit
 * approval, never over the network.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(
  filename: string,
  text: string,
  mime = "text/plain;charset=utf-8"
): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Download raw bytes (e.g. an .xlsx workbook from `viewToXlsx`). */
export function downloadBytes(
  filename: string,
  bytes: Uint8Array,
  mime = "application/octet-stream"
): void {
  downloadBlob(filename, new Blob([bytes as BlobPart], { type: mime }));
}
