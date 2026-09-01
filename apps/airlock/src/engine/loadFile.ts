/**
 * Client-side file loading. Thin wrappers over `workspaceStore` kept for
 * call-site convenience. The bytes are read from the user's File object and
 * handed straight to DuckDB-WASM — nothing is uploaded.
 *
 * These wrappers are also the single choke point that drives the cold-start
 * loading indicator: every load path (human FileDrop or agent-driven) goes
 * through here, so the `uiStore` transitions `beginLoad → endLoad|failLoad`
 * around the underlying `workspaceStore` call.
 */

import { uiStore } from "./uiStore";
import { workspaceStore } from "./workspaceStore";
import { detectFormat } from "../lib/importFormats";

/** Coerce an unknown thrown value to a sanitized, single-line message. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadFile(
  file: File,
  opts: { sheet?: string } = {}
): Promise<void> {
  const name = file.name;
  // Synchronous — fires before the first await so the indicator shows this tick.
  uiStore.beginLoad(name);
  try {
    await workspaceStore.loadFile(file, opts);
    uiStore.endLoad();
  } catch (e) {
    // Sanitized: Error.message only, never the stack. Re-throw so existing
    // call-site error handling (e.g. FileDrop's local error line) still runs.
    uiStore.failLoad(name, errorMessage(e));
    throw e;
  }
}

/**
 * The .xlsx sheet names, so `FileDrop` can show a picker before importing a
 * multi-sheet workbook. Returns `null` for non-xlsx files.
 */
export async function xlsxSheetNames(file: File): Promise<string[] | null> {
  if (detectFormat(file.name, file.type) !== "xlsx") return null;
  return workspaceStore.xlsxSheetNames(file);
}

/** Import clipboard-pasted delimited text (TSV/CSV/…), delimiter auto-sniffed. */
export async function loadPastedText(
  text: string,
  fileName = "pasted-data.csv"
): Promise<void> {
  uiStore.beginLoad(fileName);
  try {
    await workspaceStore.loadPastedText(text, fileName);
    uiStore.endLoad();
  } catch (e) {
    uiStore.failLoad(fileName, errorMessage(e));
    throw e;
  }
}

/**
 * Pick one local file through the File System Access API when the browser has
 * it (Chromium), falling back to a transient `<input type=file>` elsewhere. Only
 * *selects* the file — the caller loads it, so the .xlsx sheet-picker flow is
 * shared with drag-drop. Returns `null` if the user dismissed the picker.
 */
export async function pickLocalFile(): Promise<File | null> {
  type PickerWindow = Window & {
    showOpenFilePicker?: (o?: unknown) => Promise<{ getFile: () => Promise<File> }[]>;
  };
  const w = window as PickerWindow;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const handles = await w.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Tabular data",
            accept: {
              "text/csv": [".csv", ".tsv"],
              "application/json": [".json"],
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                [".xlsx"],
              "application/octet-stream": [".parquet"],
            },
          },
        ],
      });
      return handles?.[0] ? await handles[0].getFile() : null;
    } catch (e) {
      // AbortError == user cancelled; anything else is a real failure.
      if (e instanceof DOMException && e.name === "AbortError") return null;
      throw e;
    }
  }

  // Fallback: a transient <input type=file>.
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.json,.xlsx,.parquet";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Load a bundled demo dataset by URL (still entirely client-side). */
export async function loadDemo(url: string, fileName: string): Promise<void> {
  uiStore.beginLoad(fileName);
  try {
    await workspaceStore.loadDemo(url, fileName);
    uiStore.endLoad();
  } catch (e) {
    uiStore.failLoad(fileName, errorMessage(e));
    throw e;
  }
}
