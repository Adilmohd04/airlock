/**
 * webmcp-staged — core
 *
 * Register WebMCP tools with an optional "staged approval" gate:
 *
 *     propose  ->  human reviews  ->  commit (or reject)
 *
 * Why this exists
 * ---------------
 * WebMCP lets a page expose tools an agent can call directly. For tools that
 * mutate state, you usually do NOT want the agent to apply changes silently.
 * ChatGPT's in-app browser already asks the user to confirm sensitive actions;
 * this primitive gives you the *application-side* half of that contract: the
 * agent proposes a change, your UI renders it as a pending diff, and nothing is
 * applied until a human clicks approve.
 *
 * It is framework-light: the core has zero dependencies and works in vanilla
 * JS. A thin React hook lives in `./react`.
 */

import type {
  ModelContext,
  RegisterToolOptions,
  ToolResult,
  WebMCPToolDefinition,
} from "./webmcp-types";

/** Runtime feature detection for the WebMCP imperative API. */
export function getModelContext(): ModelContext | null {
  if (typeof document === "undefined") return null;
  const mc = (document as Document).modelContext;
  if (mc && typeof mc.registerTool === "function") return mc;
  return null;
}

/** True when the current browser exposes the WebMCP imperative API. */
export function isWebMCPAvailable(): boolean {
  return getModelContext() !== null;
}

let proposalCounterFallback = 0;
function newProposalId(): string {
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
 * A staged tool splits a mutating action into two WebMCP tools:
 *   - `propose_<name>`  (read-only from the host's perspective; it only stages)
 *   - `commit_<name>`   (applies the most recent / referenced proposal)
 * plus a `reject_<name>` tool so the agent can withdraw a bad proposal.
 */
export interface StagedToolConfig<TInput extends Record<string, unknown>> {
  /** Base name, e.g. "transform". Produces propose_transform / commit_transform. */
  name: string;
  /** What this action does, in model-facing language. */
  description: string;
  inputSchema?: WebMCPToolDefinition["inputSchema"];
  /**
   * Build the preview + summary shown to the human. Pure: must not mutate app
   * state. Throwing here rejects the proposal with the error message.
   */
  prepare: (input: TInput) => {
    summary: string;
    preview: unknown;
  } | Promise<{ summary: string; preview: unknown }>;
  /**
   * Apply the approved change. Only ever called after a human approves.
   * Return a short result string or ToolResult for the agent.
   */
  commit: (
    input: TInput,
    proposal: Proposal<TInput>
  ) => Promise<ToolResult | string | void> | ToolResult | string | void;
}

function asToolResult(value: ToolResult | string | void): ToolResult {
  if (value && typeof value === "object" && "content" in value) {
    return value as ToolResult;
  }
  const text = typeof value === "string" ? value : "Done.";
  return { content: [{ type: "text", text }] };
}

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

export interface RegisterStagedToolResult {
  /** Abort to unregister every tool this staged action created. */
  unregister: () => void;
}

/**
 * Audit events for the paths the host UI never sees: an agent trying to commit
 * an unapproved / rejected / unknown proposal, or the agent withdrawing its own
 * proposal via `reject_<name>`. Wire this into your activity log so those
 * attempts leave a trace.
 */
export type StagedAuditEvent =
  | { type: "denied_commit"; toolName: string; proposalId: string; reason: string }
  | { type: "rejected"; toolName: string; proposalId: string };

export type StagedAudit = (event: StagedAuditEvent) => void;

/**
 * Register a staged (propose/commit/reject) WebMCP tool trio.
 *
 * The `propose_*` tool is annotated `readOnlyHint: true` because, from the
 * host's perspective, proposing does not change committed application state —
 * it only stages a reviewable change. The `commit_*` tool is a write.
 */
export function registerStagedTool<TInput extends Record<string, unknown>>(
  config: StagedToolConfig<TInput>,
  options: {
    store?: ProposalStore;
    mc?: ModelContext | null;
    register?: RegisterToolOptions;
    /**
     * When true (default), a human must approve before commit succeeds. When
     * false, commit applies immediately — useful for non-sensitive tools that
     * still want the propose/commit shape.
     */
    requireApproval?: boolean;
    /** Called for denied-commit attempts and agent-side rejects (see `StagedAudit`). */
    audit?: StagedAudit;
  } = {}
): RegisterStagedToolResult {
  const store = options.store ?? defaultProposalStore;
  const mc = options.mc ?? getModelContext();
  const requireApproval = options.requireApproval ?? true;
  const audit = options.audit;

  if (!mc) {
    // No-op in browsers without WebMCP. The app UI still works.
    return { unregister: () => {} };
  }

  const controller = new AbortController();
  const registerOpts: RegisterToolOptions = {
    ...options.register,
    signal: options.register?.signal
      ? anySignal([options.register.signal, controller.signal])
      : controller.signal,
  };

  const proposeName = `propose_${config.name}`;
  const commitName = `commit_${config.name}`;
  const rejectName = `reject_${config.name}`;

  // 1) propose_<name>
  void mc.registerTool(
    {
      name: proposeName,
      title: `Propose: ${config.name}`,
      description:
        `${config.description}\n\n` +
        `This stages the change for human review and returns a proposalId. ` +
        `It does NOT apply the change. Call ${commitName} with the proposalId ` +
        `after the user approves it in the UI.`,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const typed = input as TInput;
        const { summary, preview } = await config.prepare(typed);
        const proposal: Proposal<TInput> = {
          id: newProposalId(),
          toolName: config.name,
          summary,
          input: typed,
          preview,
          createdAt: Date.now(),
          status: requireApproval ? "pending" : "approved",
        };
        store.add(proposal as Proposal);

        if (!requireApproval) {
          const result = await config.commit(typed, proposal);
          return asToolResult(result);
        }

        return {
          content: [
            {
              type: "text",
              text:
                `Staged proposal ${proposal.id}: ${summary}\n\n` +
                `Awaiting the user's approval in the review panel. ` +
                `Once approved, call ${commitName} with { "proposalId": "${proposal.id}" }.`,
            },
          ],
          structuredContent: { proposalId: proposal.id, summary, preview },
        } satisfies ToolResult;
      },
    },
    registerOpts
  );

  // 2) commit_<name>
  void mc.registerTool(
    {
      name: commitName,
      title: `Commit: ${config.name}`,
      description:
        `Apply a previously proposed "${config.name}" change. ` +
        `Requires a proposalId returned by ${proposeName}. ` +
        `Only succeeds if the user has approved the proposal.`,
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "string",
            description: `The id returned by ${proposeName}.`,
          },
        },
        required: ["proposalId"],
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const proposalId = String(
          (input as { proposalId?: unknown }).proposalId ?? ""
        );
        const deny = (reason: string) => {
          audit?.({ type: "denied_commit", toolName: config.name, proposalId, reason });
          return errorResult(reason);
        };
        const proposal = store.get(proposalId) as Proposal<TInput> | undefined;
        if (!proposal) {
          return deny(`No proposal ${proposalId}. Call ${proposeName} first.`);
        }
        if (proposal.status === "rejected") {
          return deny(`Proposal ${proposalId} was rejected by the user.`);
        }
        if (requireApproval && proposal.status !== "approved") {
          return deny(
            `Proposal ${proposalId} is still pending the user's approval. ` +
              `Ask the user to approve it in the review panel before committing.`
          );
        }
        // Remove first so a concurrent commit (e.g. the UI Approve button
        // running the same handler) can't double-apply during the await.
        store.remove(proposalId);
        try {
          const result = await config.commit(proposal.input, proposal);
          return asToolResult(result);
        } catch (e) {
          store.add(proposal as Proposal); // restore for another attempt
          throw e;
        }
      },
    },
    registerOpts
  );

  // 3) reject_<name> — lets the agent withdraw a bad proposal it made.
  void mc.registerTool(
    {
      name: rejectName,
      title: `Reject: ${config.name}`,
      description: `Withdraw a pending "${config.name}" proposal by proposalId.`,
      inputSchema: {
        type: "object",
        properties: {
          proposalId: { type: "string" },
        },
        required: ["proposalId"],
      },
      annotations: { readOnlyHint: false },
      execute: (input) => {
        const proposalId = String(
          (input as { proposalId?: unknown }).proposalId ?? ""
        );
        if (!store.get(proposalId)) {
          return errorResult(`No proposal ${proposalId}.`);
        }
        store.remove(proposalId);
        audit?.({ type: "rejected", toolName: config.name, proposalId });
        return `Withdrew proposal ${proposalId}.`;
      },
    },
    registerOpts
  );

  return {
    unregister: () => controller.abort(),
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Register a plain (non-staged) WebMCP tool with feature detection. Returns an
 * `unregister` function. A no-op when WebMCP is unavailable.
 */
export function registerTool(
  tool: WebMCPToolDefinition,
  options: { mc?: ModelContext | null; register?: RegisterToolOptions } = {}
): { unregister: () => void } {
  const mc = options.mc ?? getModelContext();
  if (!mc) return { unregister: () => {} };

  const controller = new AbortController();
  const registerOpts: RegisterToolOptions = {
    ...options.register,
    signal: options.register?.signal
      ? anySignal([options.register.signal, controller.signal])
      : controller.signal,
  };
  void mc.registerTool(tool, registerOpts);
  return { unregister: () => controller.abort() };
}

/** Combine multiple AbortSignals into one (aborts when any input aborts). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    for (const s of signals) s.removeEventListener("abort", onAbort);
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", onAbort);
  }
  return controller.signal;
}
