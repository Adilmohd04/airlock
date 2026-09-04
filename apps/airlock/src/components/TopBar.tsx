import React from "react";
import { useActiveDataset } from "../engine/useDataset";
import { uiStore, useUI } from "../engine/uiStore";
import { SealStatus } from "./SealStatus";
import { ModelCenter } from "./ModelCenter";
import { getModel, useLocalModelStore } from "./LocalModelPanel";
import { ModelDownloadDialog } from "./ModelDownloadDialog";
import { AttestationPanel } from "./AttestationPanel";
import { SessionMenu } from "./SessionMenu";
import { MobileGate } from "./MobileGate";
import { num } from "../lib/format";
import { useAgentMode } from "../agent/agentMode";
import { endpointHost, isEndpointConfigured } from "../agent/byo/client";
import { localAgent } from "../agent/localModel/agent";

/** Live agent run status, so the assistant button can show when it's working. */
function useAgentRunStatus() {
  return React.useSyncExternalStore(
    localAgent.subscribe,
    () => localAgent.getState().status,
    () => localAgent.getState().status
  );
}

/** One line: which brain, where it runs, is it ready. Same facts as the old
 *  WebMCPStatus + LocalModelPanel pills, said once instead of twice. */
function useModelHeadline(): { dot: string; text: string } {
  const mode = useAgentMode();
  const local = useLocalModelStore();

  if (mode.host.kind === "native") {
    return { dot: "bg-pending", text: `Cloud · ${mode.host.name || "connected host"}` };
  }
  if (mode.mode === "local") {
    const label = getModel(local.activeModelId ?? local.selectedModelId).label;
    if (local.status === "running") return { dot: "bg-airlock-400", text: `Local · ${label}` };
    if (local.status === "downloading")
      return { dot: "bg-pending animate-pending-pulse", text: `Local · downloading ${Math.round((local.progress?.fraction ?? 0) * 100)}%` };
    if (local.status === "ready") return { dot: "bg-airlock-400", text: `Local · ${label} (not loaded)` };
    return { dot: "bg-ink-500", text: "Local · not set up" };
  }
  if (mode.mode === "byo-endpoint") {
    return isEndpointConfigured()
      ? { dot: "bg-airlock-400", text: `Your endpoint · ${endpointHost()}` }
      : { dot: "bg-ink-500", text: "Bring your own · not connected" };
  }
  return { dot: "bg-ink-500", text: "Cloud · not connected" };
}

export function TopBar() {
  const { state } = useActiveDataset();
  const ui = useUI();
  const agentStatus = useAgentRunStatus();
  const headline = useModelHeadline();
  const agentBusy =
    agentStatus === "thinking" ||
    agentStatus === "calling-tool" ||
    agentStatus === "waiting-approval";

  return (
    <>
    <MobileGate />
    <header className="flex h-14 shrink-0 items-center gap-3 overflow-x-clip overflow-y-visible border-b border-ink-700/80 bg-gradient-to-b from-ink-850/90 to-ink-900/90 px-4 shadow-lift backdrop-blur">
      {/* identity */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-airlock-500 text-ink-950 shadow-glow">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4Zm2 6H6V5a2 2 0 1 1 4 0v2Z" />
          </svg>
        </div>
        <span className="font-semibold tracking-tight text-white">Airlock</span>
        {state?.loaded && (
          <>
            <span className="hidden text-ink-600 sm:inline">/</span>
            <span className="hidden max-w-[10rem] truncate font-mono text-xs text-slate-400 sm:inline">
              {state.fileName}
            </span>
          </>
        )}
      </div>

      {/* the AI experience — one entry point */}
      <button
        type="button"
        onClick={() => uiStore.toggleLocalModelPanel()}
        aria-haspopup="dialog"
        aria-expanded={ui.localModel.panelOpen}
        title="What's analyzing your data, and where it runs"
        className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-airlock-700/60 hover:bg-ink-800"
      >
        <span className={`badge-dot ${headline.dot}`} />
        {headline.text}
        <span className="text-slate-600">▾</span>
      </button>

      {/* trust status */}
      <div className="flex shrink-0 items-center gap-1.5">
        <SealStatus />
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2 text-xs">
        {state?.loaded && (
          <span className="hidden min-w-0 items-center gap-1.5 font-mono text-slate-500 lg:flex">
            <span className="stat-num">{num(state.totalRows)}</span> rows
            <span className="text-ink-600">·</span>
            <span className="stat-num">{state.columns.length + state.derived.length}</span> cols
          </span>
        )}
        {state?.loaded && <AttestationPanel />}
        <SessionMenu />
        <button
          type="button"
          className="btn btn-secondary shrink-0 whitespace-nowrap !px-2.5 !py-1.5 text-xs"
          onClick={() => uiStore.toggleConsole()}
          aria-pressed={ui.consoleOpen}
          title="Ask Airlock's agent to analyze your data, or call a tool by hand (Ctrl/Cmd + `)"
        >
          {agentBusy && (
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${
                agentStatus === "waiting-approval" ? "bg-pending" : "bg-pending animate-pending-pulse"
              }`}
            />
          )}
          Ask Airlock
        </button>
      </div>
    </header>
    <ModelCenter />
    <ModelDownloadDialog />
    </>
  );
}
