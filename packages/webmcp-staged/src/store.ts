/**
 * webmcp-staged — proposal store
 *
 * The shared state behind every staged action: pending proposals awaiting the
 * human's decision. Transport-agnostic on purpose — the WebMCP adapter, the
 * authority engine and any custom host adapter all read/write THIS store, so
 * there is exactly one review queue and one source of truth per app.
 */

let proposalCounterFallback = 0;
export function newProposalId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  proposalCounterFallback += 1;
  return `proposal-${Date.now()}-${proposalCounterFallback}`;
}

/** A pending change awaiting human approval. */
export interface Proposal<TInput = Record<string, unknown>> {
  id: string;
  /** The staged tool this proposal belongs to. */
  toolName: string;
  /** Human-readable summary the agent produced (or we synthesized). */
  summary: string;
  /** The validated input the agent supplied. */
  input: TInput;
  /** A structured, UI-renderable preview of what will change. */
  preview: unknown;
  createdAt: number;
  status: "pending" | "approved" | "rejected";
}

export type ProposalListener = (proposals: Proposal[]) => void;

/**
 * Manages the set of pending proposals and notifies UI listeners. One store
 * typically backs an entire app so the review panel can show every pending
 * change across all staged tools.
 */
export class ProposalStore {
  private proposals = new Map<string, Proposal>();
  private listeners = new Set<ProposalListener>();
  /**
   * A referentially-stable snapshot, rebuilt only when the set actually
   * changes. `list()` must be safe to call from React's `useSyncExternalStore`
   * getSnapshot on every render, so it can never return a fresh array.
   */
  private snapshot: Proposal[] = [];

  private rebuild(): void {
    this.snapshot = [...this.proposals.values()].sort(
      (a, b) => a.createdAt - b.createdAt
    );
  }

  list(): Proposal[] {
    return this.snapshot;
  }

  pending(): Proposal[] {
    return this.snapshot.filter((p) => p.status === "pending");
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  add(proposal: Proposal): void {
    this.proposals.set(proposal.id, proposal);
    this.emit();
  }

  setStatus(id: string, status: Proposal["status"]): void {
    const p = this.proposals.get(id);
    if (!p) return;
    // Replace the object so referential-equality consumers see the change.
    this.proposals.set(id, { ...p, status });
    this.emit();
  }

  remove(id: string): void {
    if (this.proposals.delete(id)) this.emit();
  }

  clearResolved(): void {
    let changed = false;
    for (const [id, p] of this.proposals) {
      if (p.status !== "pending") {
        this.proposals.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  subscribe(listener: ProposalListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.rebuild();
    for (const l of this.listeners) l(this.snapshot);
  }
}

/** A default store so simple apps don't have to create one. */
export const defaultProposalStore = new ProposalStore();
