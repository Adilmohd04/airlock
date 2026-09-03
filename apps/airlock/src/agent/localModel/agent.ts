/**
 * LocalAgent — the fully-local agent loop (T1-b). THE headline.
 *
 * A WebMCP *client* that drives Airlock's own registered tools with an
 * on-device model. It reads the tool list from `document.modelContext` — the
 * exact same tools a cloud host like ChatGPT would see — and runs a
 * tool-calling loop against `localModelStore.chat()`. Nothing here talks to the
 * network; the only network event the model is ever responsible for is the
 * one-time weight download, which happened before this loop can run.
 *
 * ── The loop, precisely ─────────────────────────────────────────────────────
 *   system prompt (role + rules + the tools it may call)
 *   + user goal
 *   → model emits ONE JSON turn (constrained by RESPONSE_SCHEMA)
 *   → if it names a read tool:   execute it, feed the (summarized) result back
 *   → if it names a propose_* tool: execute it to STAGE a diff, then STOP and
 *        wait for the human to approve/reject in ReviewPanel; resume with the
 *        outcome fed back as the next observation
 *   → if it gives final_answer:  done
 *   → repeat until final answer or the step cap (default 12)
 *
 * ── Why it only sees half the tools ─────────────────────────────────────────
 * The model is handed the READ tools and the PROPOSE tools. It is NOT handed
 * `commit_*` / `reject_*`. In Airlock, committing an approved change is a human
 * act (`reviewController.applyProposal`, wired to the Approve button). Giving
 * the model a commit verb would be a write that skips human review — the one
 * thing the product exists to prevent. So a propose_* call is, for the agent,
 * the end of that thread: it stages, then waits for a person.
 *
 * ── Small-model robustness ──────────────────────────────────────────────────
 *  - Output is grammar-constrained to one JSON object (json_object + schema).
 *  - A turn that still fails to parse becomes a corrective observation
 *    ("your last message was not valid JSON…"), capped so a broken model can't
 *    spin forever.
 *  - Each model call carries an AbortSignal with a per-step deadline (the store
 *    has no built-in timeout), plus the run-wide abort from `stop()`.
 *  - The transcript is windowed (the 4096-token context is small): old tool
 *    results are truncated, only the recent turns are replayed verbatim.
 *
 * ── Observable, like the app's other stores ─────────────────────────────────
 * `subscribe` / `getState` return a referentially-stable snapshot so the Agent
 * console binds with `useSyncExternalStore`. The loop reports every step, the
 * "waiting for approval" pause, and the final answer or error.
 */

import { defaultProposalStore, getModelContext, type Proposal } from "webmcp-staged";
import type { ModelContext } from "webmcp-staged";
import { activityLog } from "../activity";
import { localModelStore, type LocalModelStore } from "./store";
import {
  buildSystemPrompt,
  parseTurn,
  RESPONSE_SCHEMA_JSON,
  type PromptTool,
} from "./systemPrompt";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Max model turns per run before we stop and report. */
const DEFAULT_STEP_CAP = 12;
/** Per-turn wall-clock budget. Measured on an Intel gen-12lp iGPU (~5-10 tok/s
 * for a 1.5B q4f16), a full 640-token turn can approach two minutes — the old
 * 90s deadline aborted turns mid-JSON and read as "malformed output". Slow
 * iGPUs are exactly the hardware god mode targets, so the budget assumes them. */
const STEP_DEADLINE_MS = 240_000;
/** How many malformed turns in a row we tolerate before giving up. */
const MAX_MALFORMED_RETRIES = 2;
/** Longest tool-result text we replay verbatim; longer is truncated (context). */
const MAX_RESULT_CHARS = 1400;
/** How many prior turns we replay verbatim before summarizing older ones. */
const RECENT_TURNS_KEPT = 6;

// ── Observable transcript ────────────────────────────────────────────────────

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "calling-tool"
  | "waiting-approval"
  | "done"
  | "error"
  | "stopped";

export type AgentEventKind =
  | "user" // the goal
  | "reasoning" // model's one-line note
  | "tool-call" // a read or propose call was issued
  | "tool-result" // what the tool returned
  | "waiting" // staged a proposal, waiting for the human
  | "approved" // the human approved a staged proposal
  | "rejected" // the human rejected a staged proposal
  | "final" // the model's closing summary
  | "error"
  | "notice"; // loop-level message (retry, step cap, …)

export interface AgentEvent {
  id: number;
  kind: AgentEventKind;
  text: string;
  /** For tool-call / tool-result / waiting: which tool. */
  tool?: string;
  /** For waiting/approved/rejected: the proposal it refers to. */
  proposalId?: string;
  ts: number;
}

export interface AgentRunState {
  status: AgentRunStatus;
  events: AgentEvent[];
  /** The goal currently being worked, or null when idle. */
  goal: string | null;
  /** Set when status is "waiting-approval". */
  pendingProposalId: string | null;
  step: number;
  stepCap: number;
}

type Listener = () => void;

/**
 * A promise that a proposal reaches a terminal state, plus the resolver the
 * store subscription calls. This is how a propose_* call "blocks" the loop
 * without spinning: the loop awaits `promise`, the store watcher resolves it.
 */
interface PendingApproval {
  proposalId: string;
  resolve: (outcome: "approved" | "rejected") => void;
  /** True once we've seen it pending, so a same-tick add isn't misread as gone. */
  seenPending: boolean;
}

export class LocalAgent {
  private state: AgentRunState;
  private snapshot: AgentRunState;
  private listeners = new Set<Listener>();
  private eventSeq = 0;

  /** Abort for the whole run, tripped by `stop()`. */
  private runAbort: AbortController | null = null;
  /** The approval the loop is currently blocked on, if any. */
  private pending: PendingApproval | null = null;
  private unsubProposals: (() => void) | null = null;

  constructor(
    private store: LocalModelStore = localModelStore,
    private mcProvider: () => ModelContext | null = getModelContext
  ) {
    this.state = {
      status: "idle",
      events: [],
      goal: null,
      pendingProposalId: null,
      step: 0,
      stepCap: DEFAULT_STEP_CAP,
    };
    this.snapshot = { ...this.state, events: [] };
  }

  getState = (): AgentRunState => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.snapshot = { ...this.state, events: [...this.state.events] };
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<AgentRunState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private push(ev: Omit<AgentEvent, "id" | "ts">): void {
    this.state.events.push({ ...ev, id: ++this.eventSeq, ts: Date.now() });
    this.emit();
  }

  /** True while a run is active (so the UI can disable the Run button). */
  get running(): boolean {
    const s = this.state.status;
    return s === "thinking" || s === "calling-tool" || s === "waiting-approval";
  }

  /**
   * Run one goal to completion (or step cap / error / stop). Rejects only on a
   * programming error; expected outcomes land in the transcript and status.
   */
  async run(goal: string, opts: { stepCap?: number } = {}): Promise<void> {
    if (this.running) throw new Error("The agent is already working.");
    const mc = this.mcProvider();
    if (!mc || typeof mc.getTools !== "function" || typeof mc.executeTool !== "function") {
      this.reset(goal);
      this.push({ kind: "error", text: "No WebMCP tool surface is available in this page." });
      this.set({ status: "error" });
      return;
    }
    if (this.store.getState().status !== "running") {
      this.reset(goal);
      this.push({
        kind: "error",
        text: "The local model is not loaded. Download and load it first.",
      });
      this.set({ status: "error" });
      return;
    }

    this.reset(goal);
    this.state.stepCap = opts.stepCap ?? DEFAULT_STEP_CAP;
    this.runAbort = new AbortController();
    this.watchProposals();
    this.push({ kind: "user", text: goal });

    try {
      await this.loop(mc, goal);
    } catch (err) {
      if (this.state.status !== "stopped") {
        this.push({ kind: "error", text: messageOf(err) });
        this.set({ status: "error" });
      }
    } finally {
      this.stopWatchingProposals();
      this.runAbort = null;
    }
  }

  /** Interrupt the current run: aborts the model, resolves any pause, stops. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.set({ status: "stopped" });
    this.push({ kind: "notice", text: "Stopped by you." });
    this.runAbort?.abort();
    // Unblock a pending approval wait so the loop can unwind.
    this.pending?.resolve("rejected");
    this.pending = null;
    try {
      await this.store.interrupt();
    } catch {
      /* interrupting a not-generating engine is fine */
    }
  }

  private reset(goal: string): void {
    this.state = {
      status: "thinking",
      events: [],
      goal,
      pendingProposalId: null,
      step: 0,
      stepCap: DEFAULT_STEP_CAP,
    };
    this.pending = null;
    this.emit();
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  private async loop(mc: ModelContext, goal: string): Promise<void> {
    const tools = await this.loadTools(mc);
    const system = buildSystemPrompt(tools.prompt);
    // The running transcript we replay to the model. `system` is prepended
    // fresh each turn; `history` holds the alternating user/assistant turns.
    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: `Goal: ${goal}` },
    ];
    let malformed = 0;

    for (let step = 0; step < this.state.stepCap; step++) {
      if (this.aborted) return;
      this.set({ status: "thinking", step: step + 1 });

      const reply = await this.callModel(system, history);
      if (this.aborted) return;

      const turn = parseTurn(reply);
      if (!turn) {
        malformed++;
        if (malformed > MAX_MALFORMED_RETRIES) {
          this.push({
            kind: "error",
            text: "The model kept returning output I couldn't parse. Stopping.",
          });
          this.set({ status: "error" });
          return;
        }
        this.push({ kind: "notice", text: "Model output wasn't valid JSON — asking it to retry." });
        history.push({ role: "assistant", content: clip(reply, 400) });
        history.push({
          role: "user",
          content:
            'Your last message was not the required JSON object. Reply with exactly one JSON object like {"reasoning":"…","tool":"…","arguments":{…}} or {"reasoning":"…","final_answer":"…"}. Nothing else.',
        });
        continue;
      }
      malformed = 0;
      if (turn.reasoning) this.push({ kind: "reasoning", text: turn.reasoning });

      // Finished?
      if (!turn.tool && turn.finalAnswer) {
        this.push({ kind: "final", text: turn.finalAnswer });
        this.set({ status: "done" });
        return;
      }
      if (!turn.tool) {
        // No tool and no final answer — nudge toward a decision.
        history.push({ role: "assistant", content: reply });
        history.push({
          role: "user",
          content:
            "You called no tool and gave no final_answer. Either call a tool or provide final_answer.",
        });
        continue;
      }

      // The model named a tool. Enforce the read/propose-only surface.
      const toolName = turn.tool;
      const known = tools.byName.get(toolName);
      history.push({ role: "assistant", content: reply });

      if (!known) {
        const hint = this.suggestTool(toolName, tools);
        this.push({ kind: "tool-call", tool: toolName, text: "unknown tool" });
        history.push({
          role: "user",
          content: `There is no tool named "${toolName}".${hint} Choose from the listed tools.`,
        });
        continue;
      }
      if (toolName.startsWith("commit_") || toolName.startsWith("reject_")) {
        // Never reaches mc.executeTool (loadTools already dropped commit_/
        // reject_ from what the model was told about), so nothing would
        // otherwise append to activityLog for this attempt — but the same
        // class of denial from a cloud host or the manual console IS
        // logged, and the attestation receipt's disclosure.denied count
        // reads straight from this ledger. A local-model hallucination that
        // reaches for a commit verb belongs in that count too.
        activityLog.add({
          kind: "denied",
          tool: toolName,
          args: turn.arguments ?? {},
          summary: "Committing is the human's job — the local agent cannot call commit_*/reject_* tools.",
        });
        this.push({ kind: "notice", tool: toolName, text: "Committing is the human's job — proposing instead is enough." });
        history.push({
          role: "user",
          content:
            "You cannot commit or reject — that is the human's decision. Once you have proposed a change, your job on it is done. Continue with the rest of the goal or give your final_answer.",
        });
        continue;
      }

      const isPropose = toolName.startsWith("propose_");
      this.set({ status: "calling-tool" });
      this.push({
        kind: "tool-call",
        tool: toolName,
        text: argsPreview(turn.arguments),
      });

      const outcome = await this.execute(mc, known.info, turn.arguments ?? {});
      if (this.aborted) return;

      if (outcome.error) {
        this.push({ kind: "tool-result", tool: toolName, text: `Error: ${outcome.error}` });
        history.push({ role: "user", content: `Tool ${toolName} failed: ${outcome.error}` });
        continue;
      }

      // A propose_* call: staged a diff. Stop and wait for the human.
      if (isPropose && outcome.proposalId) {
        const summary = outcome.summary || "change";
        this.push({
          kind: "waiting",
          tool: toolName,
          proposalId: outcome.proposalId,
          text: `Staged: ${summary}. Waiting for your approval…`,
        });
        this.set({ status: "waiting-approval", pendingProposalId: outcome.proposalId });

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
            content: `The human REJECTED your "${toolName}" proposal; it was not applied. Do not re-propose the same thing. Continue or finish.`,
          });
        }
        continue;
      }

      // A read tool: feed the (summarized) result back.
      const resultText = clip(outcome.text ?? "(no output)", MAX_RESULT_CHARS);
      this.push({ kind: "tool-result", tool: toolName, text: resultText });
      history.push({ role: "user", content: `Result of ${toolName}:\n${resultText}` });

      this.windowHistory(history);
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

  // ── Model call, with a per-step deadline ─────────────────────────────────────

  private async callModel(
    system: string,
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    const stepAbort = new AbortController();
    const timer = setTimeout(() => stepAbort.abort(), STEP_DEADLINE_MS);
    const signal = anySignal(
      [this.runAbort?.signal, stepAbort.signal].filter(Boolean) as AbortSignal[]
    );
    try {
      const res = await this.store.chat({
        messages: [{ role: "system", content: system }, ...history],
        temperature: 0.2,
        maxTokens: 640,
        format: { type: "json_object", schema: RESPONSE_SCHEMA_JSON },
        signal,
      });
      if (res.finishReason === "abort" && stepAbort.signal.aborted && !this.aborted) {
        // The step timed out (not a user stop). Surface it as a recoverable notice.
        this.push({ kind: "notice", text: "A model step timed out; retrying." });
      }
      return res.text ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Tool loading + execution via the model context ───────────────────────────

  private async loadTools(mc: ModelContext): Promise<{
    prompt: PromptTool[];
    byName: Map<string, { info: RawToolInfo }>;
  }> {
    const raw = (await mc.getTools!()) as RawToolInfo[];
    const byName = new Map<string, { info: RawToolInfo }>();
    const prompt: PromptTool[] = [];
    for (const t of raw) {
      if (!t || typeof t.name !== "string") continue;
      byName.set(t.name, { info: t });
      // The model only ever SEES read + propose tools. commit_/reject_ are still
      // registered (for a real host / the Approve button) but hidden from the
      // model so it cannot try to self-approve.
      if (t.name.startsWith("commit_") || t.name.startsWith("reject_")) continue;
      prompt.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: parseSchema(t.inputSchema),
      });
    }
    return { prompt, byName };
  }

  private async execute(
    mc: ModelContext,
    info: RawToolInfo,
    args: Record<string, unknown>
  ): Promise<{
    text?: string;
    proposalId?: string;
    summary?: string;
    error?: string;
  }> {
    try {
      const raw = await mc.executeTool!(info, JSON.stringify(args), {
        signal: this.runAbort?.signal,
      });
      // The polyfill returns JSON.stringify(rawToolResult) or null.
      const result = parseToolResult(raw);
      if (result.isError) {
        return { error: result.text || "tool error" };
      }
      const proposalId =
        (result.structured?.proposalId as string | undefined) ?? undefined;
      const summary =
        (result.structured?.summary as string | undefined) ?? undefined;
      return { text: result.text, proposalId, summary };
    } catch (err) {
      return { error: messageOf(err) };
    }
  }

  private suggestTool(
    name: string,
    tools: { prompt: PromptTool[] }
  ): string {
    // The single most common small-model mistake: calling `commit_x`/`x` when it
    // meant `propose_x`. Nudge explicitly.
    const guess = tools.prompt.find(
      (t) => t.name === `propose_${name}` || t.name.endsWith(name)
    );
    return guess ? ` Did you mean "${guess.name}"?` : "";
  }

  // ── The approval pause ───────────────────────────────────────────────────────

  /**
   * Resolve when the given proposal reaches a terminal state:
   *   - removed from the store  → the human (or agent commit) applied it → approved
   *   - status === "rejected"   → the human rejected it
   * `reviewController.applyProposal` removes the proposal on commit;
   * `rejectProposal` sets status "rejected" then removes it shortly after. We
   * subscribe to the store and decide on the first terminal transition.
   */
  private waitForApproval(proposalId: string): Promise<"approved" | "rejected"> {
    return new Promise((resolve) => {
      // If it's somehow already gone/rejected, decide immediately.
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
        if (found.status === "rejected") {
          pend.resolve("rejected");
        } else if (found.status === "pending") {
          pend.seenPending = true;
        }
        // "approved" but still present: the commit runs and removes it next tick;
        // wait for the removal so "approved" means "applied".
        return;
      }
      // Gone from the store. If we saw it pending, this is a commit (approved);
      // a reject also removes it, but reject sets status first, which we caught
      // above. So a straight disappearance is an approval+commit.
      pend.resolve("approved");
    });
  }

  private stopWatchingProposals(): void {
    this.unsubProposals?.();
    this.unsubProposals = null;
  }

  // ── Context windowing ────────────────────────────────────────────────────────

  /**
   * Keep the transcript inside the 4096-token window: summarize everything
   * older than the last RECENT_TURNS_KEPT exchanges into one short line, so the
   * model keeps the goal and recent state without replaying every tool dump.
   */
  private windowHistory(
    history: { role: "user" | "assistant"; content: string }[]
  ): void {
    const KEEP = RECENT_TURNS_KEPT * 2; // user+assistant per exchange
    if (history.length <= KEEP + 1) return;
    const head = history[0]; // the goal
    const recent = history.slice(history.length - KEEP);
    const droppedCount = history.length - 1 - recent.length;
    history.length = 0;
    history.push(head);
    history.push({
      role: "user",
      content: `(${droppedCount} earlier steps omitted to save context. Keep pursuing the goal.)`,
    });
    history.push(...recent);
  }
}

// ── Raw shapes coming back across the model-context boundary ──────────────────

interface RawToolInfo {
  name: string;
  description?: string;
  /** JSON-Schema serialized as a string (per the WebMCP getTools() contract). */
  inputSchema?: string;
  title?: string;
}

function parseSchema(s: unknown): unknown {
  if (typeof s !== "string") return s ?? { type: "object" };
  try {
    return JSON.parse(s);
  } catch {
    return { type: "object" };
  }
}

interface ParsedToolResult {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
}

/** Parse the polyfill's `JSON.stringify(rawToolResult)` (or null) into fields. */
function parseToolResult(raw: unknown): ParsedToolResult {
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
      ? (r.structuredContent as Record<string, unknown>)
      : undefined;
  return { text, isError: !!r.isError, structured };
}

// ── small helpers ─────────────────────────────────────────────────────────────

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(${s.length - max} more chars truncated)`;
}

function argsPreview(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "()";
  const s = JSON.stringify(args);
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

/** Combine AbortSignals into one that fires when any input fires. */
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

/** The app-wide agent instance the Agent console binds to. */
export const localAgent = new LocalAgent();
