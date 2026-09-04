/**
 * AssistantTranscript — the shared transcript renderer for the local agent
 * and the BYO agent consoles. Same event shape, same "friendly headline now,
 * raw tool call/result behind a toggle" progressive disclosure (spec: agent
 * transparency without a terminal feel) either console needs.
 *
 * Loosely typed on purpose: `AgentEvent` (local) and `ByoEvent` (BYO) are
 * separate types from separate modules with the same shape — this avoids
 * coupling the two agent loops together just to share a render function.
 */

import { useState } from "react";

export interface TranscriptEvent {
  id: number;
  kind: string;
  text: string;
  tool?: string;
}

const FRIENDLY_TOOL: Record<string, string> = {
  list_datasets: "Checking datasets",
  get_dataset_summary: "Reading the dataset summary",
  list_columns: "Checking the columns",
  profile_column: "Profiling a column",
  preview_rows: "Sampling rows",
  run_sql: "Running a query",
  describe_workspace: "Reading workspace state",
  get_activity_log: "Checking its own activity log",
  propose_add_filter: "Proposing a filter",
  propose_remove_filter: "Proposing to remove a filter",
  propose_clear_filters: "Proposing to clear the filters",
  propose_add_derived_column: "Proposing a derived column",
  propose_remove_derived_column: "Proposing to remove a column",
  propose_rename_column: "Proposing a rename",
  propose_redact_column: "Proposing a redaction",
  propose_add_chart: "Proposing a chart",
  propose_flag_rows: "Proposing to flag rows",
  propose_join_datasets: "Proposing a join",
  propose_export_view: "Proposing an export",
  propose_write_report: "Proposing a report",
};

function friendlyTool(tool: string | undefined): string {
  if (!tool) return "Working";
  return FRIENDLY_TOOL[tool] ?? tool.replace(/_/g, " ");
}

/** One row: a friendly headline always visible, the raw tool call/result
 *  (what a technical reader wants — the exact args or returned text) tucked
 *  behind "details" for tool-call / tool-result kinds only. Everything else
 *  (goal, reasoning, staged, approved, rejected, final, error, notice) is
 *  already human language and shown as-is. */
function EventRow({ e }: { e: TranscriptEvent }) {
  const [open, setOpen] = useState(false);

  if (e.kind === "user") {
    return <p className="text-[13px] font-medium text-slate-100">{e.text}</p>;
  }
  if (e.kind === "final") {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-900 p-3 text-[13px] leading-relaxed text-slate-100">
        {e.text}
      </div>
    );
  }
  if (e.kind === "reasoning") {
    return <p className="text-[12px] italic text-slate-500">{e.text}</p>;
  }
  if (e.kind === "notice") {
    return <p className="text-[11px] text-slate-600">{e.text}</p>;
  }
  if (e.kind === "approved" || e.kind === "rejected") {
    return (
      <p className={`text-[12px] ${e.kind === "approved" ? "text-commit" : "text-danger"}`}>
        {e.kind === "approved" ? "✓ " : "✕ "}
        {e.text}
      </p>
    );
  }
  if (e.kind === "waiting") return null; // rendered as one box below the list, not a row

  const isErrorResult = e.kind === "tool-result" && /^error/i.test(e.text);
  if (e.kind === "error" || isErrorResult) {
    return <p className="text-[12px] text-danger">{e.text}</p>;
  }

  // tool-call / tool-result — friendly headline, raw payload behind a toggle
  const technical = e.kind === "tool-call" || e.kind === "tool-result";
  return (
    <div className="text-[12px]">
      <button
        type="button"
        onClick={() => technical && setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 text-left text-slate-400 ${
          technical ? "hover:text-slate-200" : "cursor-default"
        }`}
      >
        <span
          className={`h-1 w-1 shrink-0 rounded-full ${e.kind === "tool-call" ? "bg-pending" : "bg-airlock-500"}`}
        />
        <span>
          {e.kind === "tool-call" ? `${friendlyTool(e.tool)}…` : `Done — ${friendlyTool(e.tool).replace(/ing\b/, "")}`}
        </span>
        {technical && (
          <span className="ml-auto shrink-0 text-[10px] text-slate-600">
            {open ? "hide details" : "details"}
          </span>
        )}
      </button>
      {technical && open && (
        <pre className="ml-2.5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-950 px-2 py-1.5 font-mono text-[10.5px] text-slate-500">
          {e.tool ? `tool: ${e.tool}\n` : ""}
          {e.text}
        </pre>
      )}
    </div>
  );
}

export function AssistantTranscript({
  events,
  waiting,
  ready,
  emptyReady,
  emptyNotReady,
  examples,
  onExample,
}: {
  events: TranscriptEvent[];
  waiting: boolean;
  ready: boolean;
  emptyReady: string;
  emptyNotReady: string;
  examples: string[];
  onExample: (prompt: string) => void;
}) {
  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col justify-center gap-4 px-1">
        <p className="text-[13px] leading-relaxed text-slate-500">
          {ready ? emptyReady : emptyNotReady}
        </p>
        {ready && examples.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => onExample(ex)}
                className="rounded-full border border-ink-700 bg-ink-850 px-2.5 py-1 text-[11px] text-slate-300 hover:border-airlock-700/60 hover:bg-airlock-700/10 hover:text-airlock-200"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}
      {waiting && (
        <div className="rounded-md border border-pending/40 bg-pending/5 px-2.5 py-2 text-[12px] leading-relaxed text-pending">
          A change is staged — approve or reject it in the review queue on the
          right. Airlock resumes the moment you do.
        </div>
      )}
    </div>
  );
}
