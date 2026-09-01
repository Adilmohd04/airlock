import { useActiveDataset } from "../engine/useDataset";
import { uiStore, useUI } from "../engine/uiStore";
import { SealStatus } from "./SealStatus";
import { WebMCPStatus } from "./WebMCPStatus";
import { MobileGate } from "./MobileGate";
import { num } from "../lib/format";

export function TopBar() {
  const { state } = useActiveDataset();
  const ui = useUI();

  return (
    <>
    <MobileGate />
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-ink-800 bg-ink-900 px-4">
      <div className="flex items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-airlock-500 text-ink-950">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4Zm2 6H6V5a2 2 0 1 1 4 0v2Z" />
          </svg>
        </div>
        <span className="font-semibold tracking-tight text-white">Airlock</span>
        <span className="hidden text-xs text-slate-500 sm:inline">
          the agent works on data that never leaves your browser
        </span>
      </div>

      <div className="ml-2 flex items-center gap-2">
        <SealStatus />
        <WebMCPStatus />
      </div>

      <div className="ml-auto flex items-center gap-3 text-xs">
        {state?.loaded && (
          <span className="font-mono text-slate-400">
            <span className="text-slate-200">{state.fileName}</span>
            <span className="mx-1.5 text-slate-600">·</span>
            {num(state.totalRows)} rows
            <span className="mx-1.5 text-slate-600">·</span>
            {state.columns.length + state.derived.length} cols
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost !px-2 !py-1 text-xs"
          onClick={() => uiStore.toggleConsole()}
          aria-pressed={ui.consoleOpen}
          title="Toggle the agent console (Ctrl/Cmd + `)"
        >
          Agent console
        </button>
      </div>
    </header>
    </>
  );
}
