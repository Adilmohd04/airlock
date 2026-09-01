// NOTE: `import { useSyncExternalStore } from "react"` resolves to `undefined`
// under this Vite + React 18 CJS-interop setup (esbuild misses the named
// re-export). The default export carries it, so go through `React.`.
import React from "react";
import { workspaceStore, type WorkspaceState } from "./workspaceStore";
import type { DatasetState, DatasetStore } from "./datasetStore";

/** Subscribe a component to the top-level workspace (dataset list + active id). */
export function useWorkspace(): WorkspaceState {
  return React.useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getState,
    workspaceStore.getState
  );
}

export interface ActiveDataset {
  store: DatasetStore | null;
  state: DatasetState | null;
}

/**
 * Subscribe to the active dataset's state. The workspace store re-emits
 * whenever the active dataset's own store changes (see `bindActive`), so a
 * single subscription here is enough.
 */
export function useActiveDataset(): ActiveDataset {
  // Re-render on any workspace change (active switch OR active-store mutation).
  useWorkspace();
  const store = workspaceStore.getActiveStore();
  return { store, state: store ? store.getState() : null };
}
