import { useActivity } from "../agent/hooks";
import { activityLog, type ActivityEntry, type ActivityKind } from "../agent/activity";
import { uiStore, useUI } from "../engine/uiStore";
import { downloadText } from "../lib/csv";
import { relativeTime } from "../lib/format";

const KIND_STYLE: Record<ActivityKind, { dot: string; label: string; icon: string }> = {
  read: { dot: "bg-airlock-500", label: "Read", icon: "◌" },
  propose: { dot: "bg-pending", label: "Proposed", icon: "◐" },
  commit: { dot: "bg-commit", label: "Applied", icon: "✓" },
  reject: { dot: "bg-danger", label: "Rejected", icon: "✕" },
  denied: { dot: "bg-danger", label: "Denied", icon: "✕" },
};

export function ActivityLog() {
  const entries = useActivity();
  const ui = useUI();
  const seenCols = activityLog.seenColumns();
  const rows = activityLog.rowsDisclosed();

  return (
    <section className="flex min-h-0 flex-col border-t border-ink-800">
      <button
        className="flex items-center justify-between px-3.5 py-2.5 text-left"
        onClick={() => uiStore.toggleActivity()}
      >
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          Activity
          <span className="text-xs font-normal text-slate-600">{entries.length}</span>
        </span>
        <span className="text-xs text-slate-600">{ui.activityOpen ? "▾" : "▸"}</span>
      </button>

      {ui.activityOpen && (
        <>
          <div className="border-y border-ink-800 bg-ink-950 px-3 py-2 text-[10px] leading-relaxed text-slate-500">
            The agent has received{" "}
            <span className="text-slate-300">{rows.toLocaleString()} rows</span>{" "}
            across{" "}
            <span className="text-slate-300">{seenCols.length} distinct columns</span>.
            Your raw file never left this tab.
            {entries.length > 0 && (
              <button
                className="ml-2 text-airlock-400 hover:underline"
                onClick={() =>
                  downloadText(
                    "airlock-activity.json",
                    activityLog.toJSON(),
                    "application/json"
                  )
                }
              >
                export
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {entries.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-slate-600">
                No tool calls yet.
              </p>
            ) : (
              <div className="relative">
                {/* the timeline spine */}
                <div className="absolute bottom-1 left-[7px] top-1 w-px bg-ink-800" />
                {[...entries].reverse().map((e) => (
                  <ActivityRow key={e.id} e={e} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** One ledger entry, rendered. Exported so citation chips in `lib/markdown`
 *  can show "the exact query + result" for a cited entry id without a second
 *  copy of this markup. `showArgs` adds the call arguments (the SQL query,
 *  expression, column, …) — the ledger panel keeps them collapsed, a citation
 *  expands them. */
export function ActivityRow({
  e,
  showArgs = false,
}: {
  e: ActivityEntry;
  showArgs?: boolean;
}) {
  const s = KIND_STYLE[e.kind];
  const args = showArgs ? argLines(e.args) : [];
  return (
    <div className="relative flex gap-2.5 rounded-md py-1.5 pl-0.5 pr-1.5 hover:bg-ink-850">
      <span
        className={`relative z-10 mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[8px] leading-none text-ink-950 ${s.dot}`}
      >
        {s.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-medium text-slate-200">{s.label}</span>
          <span className="font-mono text-[10px] text-slate-600">{e.tool}</span>
          <span className="ml-auto shrink-0 text-[9px] text-slate-600">{relativeTime(e.ts)}</span>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-slate-500">
          {e.summary}
          {e.returned?.rows !== undefined && (
            <span className="text-slate-600"> · {e.returned.rows} rows returned</span>
          )}
        </p>
        {args.length > 0 && (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-[10px] text-slate-400">
            {args.map(([k, v]) => `${k}: ${v}`).join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Non-empty call arguments as [key, value] pairs, for the expanded view. */
function argLines(args: Record<string, unknown>): [string, string][] {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}
