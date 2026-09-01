import { useState } from "react";
import { useActivity, useReports } from "../agent/hooks";
import { reportStore } from "../agent/reports";
import { citationStats } from "../agent/citations";
import { Markdown } from "../lib/markdown";
import { downloadText } from "../lib/csv";
import { relativeTime } from "../lib/format";

export function ReportPanel() {
  const reports = useReports();
  const entries = useActivity();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reports.find((r) => r.id === selectedId) ?? reports[0] ?? null;
  const citations = selected ? citationStats(selected.markdown, entries) : null;

  if (reports.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-500">
        <div>
          <p>No insight reports yet.</p>
          <p className="mt-1 text-xs">
            Ask the agent to <span className="font-mono text-airlock-400">write_report</span>{" "}
            after it has explored the data. You approve it before it lands here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-ink-800 p-2">
        {reports.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelectedId(r.id)}
            className={`mb-1 block w-full rounded-md px-2 py-2 text-left text-xs ${
              selected?.id === r.id
                ? "bg-ink-800 text-white"
                : "text-slate-400 hover:bg-ink-850"
            }`}
          >
            <span className="line-clamp-2 font-medium">
              {r.origin === "agent" && <span className="text-airlock-400">✦ </span>}
              {r.title}
            </span>
            <span className="mt-0.5 block text-[10px] text-slate-600">
              {relativeTime(r.createdAt)}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-ink-800 px-6 py-3">
            <h2 className="text-base font-semibold text-white">{selected.title}</h2>
            <div className="flex gap-2">
              <button
                className="btn btn-ghost !py-1 text-xs"
                onClick={() =>
                  downloadText(
                    `${selected.title.replace(/[^\w]+/g, "-").toLowerCase()}.md`,
                    `# ${selected.title}\n\n${selected.markdown}`,
                    "text/markdown;charset=utf-8"
                  )
                }
              >
                Export .md
              </button>
              <button
                className="btn btn-reject !py-1 text-xs"
                onClick={() => reportStore.remove(selected.id)}
              >
                Delete
              </button>
            </div>
          </div>
          {citations && (citations.citedClaims > 0 || citations.uncitedClaims > 0) && (
            <div className="border-b border-ink-800 px-6 py-2 text-[11px] text-slate-500">
              <span className="text-commit">{citations.citedClaims} cited</span>
              {" · "}
              <span className={citations.uncitedClaims > 0 ? "text-pending" : ""}>
                {citations.uncitedClaims} uncited
              </span>
              {citations.brokenCitations > 0 && (
                <>
                  {" · "}
                  <span className="text-danger">
                    {citations.brokenCitations} broken citation
                    {citations.brokenCitations === 1 ? "" : "s"}
                  </span>
                </>
              )}
              <span className="ml-2 text-slate-600">— click a chip to see its query + result</span>
            </div>
          )}
          <div className="mx-auto max-w-2xl px-6 py-6">
            <Markdown source={selected.markdown} />
          </div>
        </div>
      )}
    </div>
  );
}
