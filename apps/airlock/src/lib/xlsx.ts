/**
 * SheetJS wrapper — the ONLY module that touches the `xlsx` dependency, and it
 * pulls it in lazily via `import()` so the ~400 kB parser lands in its own async
 * chunk and never bloats the initial load (see `vite.config.ts`).
 *
 * Zero egress: `xlsx` is a self-hosted npm dependency bundled by Vite. Its
 * `browser` field stubs out `fs`/`crypto`/`stream`, so nothing here can reach
 * the network or the disk. We parse the workbook, take what we need (sheet names
 * or one sheet as CSV), and drop the workbook object — the value-bearing bytes
 * never linger.
 *
 * .xlsx flows through the existing CSV path: a sheet becomes CSV text, then
 * `registerCsv` runs exactly as it would for a dropped .csv. Persistence keeps
 * the original workbook bytes + the chosen sheet name so a restore re-derives
 * the identical CSV (see `workspaceStore` `sources` / `hydrate`).
 */

// Lazy singleton: first .xlsx import pays the download, the rest are free.
let sheetjs: Promise<typeof import("xlsx")> | null = null;
function getSheetJs(): Promise<typeof import("xlsx")> {
  return (sheetjs ??= import("xlsx"));
}

/**
 * SheetJS will happily read arbitrary bytes as a one-cell "text" sheet, so a
 * mis-named file imports as junk instead of erroring. Gate on the container
 * magic first: .xlsx / .xlsm are ZIP ("PK"), legacy .xls is OLE2/CFB.
 */
function assertSpreadsheetBytes(bytes: Uint8Array): void {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  const isOle2 =
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0;
  if (!isZip && !isOle2) {
    throw new Error(
      "That file isn't a spreadsheet — an .xlsx is a ZIP container and these bytes aren't. It may be renamed or corrupt."
    );
  }
}

function toMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // SheetJS is explicit about these two; pass them through cleaned up.
  if (/password-protected/i.test(raw)) {
    return "That spreadsheet is password-protected. Remove the password and try again.";
  }
  if (/Unsupported file|corrupt|zip|end of central directory|bad uncompressed size/i.test(raw)) {
    return "That file could not be read as a spreadsheet — it may be corrupt or not a real .xlsx.";
  }
  return `Could not read the spreadsheet: ${raw}`;
}

/** Sheet names in workbook order. Used to drive the multi-sheet picker. */
export async function readSheetNames(bytes: Uint8Array): Promise<string[]> {
  assertSpreadsheetBytes(bytes);
  try {
    const XLSX = await getSheetJs();
    // `bookSheets` parses the directory only — fast, no cell decoding.
    const wb = XLSX.read(bytes, { type: "array", bookSheets: true });
    return wb.SheetNames ?? [];
  } catch (e) {
    throw new Error(toMessage(e));
  }
}

export interface SheetCsv {
  /** The sheet actually converted (the requested one, or the only one). */
  sheet: string;
  /** All sheet names, so the caller can offer a switch. */
  sheetNames: string[];
  csv: string;
}

/**
 * Convert one sheet to CSV text. With no `sheet` given: the sole sheet if there
 * is one, otherwise this throws and names the sheets so the human can pick — a
 * multi-sheet workbook is never silently truncated to sheet 1.
 */
export async function sheetToCsv(
  bytes: Uint8Array,
  sheet?: string
): Promise<SheetCsv> {
  assertSpreadsheetBytes(bytes);
  let XLSX: typeof import("xlsx");
  let wb: import("xlsx").WorkBook;
  try {
    XLSX = await getSheetJs();
    wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: true });
  } catch (e) {
    throw new Error(toMessage(e));
  }

  const names = wb.SheetNames ?? [];
  if (names.length === 0) throw new Error("That workbook has no sheets.");

  let target = sheet;
  if (!target) {
    if (names.length > 1) {
      throw new Error(
        `That workbook has ${names.length} sheets (${names.join(", ")}). ` +
          "Choose which one to import."
      );
    }
    target = names[0];
  } else if (!names.includes(target)) {
    throw new Error(
      `No sheet named "${target}" in that workbook. Sheets: ${names.join(", ")}.`
    );
  }

  const ws = wb.Sheets[target];
  if (!ws) throw new Error(`Sheet "${target}" could not be read.`);
  const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, forceQuotes: false });
  if (!csv.trim()) throw new Error(`Sheet "${target}" is empty — nothing to import.`);

  return { sheet: target, sheetNames: names, csv };
}

/**
 * Serialize a result view to .xlsx bytes for `export_view`. One sheet, header
 * row + data. Mirrors `rowsToCsv` in `lib/csv.ts` — same rows, other container.
 */
export async function viewToXlsx(
  columns: string[],
  rows: Record<string, unknown>[]
): Promise<Uint8Array> {
  const XLSX = await getSheetJs();
  const aoa: unknown[][] = [
    columns,
    ...rows.map((r) => columns.map((c) => normalizeCell(r[c]))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Airlock export");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as
    | ArrayBuffer
    | Uint8Array;
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

/** DuckDB hands back bigint for integer columns and Date for timestamps. */
function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  return v;
}
