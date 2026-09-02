/**
 * webmcp-staged — authority engine (transport-agnostic)
 *
 * This is the Staged Agent Authority (SAA) contract, lifted out of the WebMCP
 * transport so the same propose → human review → commit gate works with ANY
 * tool-calling agent host: WebMCP, an OpenAI-compatible tool loop, a plain MCP
 * server, LangGraph, a CLI agent, anything that can invoke a named function
 * with a JSON argument object and read back text.
 *
 * The authority contract (see docs/PROTOCOL.md in the Airlock repo, §2):
 *
 *   1. Reads are disclosed; writes are gated. A mutating action is split into
 *      `propose_<name>` / `commit_<name>` / `reject_<name>`. There is no
 *      single-step write.
 *   2. Commit requires the Principal. `commit_<name>` refuses — and the refusal
 *      is auditable — unless the referenced proposal was approved through a
 *      channel the agent does not control (your UI, backed by the shared
 *      `ProposalStore`).
 *   3. Both paths converge. The human "Approve" button and a programmatic
 *      commit run the SAME underlying mutation — there is no privileged agent
 *      path. This module is that single path.
 *
 * Everything here is pure TypeScript with zero dependencies. Tool results use
 * the MCP content shape (`{ content: [{ type: "text", text }], isError? }`)
 * because every adapter can map it losslessly: WebMCP hosts read it natively,
 * OpenAI tool loops stringify `content`, MCP servers return it as-is.
 *
 * Method naming: the trio is always `propose_<name>` / `commit_<name>` /
 * `reject_<name>` regardless of transport, so a user's review UI, audit log and
 * mental model do not change when the host does.
 */

import { ProposalStore, newProposalId, type Proposal } from "./store";
import type { JSONSchema, ToolResult } from "./webmcp-types";

/** Re-exported for adapter authors. */
export type { Proposal, ProposalListener } from "./store";
export { ProposalStore } from "./store";

/** The shape of one staged action, as the authority engine sees it. */
export interface StagedAction {
  /** Base name, e.g. "transform". Methods are propose_transform / etc. */
  name: string;
  /** What this action does, in model-facing language. */
  description: string;
  /** JSON Schema for the proposal input. */
  inputSchema?: JSONSchema;
  /**
   * Build the preview + summary shown to the human. Pure: must not mutate app
   * state. Throwing here rejects the proposal with the error message.
   */
  prepare: (input: Record<string, unknown>) => {
    summary: string;
    preview: unknown;
  } | Promise<{ summary: string; preview: unknown }>;
  /**
   * Apply the approved change. Only ever called after a human approves.
   * Return a short result string or a ToolResult for the agent.
   */
  commit: (
    input: Record<string, unknown>,
    proposal: Proposal
  ) => Promise<ToolResult | string | void> | ToolResult | string | void;
}

/** Audit events for paths the host UI never sees. */
export type StagedAuditEvent =
  | { type: "denied_commit"; toolName: string; proposalId: string; reason: string }
  | { type: "rejected"; toolName: string; proposalId: string };

export type StagedAudit = (event: StagedAuditEvent) => void;

/** Machine-readable description of one action, for building a host's tool manifest. */
export interface StagedActionInfo {
  name: string;
  description: string;
  inputSchema?: StagedAction["inputSchema"];
  staged: true;
  /** The exact method (tool) names this action answers to. */
  methods: { propose: string; commit: string; reject: string };
}

export interface StagedAuthorityOptions {
  /** Defaults to a fresh internal store. */
  store?: ProposalStore;
  /** Called for denied-commit attempts and agent-side rejects. */
  audit?: StagedAudit;
  /**
   * When true (default), commit requires the human to have approved. When
   * false, propose applies immediately — only for non-sensitive actions that
   * still want the propose/commit shape.
   */
  requireApproval?: boolean;
}

export function proposeNameFor(action: string): string {
  return `propose_${action}`;
}
export function commitNameFor(action: string): string {
  return `commit_${action}`;
}
export function rejectNameFor(action: string): string {
  return `reject_${action}`;
}

function asToolResult(value: ToolResult | string | void): ToolResult {
  if (value && typeof value === "object" && "content" in value) {
    return value as ToolResult;
  }
  const text = typeof value === "string" ? value : "Done.";
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The transport-agnostic authority engine. Owns the proposal store and the
 * registered staged actions; answers exactly three verbs per action.
 *
 * One instance typically backs an entire app, so one review UI covers every
 * staged action and the audit log has a single shape.
 */
export class StagedAuthority {
  readonly store: ProposalStore;
  private readonly actions = new Map<string, StagedAction>();
  private readonly audit?: StagedAudit;
  private readonly requireApproval: boolean;

  constructor(options: StagedAuthorityOptions = {}) {
    this.store = options.store ?? new ProposalStore();
    this.audit = options.audit;
    this.requireApproval = options.requireApproval ?? true;
  }

  /** Register a staged action. Re-registering a name replaces the config. */
  register(action: StagedAction): void {
    this.actions.set(action.name, action);
  }

  /** Remove a staged action (pending proposals are left for the UI to resolve). */
  unregister(name: string): void {
    this.actions.delete(name);
  }

  /** True if `methodName` is one of this authority's tool names. */
  hasMethod(methodName: string): boolean {
    for (const name of this.actions.keys()) {
      if (
        methodName === proposeNameFor(name) ||
        methodName === commitNameFor(name) ||
        methodName === rejectNameFor(name)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Dispatch a method name to the (verb, action) pair it names. */
  resolveMethod(methodName: string):
    | { verb: "propose" | "commit" | "reject"; action: StagedAction }
    | undefined {
    for (const name of this.actions.keys()) {
      if (methodName === proposeNameFor(name)) return { verb: "propose", action: this.actions.get(name)! };
      if (methodName === commitNameFor(name)) return { verb: "commit", action: this.actions.get(name)! };
      if (methodName === rejectNameFor(name)) return { verb: "reject", action: this.actions.get(name)! };
    }
    return undefined;
  }

  /** Machine-readable manifest of every registered action. */
  listActions(): StagedActionInfo[] {
    return [...this.actions.values()].map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: a.inputSchema,
      staged: true,
      methods: {
        propose: proposeNameFor(a.name),
        commit: commitNameFor(a.name),
        reject: rejectNameFor(a.name),
      },
    }));
  }

  /**
   * Stage a proposal for `action`. Does NOT apply anything. The returned text
   * tells the agent to wait for human approval and how to commit afterwards.
   */
  async propose(actionName: string, input: Record<string, unknown>): Promise<ToolResult> {
    const action = this.actions.get(actionName);
    if (!action) {
      return errorResult(`Unknown staged action "${actionName}".`);
    }
    const { summary, preview } = await action.prepare(input);
    const proposal: Proposal = {
      id: newProposalId(),
      toolName: actionName,
      summary,
      input,
      preview,
      createdAt: Date.now(),
      status: this.requireApproval ? "pending" : "approved",
    };
    this.store.add(proposal);

    if (!this.requireApproval) {
      // Auto-apply mode (non-sensitive actions that still want the shape).
      // The proposal stays in the store as "approved" so the UI can show what
      // was applied; clearResolved() reaps it.
      const result = await action.commit(input, proposal);
      return asToolResult(result);
    }

    const commitMethod = commitNameFor(actionName);
    return {
      content: [
        {
          type: "text",
          text:
            `Staged proposal ${proposal.id}: ${summary}\n\n` +
            `Awaiting the user's approval in the review panel. ` +
            `Once approved, call ${commitMethod} with { "proposalId": "${proposal.id}" }.`,
        },
      ],
      structuredContent: { proposalId: proposal.id, summary, preview },
    };
  }

  /**
   * Apply an approved proposal. Refuses — auditable, never throwing — unless
   * the proposal exists, was approved by the Principal, and belongs to the
   * action doing the committing.
   */
  async commit(actionName: string, proposalId: string): Promise<ToolResult> {
    const action = this.actions.get(actionName);
    if (!action) {
      return errorResult(`Unknown staged action "${actionName}".`);
    }
    const deny = (reason: string) => {
      this.audit?.({ type: "denied_commit", toolName: actionName, proposalId, reason });
      return errorResult(reason);
    };
    const proposal = this.store.get(proposalId) as Proposal | undefined;
    if (!proposal) {
      return deny(`No proposal ${proposalId}. Call ${proposeNameFor(actionName)} first.`);
    }
    if (proposal.toolName !== actionName) {
      // A proposal may only be committed by the action that proposed it.
      return deny(
        `Proposal ${proposalId} belongs to "${proposal.toolName}", not "${actionName}".`
      );
    }
    if (proposal.status === "rejected") {
      return deny(`Proposal ${proposalId} was rejected by the user.`);
    }
    if (this.requireApproval && proposal.status !== "approved") {
      return deny(
        `Proposal ${proposalId} is still pending the user's approval. ` +
          `Ask the user to approve it in the review panel before committing.`
      );
    }
    // Remove first so a concurrent commit (e.g. the UI Approve button running
    // the same mutation) can't double-apply during the await.
    this.store.remove(proposalId);
    try {
      const result = await action.commit(proposal.input, proposal);
      return asToolResult(result);
    } catch (e) {
      this.store.add(proposal); // restore for another attempt
      throw e;
    }
  }

  /** Let the agent withdraw its own pending proposal. Auditable. */
  reject(actionName: string, proposalId: string): ToolResult {
    const action = this.actions.get(actionName);
    if (!action) {
      return errorResult(`Unknown staged action "${actionName}".`);
    }
    const proposal = this.store.get(proposalId);
    if (!proposal || proposal.toolName !== actionName) {
      return errorResult(`No proposal ${proposalId}.`);
    }
    this.store.remove(proposalId);
    this.audit?.({ type: "rejected", toolName: actionName, proposalId });
    return { content: [{ type: "text", text: `Withdrew proposal ${proposalId}.` }] };
  }
}

/** A short, model-facing explanation of the gate, for host system prompts. */
export const STAGED_AUTHORITY_PROMPT =
  `Some tools are STAGED: propose_<name> stages a change for human review and ` +
  `does not apply it. After each propose_ call, STOP and ask the user to ` +
  `approve the staged change in the review panel. Only after the user approves ` +
  `may you call commit_<name> with the returned proposalId. If the user rejects ` +
  `or ignores the proposal, do not commit it. Never claim a staged change was ` +
  `applied before its commit_ call succeeded.`;
