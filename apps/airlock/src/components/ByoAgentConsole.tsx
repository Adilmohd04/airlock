/**
 * ByoAgentConsole — drive Airlock's tools from the user's own endpoint.
 *
 * Same shape as the local console: type a goal, the agent reads tools, stages
 * changes as proposals, and STOPS at each one for approval in the review
 * queue. Approving resumes it. The difference is only where the brain runs —
 * your Azure/OpenAI/Ollama endpoint instead of this tab — so the Seal counts
 * real egress here and never claims zero.
 */

import React, { useRef } from "react";
import { byoAgent, type ByoEvent, type ByoRunState } from "../agent/byo/agent";
import { endpointHost, isEndpointConfigured } from "../agent/byo/client";

function useByoRun(): ByoRunState {
  return React.useSyncExternalStore(
    byoAgent.subscribe,
    byoAgent.getState,
    byoAgent.getState
  );
}

const EVENT_STYLE: Record<ByoEvent["kind"], string> = {
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

const EVENT_LABEL: Record<ByoEvent["kind"], string> = {
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

export function ByoAgentConsole() {
  const run = useByoRun();
  const [goal, setGoal] = React.useState(
    "Summarize this dataset: row count, key columns, and one interesting aggregate."
  );
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [run.events.length, run.status]);

  // Endpoint config lives outside React state (memory-only client) — poll
  // until it appears so a just-saved endpoint enables the Run button.
  React.useEffect(() => {
    if (isEndpointConfigured()) return;
    const t = setInterval(() => {
      force();
      if (isEndpointConfigured()) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const configured = isEndpointConfigured();
  const busy = run.status === "thinking" || run.status === "calling-tool";
  const waiting = run.status === "waiting-approval";
  const active = busy || waiting;

  const start = () => {
    const g = goal.trim();
    if (!g || !configured) return;
    void byoAgent.run(g);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-2 py-1.5">
        <span className="panel-title">
          BYO agent
          <span className="ml-2 font-normal normal-case tracking-normal text-slate-600">
            {configured
              ? `via ${endpointHost()} — queries leave to your endpoint, counted`
              : "set endpoint URL, key and model in the WebMCP status pill"}
          </span>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 font-mono text-[11px]"
      >
        {run.events.length === 0 ? (
          <p className="text-slate-600">
            {configured
              ? "Type a goal and press Run. Reads run at once; every change stages for your approval."
              : "No endpoint yet. Open the WebMCP status pill (top bar), pick Bring your own, and save the URL, key and model — the key never leaves this tab's memory."}
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

      <div className="flex flex-col gap-2 border-t border-ink-800 p-2">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          spellCheck={false}
          rows={2}
          disabled={busy || waiting}
          placeholder="Ask your endpoint's model to analyze your data…"
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
              onClick={() => void byoAgent.stop()}
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary text-xs"
              onClick={start}
              disabled={!configured || goal.trim().length === 0}
              title={configured ? "Run via your endpoint (Ctrl/Cmd + Enter)" : "Configure the endpoint first"}
            >
              Run via endpoint
            </button>
          )}
          {run.step > 0 && (
            <span className="text-[11px] text-slate-600">
              step {run.step}/{run.stepCap}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
