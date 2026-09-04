/**
 * LocalAgentConsole — drive the on-device model against Airlock's own tools.
 *
 * This is the headline surface: type a goal, the local agent (T1-b) runs the
 * read tools, stages changes as proposals, and STOPS at each one for your
 * approval in the review queue. When you approve (or reject) in the RightRail,
 * the loop resumes automatically — the agent watches the same proposal store
 * the Approve button writes to, so there is no separate "resume" button.
 *
 * It renders only the transcript + controls. It never claims a privacy
 * guarantee itself; the Seal (`SealStatus`) owns that, honestly, from the
 * measured egress count. The one thing this panel asserts is architectural and
 * true: in Local mode the model runs in this tab, so a run adds nothing to the
 * egress counter.
 */

import React, { useEffect, useRef } from "react";
import { localAgent, type AgentRunState } from "../agent/localModel/agent";
import { useLocalModelStore } from "./LocalModelPanel";
import { AssistantTranscript } from "./AssistantTranscript";

const EXAMPLES = [
  "Find pay gaps by gender and flag anyone paid 15% below their market median",
  "Summarize this dataset in three sentences",
  "Which department has the widest salary range?",
];

function useAgentRun(): AgentRunState {
  return React.useSyncExternalStore(
    localAgent.subscribe,
    localAgent.getState,
    localAgent.getState
  );
}

export function LocalAgentConsole() {
  const model = useLocalModelStore();
  const run = useAgentRun();
  const [goal, setGoal] = React.useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the transcript as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [run.events.length, run.status]);

  const ready = model.status === "running";
  const busy = run.status === "thinking" || run.status === "calling-tool";
  const waiting = run.status === "waiting-approval";
  const active = busy || waiting; // a run is in progress (show Stop)

  const start = (g = goal.trim()) => {
    if (!g || !ready) return;
    void localAgent.run(g);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-xs text-slate-500">
          {ready ? (
            <>
              On-device ·{" "}
              <span className="text-slate-300">{model.activeModelId ?? "model"}</span>
            </>
          ) : (
            "Load a local model above to run this fully offline"
          )}
        </span>
        <StatusPill status={run.status} />
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        <AssistantTranscript
          events={run.events}
          waiting={waiting}
          ready={ready}
          emptyReady="What would you like Airlock's agent to analyze? It reads freely and stages every change for your approval."
          emptyNotReady="The local model isn't loaded yet. Open the AI menu in the top bar, download it once, then load it — after that this runs fully offline, on your device."
          examples={EXAMPLES}
          onExample={(ex) => {
            setGoal(ex);
            start(ex);
          }}
        />
      </div>

      {/* Composer */}
      <div className="flex flex-col gap-2 border-t border-ink-800 p-3">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          spellCheck={false}
          rows={2}
          disabled={busy || waiting}
          placeholder="Ask Airlock anything about your data…"
          className="resize-none rounded-lg border border-ink-700 bg-ink-900 p-2.5 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-airlock-600 focus:outline-none disabled:opacity-60"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              start();
            }
          }}
        />
        <div className="flex items-center gap-2">
          {active ? (
            <button
              className="btn text-xs border border-danger/50 text-danger hover:bg-danger/10"
              onClick={() => void localAgent.stop()}
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary text-xs"
              onClick={() => start()}
              disabled={!ready || goal.trim().length === 0}
              title={ready ? "Run (Ctrl/Cmd + Enter)" : "Load a local model first"}
            >
              Run
            </button>
          )}
          {run.step > 0 && (
            <span className="text-[11px] text-slate-600">
              step {run.step}/{run.stepCap}
            </span>
          )}
          <span className="ml-auto text-[10px] text-slate-600">Ctrl/Cmd + Enter</span>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AgentRunState["status"] }) {
  const meta: Record<AgentRunState["status"], { dot: string; word: string }> = {
    idle: { dot: "bg-ink-500", word: "idle" },
    thinking: { dot: "bg-pending animate-pending-pulse", word: "thinking" },
    "calling-tool": { dot: "bg-airlock-400 animate-pending-pulse", word: "working" },
    "waiting-approval": { dot: "bg-pending", word: "waiting for you" },
    done: { dot: "bg-commit", word: "done" },
    error: { dot: "bg-danger", word: "error" },
    stopped: { dot: "bg-ink-500", word: "stopped" },
  };
  const m = meta[status];
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.word}
    </span>
  );
}
