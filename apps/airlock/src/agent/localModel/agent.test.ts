/**
 * LocalAgent loop tests — the behaviors the Tier-1 acceptance criteria call out:
 *   - a read tool runs and its result feeds the next turn
 *   - a propose_* call STOPS the loop; approving resumes it; rejecting resumes it
 *   - the same proposalId flows through (staged → approved)
 *   - malformed model output is recovered, not fatal, and is capped
 *   - the model cannot commit/reject (those tools are hidden + refused)
 *
 * All pure/injected: a fake model context and a fake LocalModelStore, plus the
 * real `defaultProposalStore` (that is the actual coupling the resume path uses,
 * so we exercise it for real rather than mocking it).
 */

import { afterEach, describe, expect, it } from "vitest";
import { defaultProposalStore, type Proposal } from "webmcp-staged";
import { activityLog } from "../activity";
import { LocalAgent } from "./agent";
import { parseTurn } from "./systemPrompt";
import type {
  LocalChatRequest,
  LocalChatResult,
} from "./runtime";

// ── fakes ────────────────────────────────────────────────────────────────────

/** A model whose turns are scripted. Each call returns the next queued reply. */
class FakeModel {
  private queue: string[];
  seenSystemPrompts: string[] = [];
  constructor(replies: string[]) {
    this.queue = [...replies];
  }
  getState() {
    return { status: "running" as const };
  }
  async chat(req: LocalChatRequest): Promise<LocalChatResult> {
    const sys = req.messages.find((m) => m.role === "system");
    if (sys) this.seenSystemPrompts.push(sys.content);
    const text = this.queue.shift() ?? '{"reasoning":"done","final_answer":"stop"}';
    return { text, finishReason: "stop", elapsedMs: 1 };
  }
  async interrupt(): Promise<void> {}
}

interface FakeToolInfo {
  name: string;
  description?: string;
  inputSchema?: string;
}

/**
 * A model context whose tools are configured per test. `executeTool` returns a
 * JSON string exactly like the polyfill: `JSON.stringify(rawToolResult)`.
 */
function makeMc(opts: {
  tools: FakeToolInfo[];
  onExecute: (name: string, args: Record<string, unknown>) => unknown;
  calls: { name: string; args: Record<string, unknown> }[];
}) {
  return {
    async getTools() {
      return opts.tools;
    },
    async executeTool(tool: unknown, argsJson: string) {
      const name = (tool as FakeToolInfo).name;
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      opts.calls.push({ name, args });
      const raw = opts.onExecute(name, args);
      return raw == null ? null : JSON.stringify(raw);
    },
    registerTool() {},
  };
}

const READ_TOOLS: FakeToolInfo[] = [
  { name: "get_dataset_summary", description: "summary", inputSchema: '{"type":"object"}' },
  { name: "run_sql", description: "sql", inputSchema: '{"type":"object","properties":{"query":{"type":"string"}}}' },
];
const PROPOSE_TOOL: FakeToolInfo = {
  name: "propose_flag_rows",
  description: "flag",
  inputSchema: '{"type":"object"}',
};
const COMMIT_TOOL: FakeToolInfo = { name: "commit_flag_rows", description: "commit" };

/** Wait a tick for microtasks (store subscription resolves the pause). */
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // Clear any proposals a test staged.
  for (const p of defaultProposalStore.list()) defaultProposalStore.remove(p.id);
});

// ── parseTurn (the grammar salvage) ──────────────────────────────────────────

describe("parseTurn", () => {
  it("parses a clean tool turn", () => {
    const t = parseTurn('{"reasoning":"look","tool":"run_sql","arguments":{"query":"SELECT 1"}}');
    expect(t?.tool).toBe("run_sql");
    expect(t?.arguments).toEqual({ query: "SELECT 1" });
  });

  it("parses a final-answer turn", () => {
    const t = parseTurn('{"reasoning":"done","final_answer":"all set"}');
    expect(t?.tool).toBeUndefined();
    expect(t?.finalAnswer).toBe("all set");
  });

  it("salvages a fenced/prose-wrapped object", () => {
    const t = parseTurn('Sure!\n```json\n{"reasoning":"x","tool":"get_dataset_summary"}\n```');
    expect(t?.tool).toBe("get_dataset_summary");
  });

  it("returns null for non-JSON", () => {
    expect(parseTurn("I cannot help with that.")).toBeNull();
  });

  it("treats empty tool string as no tool", () => {
    const t = parseTurn('{"reasoning":"x","tool":"","final_answer":"hi"}');
    expect(t?.tool).toBeUndefined();
    expect(t?.finalAnswer).toBe("hi");
  });

  it("recovers flattened arguments (the #1 small-model mistake)", () => {
    const t = parseTurn(
      '{"reasoning":"filter","tool":"propose_add_filter","expression":"base_salary < 100000","label":"low"}'
    );
    expect(t?.tool).toBe("propose_add_filter");
    expect(t?.arguments).toEqual({
      expression: "base_salary < 100000",
      label: "low",
    });
  });

  it("accepts args/name/reason aliases", () => {
    const t = parseTurn('{"reason":"go","name":"run_sql","args":{"query":"SELECT 1"}}');
    expect(t?.tool).toBe("run_sql");
    expect(t?.arguments).toEqual({ query: "SELECT 1" });
    expect(t?.reasoning).toBe("go");
  });

  it("recovers a stringified arguments object", () => {
    const t = parseTurn(
      '{"reasoning":"x","tool":"run_sql","arguments":"{\\"query\\":\\"SELECT 1\\"}"}'
    );
    expect(t?.arguments).toEqual({ query: "SELECT 1" });
  });

  it("strips a <think> block", () => {
    const t = parseTurn(
      '<think>let me plan</think>{"reasoning":"x","tool":"get_dataset_summary"}'
    );
    expect(t?.tool).toBe("get_dataset_summary");
    expect(t?.arguments).toEqual({});
  });

  it("takes the first object from an array wrapper", () => {
    const t = parseTurn('[{"reasoning":"x","tool":"list_columns"}]');
    expect(t?.tool).toBe("list_columns");
  });

  it("repairs a turn truncated mid-value at the token cap", () => {
    const t = parseTurn(
      '{"reasoning":"summarizing","tool":"get_dataset_summary","arguments":{'
    );
    expect(t?.tool).toBe("get_dataset_summary");
  });

  it("rejects a reasoning-only turn (not actionable)", () => {
    expect(parseTurn('{"reasoning":"I am thinking about it"}')).toBeNull();
  });

  it("defaults arguments to {} for a no-arg tool call", () => {
    const t = parseTurn('{"reasoning":"x","tool":"describe_workspace"}');
    expect(t?.arguments).toEqual({});
  });
});

// ── the loop ─────────────────────────────────────────────────────────────────

describe("LocalAgent loop", () => {
  it("runs a read tool then finishes, feeding the result back", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: READ_TOOLS,
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "12 rows" }] }),
    });
    const model = new FakeModel([
      '{"reasoning":"look","tool":"run_sql","arguments":{"query":"SELECT 1"}}',
      '{"reasoning":"done","final_answer":"Found 12 rows."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("count rows");

    expect(calls).toEqual([{ name: "run_sql", args: { query: "SELECT 1" } }]);
    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "final" && e.text.includes("12 rows"))).toBe(true);
    // The read result was fed back: the model saw a second turn.
    expect(model.seenSystemPrompts.length).toBe(2);
  });

  it("blocks a repeated identical read instead of re-executing it", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: READ_TOOLS,
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "25 rows" }] }),
    });
    const model = new FakeModel([
      '{"reasoning":"look","tool":"run_sql","arguments":{"query":"SELECT * FROM dataset"}}',
      '{"reasoning":"look again","tool":"run_sql","arguments":{"query":"SELECT * FROM dataset"}}',
      '{"reasoning":"and again","tool":"run_sql","arguments":{"query":"SELECT * FROM dataset"}}',
      '{"reasoning":"done","final_answer":"ok"}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("summarize");

    // run_sql executed exactly once; the two identical repeats were blocked.
    expect(calls.filter((c) => c.name === "run_sql")).toHaveLength(1);
    expect(
      agent.getState().events.some(
        (e) => e.kind === "notice" && /Already called run_sql/.test(e.text)
      )
    ).toBe(true);
    expect(agent.getState().status).toBe("done");
  });

  it("stops at a propose_* call and resumes when the human APPROVES", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let staged: Proposal | null = null;
    const mc = makeMc({
      tools: [...READ_TOOLS, PROPOSE_TOOL, COMMIT_TOOL],
      calls,
      onExecute: (name) => {
        if (name === "propose_flag_rows") {
          // Mimic webmcp-staged: add a pending proposal, return its id.
          const id = "prop-approve-1";
          staged = {
            id,
            toolName: "flag_rows",
            summary: "flag 3 rows",
            input: {},
            preview: {},
            createdAt: Date.now(),
            status: "pending",
          };
          defaultProposalStore.add(staged);
          return {
            content: [{ type: "text", text: "staged" }],
            structuredContent: { proposalId: id, summary: "flag 3 rows" },
          };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const model = new FakeModel([
      '{"reasoning":"flag","tool":"propose_flag_rows","arguments":{"where":"x<1","reason":"low"}}',
      '{"reasoning":"done","final_answer":"Flag staged and approved."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    const runPromise = agent.run("flag underpaid");

    // Let the loop reach the propose call and block.
    await tick();
    await tick();
    expect(agent.getState().status).toBe("waiting-approval");
    expect(agent.getState().pendingProposalId).toBe("prop-approve-1");

    // Human approves: the real reviewController removes the proposal on commit.
    // Emulate that terminal transition.
    defaultProposalStore.remove("prop-approve-1");

    await runPromise;
    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "approved")).toBe(true);
    // The model NEVER called commit_* — the agent hides it.
    expect(calls.some((c) => c.name.startsWith("commit_"))).toBe(false);
  });

  it("resumes when the human REJECTS a proposal", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: [...READ_TOOLS, PROPOSE_TOOL],
      calls,
      onExecute: () => {
        const id = "prop-reject-1";
        defaultProposalStore.add({
          id,
          toolName: "flag_rows",
          summary: "flag 3",
          input: {},
          preview: {},
          createdAt: Date.now(),
          status: "pending",
        });
        return {
          content: [{ type: "text", text: "staged" }],
          structuredContent: { proposalId: id, summary: "flag 3" },
        };
      },
    });
    const model = new FakeModel([
      '{"reasoning":"flag","tool":"propose_flag_rows","arguments":{}}',
      '{"reasoning":"ok","final_answer":"Understood, not applied."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);
    const runPromise = agent.run("flag");

    await tick();
    await tick();
    expect(agent.getState().status).toBe("waiting-approval");

    // Reject: status flips to rejected first (what rejectProposal does).
    defaultProposalStore.setStatus("prop-reject-1", "rejected");

    await runPromise;
    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "rejected")).toBe(true);
  });

  it("recovers from malformed output with a corrective retry", async () => {
    const mc = makeMc({
      tools: READ_TOOLS,
      calls: [],
      onExecute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const model = new FakeModel([
      "I am not going to emit JSON, sorry.", // malformed #1
      '{"reasoning":"recovered","final_answer":"Back on track."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("do a thing");

    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "notice" && /JSON/i.test(e.text))).toBe(true);
  });

  it("gives up after too many malformed turns", async () => {
    const mc = makeMc({
      tools: READ_TOOLS,
      calls: [],
      onExecute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    // MAX_MALFORMED_RETRIES tolerates a few (a weak model needs them); feed
    // more than that so the loop gives up rather than spinning.
    const model = new FakeModel([
      "nope",
      "still nope",
      "nope again",
      "and again",
      "one more",
      "and another",
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("do a thing");

    expect(agent.getState().status).toBe("error");
  });

  it("refuses a commit_* tool the model tries to call", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: [...READ_TOOLS, PROPOSE_TOOL, COMMIT_TOOL],
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const model = new FakeModel([
      '{"reasoning":"cheat","tool":"commit_flag_rows","arguments":{"proposalId":"x"}}',
      '{"reasoning":"ok","final_answer":"Fine."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("try to commit");

    // The commit tool was never actually executed.
    expect(calls.some((c) => c.name === "commit_flag_rows")).toBe(false);
    expect(agent.getState().status).toBe("done");
  });

  it("logs a hallucinated commit_*/reject_* attempt to activityLog as denied", async () => {
    // A hallucinated commit call never reaches mc.executeTool (it's
    // intercepted before that), so nothing else would append to the
    // ledger — but attestation.ts's disclosure.denied count reads
    // straight from activityLog, and the same class of denial from a
    // cloud host or the manual console IS logged there.
    activityLog.clear();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: [...READ_TOOLS, PROPOSE_TOOL, COMMIT_TOOL],
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const model = new FakeModel([
      '{"reasoning":"cheat","tool":"commit_flag_rows","arguments":{"proposalId":"x"}}',
      '{"reasoning":"ok","final_answer":"Fine."}',
    ]);
    const agent = new LocalAgent(model as never, () => mc as never);

    await agent.run("try to commit");

    const denied = activityLog.list().filter((e) => e.kind === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].tool).toBe("commit_flag_rows");
    expect(denied[0].args).toEqual({ proposalId: "x" });
    activityLog.clear();
  });

  it("errors cleanly when the model is not loaded", async () => {
    const notRunning = {
      getState: () => ({ status: "ready" as const }),
      async chat() {
        throw new Error("should not be called");
      },
      async interrupt() {},
    };
    const mc = makeMc({ tools: READ_TOOLS, calls: [], onExecute: () => ({}) });
    const agent = new LocalAgent(notRunning as never, () => mc as never);

    await agent.run("anything");

    expect(agent.getState().status).toBe("error");
  });
});
