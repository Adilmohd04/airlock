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

/** Coerce an unknown thrown value to a sanitized, single-line message. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadFile(file: File): Promise<void> {
  const name = file.name;
  // Synchronous — fires before the first await so the indicator shows this tick.
  uiStore.beginLoad(name);
  try {
    await workspaceStore.loadFile(file);
    uiStore.endLoad();
  } catch (e) {
    // Sanitized: Error.message only, never the stack. Re-throw so existing
    // call-site error handling (e.g. FileDrop's local error line) still runs.
    uiStore.failLoad(name, errorMessage(e));
    throw e;
  }
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
