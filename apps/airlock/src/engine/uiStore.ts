/** Small UI-only store: which center tab is showing, right-rail state. */

import React from "react";

export type CenterTab = "grid" | "charts" | "report";

interface UIState {
  tab: CenterTab;
  activityOpen: boolean;
  consoleOpen: boolean;
  // Cold-start feedback: which dataset (if any) is currently loading.
  loading: { active: boolean; datasetName: string | null };
  // Last load failure; message is a sanitized Error.message, never a stack.
  loadError: { datasetName: string; message: string } | null;
}

type Listener = () => void;

class UIStore {
  private state: UIState = {
    tab: "grid",
    activityOpen: true,
    consoleOpen: false,
    loading: { active: false, datasetName: null },
    loadError: null,
  };
  private listeners = new Set<Listener>();

  getState = (): UIState => this.state;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(patch: Partial<UIState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  setTab(tab: CenterTab): void {
    this.set({ tab });
  }
  toggleActivity(): void {
    this.set({ activityOpen: !this.state.activityOpen });
  }
  toggleConsole(): void {
    this.set({ consoleOpen: !this.state.consoleOpen });
  }
  // Fires synchronously before any await so the indicator shows within the tick.
  beginLoad(datasetName: string): void {
    this.set({ loading: { active: true, datasetName } });
  }
  // Success path: clear the indicator and any prior error.
  endLoad(): void {
    this.set({ loading: { active: false, datasetName: null }, loadError: null });
  }
  // Failure path: stop loading and record the sanitized message verbatim.
  failLoad(datasetName: string, message: string): void {
    this.set({
      loading: { active: false, datasetName: null },
      loadError: { datasetName, message },
    });
  }
}

export const uiStore = new UIStore();

export function useUI(): UIState {
  return React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getState,
    uiStore.getState
  );
}
