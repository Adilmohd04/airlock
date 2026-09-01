import { useState } from "react";
import type { Proposal } from "webmcp-staged";
import { applyProposal, rejectProposal } from "../agent/reviewController";
import { PreviewBody } from "../agent/previews";
import type { ToolPreview } from "../agent/previewTypes";
import { relativeTime } from "../lib/format";

export function ProposalCard({
  proposal,
  primary,
}: {
  proposal: Proposal;
  primary: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      await applyProposal(proposal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const preview = proposal.preview as ToolPreview;

  return (
    <div
      className={`agent-pending animate-slide-in rounded-lg border bg-ink-900 p-3 ${
        primary ? "border-pending/50" : "border-ink-800"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-airlock-700/20 px-1.5 py-0.5 font-mono text-[10px] text-airlock-300">
            ✦ {proposal.toolName}
          </span>
          {primary && (
            <span className="text-[10px] text-pending animate-pending-pulse">
              awaiting you
            </span>
          )}
        </div>
        <span className="text-[10px] text-slate-600">
          {relativeTime(proposal.createdAt)}
        </span>
      </div>

      <p className="mb-2 text-xs text-slate-300">{proposal.summary}</p>

      <div className="mb-3">
        <PreviewBody preview={preview} />
      </div>

      {err && <p className="mb-2 text-[11px] text-danger">{err}</p>}

      {rejecting ? (
        <div className="space-y-2">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="reason (optional)"
            className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-danger/50 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") rejectProposal(proposal, note || undefined);
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-reject flex-1 !py-1 text-xs"
              onClick={() => rejectProposal(proposal, note || undefined)}
            >
              Confirm reject
            </button>
            <button
              className="btn btn-ghost !py-1 text-xs"
              onClick={() => setRejecting(false)}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            className="btn btn-approve flex-1 !py-1 text-xs"
            onClick={approve}
            disabled={busy}
          >
            {busy ? "Applying…" : primary ? "Approve  ⏎" : "Approve"}
          </button>
          <button
            className="btn btn-reject !py-1 text-xs"
            onClick={() => setRejecting(true)}
            disabled={busy}
          >
            Reject{primary ? "  ⌫" : ""}
          </button>
        </div>
      )}
    </div>
  );
}
