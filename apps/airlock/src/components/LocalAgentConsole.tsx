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
import { localAgent, type AgentEvent, type AgentRunState } from "../agent/localModel/agent";
import { useLocalModelStore } from "./LocalModelPanel";

function useAgentRun(): AgentRunState {
  return React.useSyncExternalStore(
    localAgent.subscribe,
    localAgent.getState,
    localAgent.getState
  );
}

const EVENT_STYLE: Record<AgentEvent["kind"], string> = {
  user: "text-slate-200",
  reasoning: "text-slate-500 italic",
  "tool-call": "text-airlock-300",
  "tool-result": "text-slate-400",
  waiting: "text-pending",
  approved: "text-commit",
  rejected: "text-danger",
  final: "text-slate-100",
  error: "text-danger",
  notice: "text-slate-500",
};

const EVENT_LABEL: Record<AgentEvent["kind"], string> = {
  user: "goal",
  reasoning: "thinking",
  "tool-call": "call",
  "tool-result": "result",
  waiting: "staged",
  approved: "approved",
  rejected: "rejected",
  final: "done",
  error: "error",
  notice: "note",
};

export function LocalAgentConsole() {
  const model = useLocalModelStore();
  const run = useAgentRun();
  const [goal, setGoal] = React.useState(
    "Find pay gaps by gender, flag anyone paid more than 15% below their market median, and write a one-paragraph summary."
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the transcript as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [run.events.length, run.status]);

  const ready = model.status === "running";
  const busy = run.status === "thinking" || run.status === "calling-tool";
  const waiting = run.status === "waiting-approval";
  const active = busy || waiting; // a run is in progress (show Stop)

  const start = () => {
    const g = goal.trim();
    if (!g || !ready) return;
    void localAgent.run(g);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-2 py-1.5">
        <span className="panel-title">
          Local agent
          <span className="ml-2 font-normal normal-case tracking-normal text-slate-600">
            {ready
              ? `on-device · ${model.activeModelId ?? "model"}`
              : "load a local model to run"}
          </span>
        </span>
        <StatusPill status={run.status} />
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 font-mono text-[11px]"
      >
        {run.events.length === 0 ? (
          <p className="text-slate-600">
            {ready
              ? "Type a goal and press Run. The agent will read the data, then stage each change for your approval."
              : "The local model isn't loaded. Open the model panel in the top bar, download it once, then load it — after that this runs fully offline."}
          </p>
        ) : (
          run.events.map((e) => (
            <div key={e.id} className="leading-snug">
              <span className="mr-1.5 select-none text-slate-600">
                {EVENT_LABEL[e.kind]}
                {e.tool ? ` ${e.tool}` : ""}:
              </span>
              <span className={EVENT_STYLE[e.kind]}>{e.text}</span>
            </div>
          ))
        )}
        {waiting && (
          <div className="mt-1 rounded-md border border-pending/40 bg-pending/5 px-2 py-1.5 text-pending">
            A change is staged. Approve or reject it in the review queue on the
            right — the agent resumes the moment you do.
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 border-t border-ink-800 p-2">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          spellCheck={false}
          rows={2}
          disabled={busy || waiting}
          placeholder="Ask the local agent to analyze your data…"
          className="resize-none rounded-md border border-ink-700 bg-ink-900 p-2 text-[12px] text-slate-200 placeholder:text-slate-600 focus:border-airlock-600 focus:outline-none disabled:opacity-60"
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
              onClick={start}
              disabled={!ready || goal.trim().length === 0}
              title={ready ? "Run the local agent (Ctrl/Cmd + Enter)" : "Load a local model first"}
            >
              Run locally
            </button>
          )}
          {run.step > 0 && (
            <span className="text-[11px] text-slate-600">
              step {run.step}/{run.stepCap}
            </span>
          )}
          <span className="ml-auto text-[10px] text-slate-600">
            Ctrl/Cmd + Enter to run
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AgentRunState["status"] }) {
  const meta: Record<AgentRunState["status"], { dot: string; word: string }> = {
    idle: { dot: "bg-ink-500", word: "idle" },
    thinking: { dot: "bg-pending animate-pending-pulse", word: "thinking" },
    "calling-tool": { dot: "bg-airlock-400 animate-pending-pulse", word: "tool" },
    "waiting-approval": { dot: "bg-pending", word: "waiting" },
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
