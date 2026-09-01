import React from "react";
import { activityLog, type ActivityEntry } from "./activity";
import { reportStore, type InsightReport } from "./reports";

export function useActivity(): ActivityEntry[] {
  return React.useSyncExternalStore(
    activityLog.subscribe,
    activityLog.getState,
    activityLog.getState
  );
}

export function useReports(): InsightReport[] {
  return React.useSyncExternalStore(
    reportStore.subscribe,
    reportStore.getState,
    reportStore.getState
  );
}
