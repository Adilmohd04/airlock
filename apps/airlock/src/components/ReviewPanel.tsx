import { useEffect } from "react";
import { useProposals } from "webmcp-staged/react";
import { applyProposal, rejectProposal } from "../agent/reviewController";
import { ProposalCard } from "./ProposalCard";

// Elements that already treat Enter/Backspace as "activate me" — the global
// shortcut below must not steal those keystrokes, or tabbing to e.g. "Export"
// and pressing Enter would silently approve a proposal instead.
// A text-editing context owns both keys (Backspace deletes a character,
// Enter may submit). A clickable control (button/link/select/anything
// focusable) only owns Enter — it activates on Enter, but Backspace does
// nothing on it natively, so the reject shortcut must still fire there.
function ownsEnter(t: HTMLElement | null): boolean {
  if (!t || t === document.body) return false;
  if (ownsBackspace(t)) return true;
  if (t.tagName === "BUTTON" || t.tagName === "A" || t.tagName === "SELECT")
    return true;
  return t.closest('[role="button"], [tabindex]') !== null;
}

function ownsBackspace(t: HTMLElement | null): boolean {
  if (!t || t === document.body) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
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
      const target = e.target as HTMLElement;
      if (e.key === "Enter") {
        if (ownsEnter(target)) return;
        e.preventDefault();
        void applyProposal(primary);
      } else if (e.key === "Backspace") {
        if (ownsBackspace(target)) return;
        e.preventDefault();
        rejectProposal(primary);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary]);

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3.5 py-3">
        <p className="text-sm font-semibold text-white">Review queue</p>
        {pending.length > 0 && <span className="badge badge-amber !py-0.5">{pending.length} pending</span>}
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
          <div className="rounded-lg border border-dashed border-ink-800 px-3 py-6 text-center text-xs leading-relaxed text-slate-600">
            Nothing staged yet. When Airlock&apos;s agent wants to change
            something, it appears here first — as a plain-language diff you
            approve or reject. Nothing changes on its own.
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
