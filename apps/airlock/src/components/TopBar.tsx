import React from "react";
import { useActiveDataset } from "../engine/useDataset";
import { uiStore, useUI } from "../engine/uiStore";
import { SealStatus } from "./SealStatus";
import { WebMCPStatus } from "./WebMCPStatus";
import { LocalModelPanel } from "./LocalModelPanel";
import { ModelDownloadDialog } from "./ModelDownloadDialog";
import { AttestationPanel } from "./AttestationPanel";
import { SessionMenu } from "./SessionMenu";
import { MobileGate } from "./MobileGate";
import { num } from "../lib/format";
import { taglineFor, useAgentMode } from "../agent/agentMode";
import { localAgent } from "../agent/localModel/agent";

/** Live agent run status, so the console button can show when it's working. */
function useAgentRunStatus() {
  return React.useSyncExternalStore(
    localAgent.subscribe,
    () => localAgent.getState().status,
    () => localAgent.getState().status
  );
}

export function TopBar() {
  const { state } = useActiveDataset();
  const ui = useUI();
  const agentMode = useAgentMode();
  const agentStatus = useAgentRunStatus();
  const agentBusy =
    agentStatus === "thinking" ||
    agentStatus === "calling-tool" ||
    agentStatus === "waiting-approval";

  return (
    <>
    <MobileGate />
    <header className="flex h-12 shrink-0 items-center gap-3 overflow-hidden border-b border-ink-700/80 bg-gradient-to-b from-ink-850/90 to-ink-900/90 px-4 shadow-lift backdrop-blur">
      <div className="flex shrink-0 items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-lg bg-airlock-500 text-ink-950 shadow-glow">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4Zm2 6H6V5a2 2 0 1 1 4 0v2Z" />
          </svg>
        </div>
        <span className="font-semibold tracking-tight text-white">Airlock</span>
        <span className="hidden max-w-[18rem] truncate text-xs text-slate-500 [@media(min-width:1600px)]:inline">
          {taglineFor(agentMode)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <SealStatus />
        <WebMCPStatus />
        <LocalModelPanel />
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2 text-xs">
        {state?.loaded && (
          <span className="hidden min-w-0 items-center gap-1.5 font-mono text-slate-400 md:flex">
            <span className="max-w-[11rem] truncate text-slate-200">{state.fileName}</span>
            <span className="shrink-0 text-slate-600">·</span>
            <span className="shrink-0">{num(state.totalRows)} rows</span>
            <span className="shrink-0 text-slate-600">·</span>
            <span className="shrink-0">
              {state.columns.length + state.derived.length} cols
            </span>
          </span>
        )}
        {state?.loaded && <AttestationPanel />}
        <SessionMenu />
        <button
          type="button"
          className="btn btn-ghost shrink-0 whitespace-nowrap !px-2 !py-1 text-xs"
          onClick={() => uiStore.toggleConsole()}
          aria-pressed={ui.consoleOpen}
          title="Open the agent console: run the local model, or call tools manually (Ctrl/Cmd + `)"
        >
          {agentBusy && (
            <span
              className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                agentStatus === "waiting-approval"
                  ? "bg-pending"
                  : "bg-pending animate-pending-pulse"
              }`}
            />
          )}
          Agent console
        </button>
      </div>
    </header>
    <ModelDownloadDialog />
    </>
  );
}
