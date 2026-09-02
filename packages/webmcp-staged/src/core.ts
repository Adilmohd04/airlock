/**
 * webmcp-staged — WebMCP transport adapter
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
 * The authority contract itself (the gate, the store, the audit events) lives
 * in `./authority` and is transport-agnostic — this file is the WebMCP binding
 * of it. The same contract also ships with adapters for OpenAI-style tool
 * loops (`./openai`) and plain MCP servers (`./mcp`).
 *
 * It is framework-light: the core has zero dependencies and works in vanilla
 * JS. A thin React hook lives in `./react`.
 */

import {
  StagedAuthority,
  commitNameFor,
  proposeNameFor,
  rejectNameFor,
  type StagedAction,
  type StagedAudit,
} from "./authority";
import { defaultProposalStore, ProposalStore, type Proposal } from "./store";
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

// The proposal store and its types are shared with the transport-agnostic
// authority engine; re-exported here so existing imports keep working.
export { ProposalStore, defaultProposalStore } from "./store";
export type { Proposal, ProposalListener } from "./store";
export { StagedAuthority } from "./authority";
export type { StagedAudit, StagedAuditEvent } from "./authority";

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

export interface RegisterStagedToolResult {
  /** Abort to unregister every tool this staged action created. */
  unregister: () => void;
}

/**
 * Register a staged (propose/commit/reject) WebMCP tool trio.
 *
 * The `propose_*` tool is annotated `readOnlyHint: true` because, from the
 * host's perspective, proposing does not change committed application state —
 * it only stages a reviewable change. The `commit_*` tool is a write.
 *
 * The gate itself is enforced by the shared `StagedAuthority` engine: pass
 * `options.authority` to make several registrations (or several transports)
 * share one store and one audit stream. When it is omitted, a fresh engine is
 * created from `options.store` / `options.audit` / `options.requireApproval`.
 */
export function registerStagedTool<TInput extends Record<string, unknown>>(
  config: StagedToolConfig<TInput>,
  options: {
    store?: ProposalStore;
    mc?: ModelContext | null;
    register?: RegisterToolOptions;
    /** Share an existing authority engine (its store/audit settings win). */
    authority?: StagedAuthority;
    /**
     * When true (default), a human must approve before commit succeeds. When
     * false, commit applies immediately — useful for non-sensitive tools that
     * still want the propose/commit shape. Ignored when `authority` is given.
     */
    requireApproval?: boolean;
    /** Called for denied-commit attempts and agent-side rejects (see `StagedAudit`). */
    audit?: StagedAudit;
  } = {}
): RegisterStagedToolResult {
  const mc = options.mc ?? getModelContext();

  if (!mc) {
    // No-op in browsers without WebMCP. The app UI still works.
    return { unregister: () => {} };
  }

  const authority =
    options.authority ??
    new StagedAuthority({
      store: options.store ?? defaultProposalStore,
      audit: options.audit,
      requireApproval: options.requireApproval,
    });

  const action: StagedAction = {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    prepare: (input) => config.prepare(input as TInput),
    commit: (input, proposal) =>
      config.commit(input as TInput, proposal as Proposal<TInput>),
  };
  authority.register(action);

  const proposeMethod = proposeNameFor(config.name);
  const commitMethod = commitNameFor(config.name);
  const rejectMethod = rejectNameFor(config.name);

  const controller = new AbortController();
  const registerOpts: RegisterToolOptions = {
    ...options.register,
    signal: options.register?.signal
      ? anySignal([options.register.signal, controller.signal])
      : controller.signal,
  };

  // 1) propose_<name>
  void mc.registerTool(
    {
      name: proposeMethod,
      title: `Propose: ${config.name}`,
      description:
        `${config.description}\n\n` +
        `This stages the change for human review and returns a proposalId. ` +
        `It does NOT apply the change. Call ${commitMethod} with the proposalId ` +
        `after the user approves it in the UI.`,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: true },
      execute: (input) => {
        const typed = input as TInput;
        return authority.propose(config.name, typed);
      },
    },
    registerOpts
  );

  // 2) commit_<name>
  void mc.registerTool(
    {
      name: commitMethod,
      title: `Commit: ${config.name}`,
      description:
        `Apply a previously proposed "${config.name}" change. ` +
        `Requires a proposalId returned by ${proposeMethod}. ` +
        `Only succeeds if the user has approved the proposal.`,
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "string",
            description: `The id returned by ${proposeMethod}.`,
          },
        },
        required: ["proposalId"],
      },
      annotations: { readOnlyHint: false },
      execute: (input) => {
        const proposalId = String(
          (input as { proposalId?: unknown }).proposalId ?? ""
        );
        return authority.commit(config.name, proposalId);
      },
    },
    registerOpts
  );

  // 3) reject_<name> — lets the agent withdraw a bad proposal it made.
  void mc.registerTool(
    {
      name: rejectMethod,
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
        return authority.reject(config.name, proposalId);
      },
    },
    registerOpts
  );

  return {
    unregister: () => controller.abort(),
  };
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
