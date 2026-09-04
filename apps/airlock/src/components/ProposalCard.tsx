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
      className={`agent-pending animate-slide-in rounded-xl border bg-ink-850 p-3.5 shadow-lift ${
        primary ? "border-pending/50" : "border-ink-700"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="section-label text-pending">
          {primary ? "Review required" : "Also staged"}
        </span>
        <span className="text-[10px] text-slate-600">{relativeTime(proposal.createdAt)}</span>
      </div>

      <p className="mb-1 text-[13px] leading-snug text-slate-100">{proposal.summary}</p>
      <p className="mb-2.5 font-mono text-[10px] text-slate-600">✦ {proposal.toolName}</p>

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
            className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-danger/50 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") rejectProposal(proposal, note || undefined);
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-reject flex-1 !py-1.5 text-xs"
              onClick={() => rejectProposal(proposal, note || undefined)}
            >
              Confirm reject
            </button>
            <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            className="btn btn-approve flex-1 !py-1.5 text-xs font-semibold"
            onClick={approve}
            disabled={busy}
          >
            {busy ? "Applying…" : primary ? "Approve  ⏎" : "Approve"}
          </button>
          <button
            className="btn btn-reject !py-1.5 text-xs"
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
