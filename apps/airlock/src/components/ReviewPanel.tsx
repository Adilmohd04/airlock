import { useEffect } from "react";
import { useProposals } from "webmcp-staged/react";
import { applyProposal, rejectProposal } from "../agent/reviewController";
import { ProposalCard } from "./ProposalCard";

export function ReviewPanel() {
  const { pending } = useProposals();
  const primary = pending[0];

  // Keyboard-first: Enter approves the top proposal, Backspace rejects it —
  // unless the user is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primary) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      if (e.key === "Enter") {
        e.preventDefault();
        void applyProposal(primary);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        rejectProposal(primary);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary]);

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <p className="panel-title">
          Review queue
          {pending.length > 0 && (
            <span className="ml-1.5 rounded-full bg-pending/20 px-1.5 text-pending">
              {pending.length}
            </span>
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-800 px-3 py-6 text-center text-xs text-slate-600">
            Nothing staged. When the agent proposes a change it appears here as a
            diff for you to approve or reject.
          </div>
        ) : (
          pending.map((p, i) => (
            <ProposalCard key={p.id} proposal={p} primary={i === 0} />
          ))
        )}
      </div>
    </section>
  );
}
