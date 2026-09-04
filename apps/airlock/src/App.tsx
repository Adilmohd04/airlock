import { useEffect, useState } from "react";
import { useActiveDataset } from "./engine/useDataset";
import { useUI, uiStore } from "./engine/uiStore";
import { useAirlockTools } from "./agent/tools";
import {
  onHostAttach,
  watchForNativeHost,
} from "./agent/hostAttach";
import { TopBar } from "./components/TopBar";
import { LeftRail } from "./components/LeftRail";
import { CenterTabs } from "./components/CenterTabs";
import { RecipePanel } from "./components/RecipePanel";
import { DataGrid } from "./components/DataGrid";
import { ChartPanel } from "./components/ChartPanel";
import { ReportPanel } from "./components/ReportPanel";
import { RightRail } from "./components/RightRail";
import { EmptyState } from "./components/EmptyState";
import { AgentConsole } from "./components/AgentConsole";
import { LoadingIndicator } from "./components/LoadingIndicator";

export function App() {
  // Bumped whenever a native WebMCP host attaches after page load: the
  // tools effect below disposes the polyfill registrations and re-registers
  // the same suite on the native instance the real host reads.
  const [hostGen, setHostGen] = useState(0);
  useAirlockTools(hostGen);
  const { state } = useActiveDataset();
  const ui = useUI();
  const loaded = !!state?.loaded;

  useEffect(() => {
    const offWatch = watchForNativeHost();
    const offAttach = onHostAttach(() => setHostGen((g) => g + 1));
    return () => {
      offWatch();
      offAttach();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code (physical key) instead of e.key (layout character): on some
      // layouts backtick is a dead key and never equals "`" — the console
      // shortcut silently did nothing there.
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.code === "Backquote" || e.key === "`")
      ) {
        e.preventDefault();
        uiStore.toggleConsole();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-slate-200">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        {!loaded ? (
          <EmptyState />
        ) : (
          <>
            <LeftRail />
            <main className="flex min-w-0 flex-1 flex-col border-x border-ink-800">
              <CenterTabs />
              <RecipePanel />
              <div className="min-h-0 flex-1 overflow-hidden">
                {ui.tab === "grid" && <DataGrid />}
                {ui.tab === "charts" && <ChartPanel />}
                {ui.tab === "report" && <ReportPanel />}
              </div>
            </main>
            <RightRail />
          </>
        )}
        {ui.loading.active && <LoadingIndicator name={ui.loading.datasetName} />}
        {/* Reload-path error: only surfaced when a dataset is already shown.
            On first load the EmptyState's FileDrop renders its own inline
            text-danger line, so surfacing loadError here too would duplicate
            the same failure. In the reload case there is no other error
            surface, so the app shell owns it (R6.3). */}
        {loaded && !ui.loading.active && ui.loadError && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-4">
            <p className="pointer-events-auto rounded-md bg-ink-800/90 px-3 py-2 text-xs text-danger shadow-lg">
              Couldn’t load {ui.loadError.datasetName}: {ui.loadError.message}
            </p>
          </div>
        )}
      </div>
      {ui.consoleOpen && <AgentConsole />}
    </div>
  );
}
