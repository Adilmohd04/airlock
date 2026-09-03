/**
 * ByoAgent — drive Airlock's WebMCP tools from the user's own model endpoint.
 *
 * Same contract as the local loop, different brain: read the tool list from
 * `document.modelContext` (the same tools ChatGPT would see), call the user's
 * OpenAI-compatible endpoint with function tools, execute results back through
 * the model context so the ledger, redaction and SQL guards apply unchanged.
 *
 * The gate is identical: the model only ever sees read + propose_* tools.
 * A propose_* call STOPS the loop and waits for the human in the review
 * queue; approval resumes it. commit_/reject_ are withheld AND would be
 * refused — same as every other driver.
 *
 * Privacy, stated once: traffic to the endpoint is external. The egress
 * monitor counts it (normal fetch), so the Seal shows real bytes and Local
 * mode's zero-claims never appear. The key stays in client.ts memory only.
 */

import {
  defaultProposalStore,
  getModelContext,
  STAGED_AUTHORITY_PROMPT,
  type ModelContext,
  type Proposal,
} from "webmcp-staged";
import { activityLog } from "../activity";
import {
  chatCompletions,
  endpointHost,
  endpointModel,
  isEndpointConfigured,
  type ByoChatMessage,
  type ByoFunctionTool,
} from "./client";

/** Minimal shape of a registered tool, as getTools() returns it. */
interface RawTool {
  name: string;
  description?: string;
  inputSchema?: string | Record<string, unknown>;
}

export type ByoRunStatus =
  | "idle"
  | "thinking"
  | "calling-tool"
  | "waiting-approval"
  | "done"
  | "error"
  | "stopped";

export type ByoEventKind =
  | "user"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "waiting"
  | "approved"
  | "rejected"
  | "final"
  | "error"
  | "notice";

export interface ByoEvent {
  id: number;
  kind: ByoEventKind;
  text: string;
  tool?: string;
  proposalId?: string;
  ts: number;
}

export interface ByoRunState {
  status: ByoRunStatus;
  events: ByoEvent[];
  goal: string | null;
  pendingProposalId: string | null;
  step: number;
  stepCap: number;
}

const STEP_CAP = 12;
const STEP_TIMEOUT_MS = 120_000;

type Listener = () => void;

interface PendingApproval {
  proposalId: string;
  seenPending: boolean;
  resolve: (outcome: "approved" | "rejected") => void;
}

function parseSchema(raw: RawTool["inputSchema"]): Record<string, unknown> {
  if (!raw) return { type: "object", properties: {} };
  if (typeof raw === "object") return raw;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* fall through to the empty schema */
  }
  return { type: "object", properties: {} };
}

export class ByoAgent {
  private state: ByoRunState;
  private snapshot: ByoRunState;
  private listeners = new Set<Listener>();
  private eventSeq = 0;
  private runAbort: AbortController | null = null;
  private pending: PendingApproval | null = null;
  private unsubProposals: (() => void) | null = null;

  constructor(
    private mcProvider: () => ModelContext | null = getModelContext
  ) {
    this.state = {
      status: "idle",
      events: [],
      goal: null,
      pendingProposalId: null,
      step: 0,
      stepCap: STEP_CAP,
    };
    this.snapshot = { ...this.state, events: [] };
  }

  getState = (): ByoRunState => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.snapshot = { ...this.state, events: [...this.state.events] };
  }

  private set(patch: Partial<ByoRunState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
    for (const l of this.listeners) l();
  }

  private push(ev: Omit<ByoEvent, "id" | "ts">): void {
    this.state.events.push({ ...ev, id: ++this.eventSeq, ts: Date.now() });
    this.emit();
  }

  get running(): boolean {
    const s = this.state.status;
    return s === "thinking" || s === "calling-tool" || s === "waiting-approval";
  }

  async run(goal: string, opts: { stepCap?: number } = {}): Promise<void> {
    if (this.running) throw new Error("The agent is already working.");
    const mc = this.mcProvider();
    if (!mc || typeof mc.getTools !== "function" || typeof mc.executeTool !== "function") {
      this.reset(goal);
      this.push({ kind: "error", text: "No WebMCP tool surface is available in this page." });
      this.set({ status: "error" });
      return;
    }
    if (!isEndpointConfigured()) {
      this.reset(goal);
      this.push({
        kind: "error",
        text: "No BYO endpoint configured. Add your URL, key and model first — the key stays in this tab's memory only.",
      });
      this.set({ status: "error" });
      return;
    }
    this.reset(goal);
    this.state.stepCap = opts.stepCap ?? STEP_CAP;
    this.runAbort = new AbortController();
    this.watchProposals();
    this.push({ kind: "user", text: goal });
    try {
      await this.loop(mc, goal);
    } catch (err) {
      if (this.state.status !== "stopped") {
        this.push({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
        this.set({ status: "error" });
      }
    } finally {
      this.stopWatchingProposals();
      this.runAbort = null;
    }
  }

  async stop(): Promise<void> {
    this.runAbort?.abort();
    this.pending?.resolve("rejected");
    this.set({ status: "stopped", pendingProposalId: null });
  }

  private reset(goal: string): void {
    this.state = {
      status: "thinking",
      events: [],
      goal,
      pendingProposalId: null,
      step: 0,
      stepCap: STEP_CAP,
    };
    this.pending = null;
    this.emit();
  }

  private async loop(mc: ModelContext, goal: string): Promise<void> {
    const tools = await this.loadTools(mc);
    const host = endpointHost() ?? "your endpoint";
    const system = [
      `You are an analyst working inside the Airlock data workspace on the user's behalf.`,
      `DuckDB table "dataset" holds the active data; use the tools, never guess values.`,
      `After 2-3 reads, ACT: call a propose_* tool. Reading forever is a failure.`,
      `Check comparison direction before proposing: 'below market' means base_salary < market_median.`,
      `If the dataset cannot answer the goal, say so plainly in your final summary.`,
      STAGED_AUTHORITY_PROMPT,
    ].join("\n");
    const functions: ByoFunctionTool[] = tools
      .filter((t) => !t.hidden)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      }));
    const history: ByoChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `Goal: ${goal} (query results go to ${host} — only what tools return)` },
    ];
    const recentSigs: string[] = [];
    let blockedStreak = 0;

    for (let step = 0; step < this.state.stepCap; step++) {
      if (this.aborted) return;
      this.set({ status: "thinking", step: step + 1 });

      let answer: string | null;
      let calls: { id: string; name: string; argumentsText: string }[];
      try {
        const res = await chatCompletions({
          messages: history,
          tools: functions,
          signal: this.runAbort?.signal,
          timeoutMs: STEP_TIMEOUT_MS,
        });
        answer = res.content;
        calls = res.toolCalls;
      } catch (err) {
        if (this.aborted) return;
        this.push({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
        this.set({ status: "error" });
        return;
      }
      if (this.aborted) return;

      if ((!calls || calls.length === 0) && answer) {
        this.push({ kind: "final", text: answer });
        this.set({ status: "done" });
        return;
      }
      const call = calls?.[0];
      if (!call) {
        history.push(
          { role: "assistant", content: answer },
          { role: "user", content: "Call a tool or give your final summary as plain text." }
        );
        continue;
      }

      const toolName = call.name;
      const known = tools.find((t) => t.name === toolName);
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = call.argumentsText ? JSON.parse(call.argumentsText) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        history.push(
          { role: "assistant", content: answer },
          {
            role: "user",
            content: `Your arguments for ${toolName} were not valid JSON. Retry with a JSON object.`,
          }
        );
        continue;
      }
      history.push({
        role: "assistant",
        content: answer,
        tool_calls: [
          { id: call.id, type: "function", function: { name: toolName, arguments: call.argumentsText } },
        ],
      });

      if (!known) {
        this.push({ kind: "tool-call", tool: toolName, text: "unknown tool" });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `There is no tool named "${toolName}". Use only the listed functions.`,
        });
        continue;
      }
      if (toolName.startsWith("commit_") || toolName.startsWith("reject_")) {
        activityLog.add({
          kind: "denied",
          tool: toolName,
          args,
          summary: "Committing is the human's job — the BYO agent cannot call commit_*/reject_* tools.",
        });
        this.push({ kind: "notice", tool: toolName, text: "Committing is the human's job — proposing is enough." });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: "You cannot commit or reject — that is the human's decision. Propose, then continue or summarize.",
        });
        continue;
      }

      // Repeat guard: identical call already answered — block, correct, and
      // fail fast on the third consecutive block.
      const sig = `${toolName}|${stableArgs(args)}`;
      const seen = recentCallsOf(recentSigs, sig);
      if (seen) {
        blockedStreak++;
        this.push({
          kind: "notice",
          tool: toolName,
          text: `Already called ${toolName} — skipping the repeat.`,
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            `You already called ${toolName} with those arguments and its result is above. ` +
            `Do not call it again. The goal is: ${goal}. Act — call a propose_* tool now, or summarize.`,
        });
        if (blockedStreak >= 3) {
          this.push({
            kind: "error",
            text: "Stopping: the same call was repeated after three corrections. Try a narrower goal.",
          });
          this.set({ status: "error" });
          return;
        }
        continue;
      }
      blockedStreak = 0;

      const isPropose = toolName.startsWith("propose_");
      this.set({ status: "calling-tool" });
      this.push({ kind: "tool-call", tool: toolName, text: previewArgs(args) });

      const outcome = await this.execute(mc, known, args);
      if (this.aborted) return;

      if (outcome.error) {
        this.push({ kind: "tool-result", tool: toolName, text: `Error: ${outcome.error}` });
        history.push({ role: "tool", tool_call_id: call.id, content: `Tool ${toolName} failed: ${outcome.error}` });
        continue;
      }
      if (isPropose && outcome.proposalId) {
        const summary = outcome.summary || "change";
        recentSigs.push(sig);
        this.push({
          kind: "waiting",
          tool: toolName,
          proposalId: outcome.proposalId,
          text: `Staged: ${summary}. Waiting for your approval…`,
        });
        this.set({ status: "waiting-approval", pendingProposalId: outcome.proposalId });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Staged proposal ${outcome.proposalId}: ${summary}. Waiting for the human — do nothing until I tell you the decision.`,
        });
        const decision = await this.waitForApproval(outcome.proposalId);
        if (this.aborted) return;
        this.set({ status: "thinking", pendingProposalId: null });
        if (decision === "approved") {
          this.push({ kind: "approved", proposalId: outcome.proposalId, text: `Approved: ${summary}` });
          history.push({
            role: "user",
            content: `The human APPROVED your "${toolName}" proposal and it was applied. Continue with the goal.`,
          });
        } else {
          this.push({ kind: "rejected", proposalId: outcome.proposalId, text: `Rejected: ${summary}` });
          history.push({
            role: "user",
            content: `The human REJECTED your "${toolName}" proposal; it was not applied. Do not re-propose the same thing. Continue or summarize.`,
          });
        }
        continue;
      }

      recentSigs.push(sig);
      if (recentSigs.length > 8) recentSigs.shift();
      const resultText = clipText(outcome.text ?? "(no output)", 1400);
      this.push({ kind: "tool-result", tool: toolName, text: resultText });
      history.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }

    this.push({
      kind: "notice",
      text: `Reached the ${this.state.stepCap}-step limit without finishing. Ask a narrower question or approve pending steps.`,
    });
    this.set({ status: "done" });
  }

  private get aborted(): boolean {
    return this.state.status === "stopped" || !!this.runAbort?.signal.aborted;
  }

  private async loadTools(mc: ModelContext): Promise<
    { name: string; description: string; schema: Record<string, unknown>; info: RawTool; hidden: boolean }[]
  > {
    const raw = (await mc.getTools!()) as RawTool[];
    const out: { name: string; description: string; schema: Record<string, unknown>; info: RawTool; hidden: boolean }[] = [];
    for (const t of raw) {
      if (!t || typeof t.name !== "string") continue;
      // The model only ever SEES read + propose tools — same hiding rule as
      // every other driver. commit_/reject_ stay registered for the UI, and
      // stay addressable here so a hallucinated call is denied in the ledger
      // instead of misreported as "unknown tool".
      const hidden = t.name.startsWith("commit_") || t.name.startsWith("reject_");
      out.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        schema: parseSchema(t.inputSchema),
        info: t,
        hidden,
      });
    }
    return out;
  }

  private async execute(
    mc: ModelContext,
    known: { info: RawTool },
    args: Record<string, unknown>
  ): Promise<{ text?: string; proposalId?: string; summary?: string; error?: string }> {
    try {
      const raw = await mc.executeTool!(known.info as never, JSON.stringify(args), {
        signal: this.runAbort?.signal,
      });
      const result = parseToolResult(raw);
      if (result.isError) return { error: result.text || "tool error" };
      return { text: result.text, proposalId: result.proposalId, summary: result.summary };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private waitForApproval(proposalId: string): Promise<"approved" | "rejected"> {
    return new Promise((resolve) => {
      const existing = defaultProposalStore.get(proposalId);
      if (!existing) {
        resolve("approved");
        return;
      }
      if (existing.status === "rejected") {
        resolve("rejected");
        return;
      }
      this.pending = {
        proposalId,
        seenPending: existing.status === "pending",
        resolve: (outcome) => {
          this.pending = null;
          resolve(outcome);
        },
      };
    });
  }

  private watchProposals(): void {
    this.stopWatchingProposals();
    this.unsubProposals = defaultProposalStore.subscribe((proposals) => {
      const pend = this.pending;
      if (!pend) return;
      const found = proposals.find((p: Proposal) => p.id === pend.proposalId);
      if (found) {
        if (found.status === "rejected") pend.resolve("rejected");
        else if (found.status === "pending") pend.seenPending = true;
        return;
      }
      pend.resolve("approved");
    });
  }

  private stopWatchingProposals(): void {
    this.unsubProposals?.();
    this.unsubProposals = null;
  }
}

/** Mirror of the local loop's result parsing: the polyfill returns a JSON
 * string of the raw tool result (or null); error-ness rides along, never throws. */
function parseToolResult(raw: unknown): {
  text?: string;
  proposalId?: string;
  summary?: string;
  isError?: boolean;
} {
  if (raw == null) return { text: "", isError: false };
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { text: raw, isError: false };
    }
  }
  if (typeof obj !== "object" || obj === null) {
    return { text: String(obj), isError: false };
  }
  const r = obj as {
    content?: { type?: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = Array.isArray(r.content)
    ? r.content
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  const structured =
    r.structuredContent && typeof r.structuredContent === "object"
      ? (r.structuredContent as { proposalId?: unknown; summary?: unknown })
      : {};
  return {
    text,
    proposalId:
      typeof structured.proposalId === "string" ? structured.proposalId : undefined,
    summary: typeof structured.summary === "string" ? structured.summary : undefined,
    isError: r.isError,
  };
}

function stableArgs(args: Record<string, unknown>): string {  const keys = Object.keys(args).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = args[k];
  return JSON.stringify(ordered);
}

function recentCallsOf(recent: string[], sig: string): boolean {
  return recent.slice(-4).includes(sig);
}

function previewArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length <= 160 ? s : `${s.slice(0, 157)}…`;
}

function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(${(s.length - max).toLocaleString()} more chars)`;
}

export const byoAgent = new ByoAgent();

/** Model label for status surfaces, e.g. "gpt-4o-mini · your endpoint". */
export function byoAgentLabel(): string | null {
  const model = endpointModel();
  if (!model) return null;
  return `${model} · your endpoint`;
}
