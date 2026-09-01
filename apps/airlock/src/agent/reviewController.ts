/**
 * Bridges the human "Approve" button and the agent's `commit_*` tool call to
 * the same underlying commit logic.
 *
 * `webmcp-staged` gates `commit_*` on `proposal.status === "approved"`, but it
 * doesn't expose a way for the UI to *trigger* the commit — the agent is meant
 * to. Airlock wants the human's approval to apply the change immediately (better
 * feel, and it makes the demo work without a live agent), so each staged tool
 * registers its commit function here and the review panel calls it directly.
 *
 * Both entry points converge on the same dataset-store mutation, so there is no
 * "human path vs agent path" divergence to reason about.
 */

import { defaultProposalStore, type Proposal } from "webmcp-staged";
import { activityLog } from "./activity";

type CommitFn = (input: Record<string, unknown>) => Promise<string>;

const registry = new Map<string, CommitFn>();
/** Proposal ids currently being applied — blocks the UI + agent double-apply race. */
const inFlight = new Set<string>();

export function registerCommit(toolName: string, fn: CommitFn): void {
  registry.set(toolName, fn);
}

/**
 * Apply an approved proposal now (called by the review panel's Approve button).
 * The registered commit fn logs its own `commit` / `denied` activity entry.
 *
 * The proposal is removed from the store *before* the await so a concurrent
 * agent `commit_<name>` for the same id can't run the handler twice.
 */
export async function applyProposal(p: Proposal): Promise<string> {
  const fn = registry.get(p.toolName);
  if (!fn) throw new Error(`No commit handler registered for "${p.toolName}".`);
  if (inFlight.has(p.id)) throw new Error("That change is already being applied.");
  inFlight.add(p.id);
  defaultProposalStore.remove(p.id);
  try {
    return await fn(p.input as Record<string, unknown>);
  } catch (e) {
    defaultProposalStore.add({ ...p, status: "pending" }); // restore for retry
    throw e;
  } finally {
    inFlight.delete(p.id);
  }
}

export function rejectProposal(p: Proposal, note?: string): void {
  defaultProposalStore.setStatus(p.id, "rejected");
  activityLog.add({
    kind: "reject",
    tool: `reject_${p.toolName}`,
    args: p.input as Record<string, unknown>,
    summary: note ? `Rejected: ${note}` : "Rejected by the user.",
    proposalId: p.id,
  });
  setTimeout(() => defaultProposalStore.remove(p.id), 400);
}
