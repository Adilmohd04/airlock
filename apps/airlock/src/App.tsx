import { useEffect } from "react";
import { useActiveDataset } from "./engine/useDataset";
import { useUI, uiStore } from "./engine/uiStore";
import { useAirlockTools } from "./agent/tools";
import { TopBar } from "./components/TopBar";
import { LeftRail } from "./components/LeftRail";
import { CenterTabs } from "./components/CenterTabs";
import { DataGrid } from "./components/DataGrid";
import { ChartPanel } from "./components/ChartPanel";
import { ReportPanel } from "./components/ReportPanel";
import { RightRail } from "./components/RightRail";
import { EmptyState } from "./components/EmptyState";
import { AgentConsole } from "./components/AgentConsole";
import { LoadingIndicator } from "./components/LoadingIndicator";

export function App() {
  useAirlockTools();
  const { state } = useActiveDataset();
  const ui = useUI();
  const loaded = !!state?.loaded;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && (e.metaKey || e.ctrlKey)) {
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
