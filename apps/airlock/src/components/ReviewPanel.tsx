import { useEffect } from "react";
import { useProposals } from "webmcp-staged/react";
import { applyProposal, rejectProposal } from "../agent/reviewController";
import { ProposalCard } from "./ProposalCard";

// Elements that already treat Enter/Backspace as "activate me" — the global
// shortcut below must not steal those keystrokes, or tabbing to e.g. "Export"
// and pressing Enter would silently approve a proposal instead.
function ownsEnterOrBackspace(t: HTMLElement | null): boolean {
  if (!t || t === document.body) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    return true;
  if (t.tagName === "BUTTON" || t.tagName === "A" || t.tagName === "SELECT")
    return true;
  return t.closest('[role="button"], [tabindex]') !== null;
}

export function ReviewPanel() {
  const { pending } = useProposals();
  const primary = pending[0];

  // Keyboard-first: Enter approves the top proposal, Backspace rejects it —
  // unless focus is on a field or control that already owns that key (see
  // `ownsEnterOrBackspace`). This only fires as a true "no focus target" global
  // hotkey, matching the ⏎ / ⌫ hints shown on the primary card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primary) return;
      if (ownsEnterOrBackspace(e.target as HTMLElement)) return;
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

      {/* `aria-relevant="additions removals"` announces a card entering/leaving
          the queue (staged / approved / rejected) without reading out every
          in-place text change, e.g. a button flipping to "Applying…". */}
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3"
        aria-live="polite"
        aria-relevant="additions removals"
      >
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
