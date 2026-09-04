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
import { byoAgent, type ByoRunState } from "../agent/byo/agent";
import { endpointHost, isEndpointConfigured } from "../agent/byo/client";
import { AssistantTranscript } from "./AssistantTranscript";

const EXAMPLES = [
  "Summarize this dataset: row count, key columns, one interesting aggregate",
  "Which department has the widest salary range?",
];

function useByoRun(): ByoRunState {
  return React.useSyncExternalStore(
    byoAgent.subscribe,
    byoAgent.getState,
    byoAgent.getState
  );
}

export function ByoAgentConsole() {
  const run = useByoRun();
  const [goal, setGoal] = React.useState("");
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

  const start = (g = goal.trim()) => {
    if (!g || !configured) return;
    void byoAgent.run(g);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-xs text-slate-500">
          {configured ? (
            <>
              Via <span className="text-slate-300">{endpointHost()}</span> — queries leave to
              your endpoint, counted
            </>
          ) : (
            "Set an endpoint URL, key and model in the AI menu above"
          )}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        <AssistantTranscript
          events={run.events}
          waiting={waiting}
          ready={configured}
          emptyReady="Type a goal. Reads run at once; every change stages for your approval."
          emptyNotReady="No endpoint yet. Open the AI menu (top bar) → Bring your own, and save the URL, key and model — the key never leaves this tab's memory."
          examples={EXAMPLES}
          onExample={(ex) => {
            setGoal(ex);
            start(ex);
          }}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-ink-800 p-3">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          spellCheck={false}
          rows={2}
          disabled={busy || waiting}
          placeholder="Ask your endpoint's model to analyze your data…"
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
              onClick={() => void byoAgent.stop()}
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary text-xs"
              onClick={() => start()}
              disabled={!configured || goal.trim().length === 0}
              title={configured ? "Run (Ctrl/Cmd + Enter)" : "Configure the endpoint first"}
            >
              Run
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
