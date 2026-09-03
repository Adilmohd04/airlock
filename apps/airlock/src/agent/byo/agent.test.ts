/**
 * ByoAgent loop tests — the same gate through the user's own endpoint:
 *   - a read tool runs and its result feeds the next turn
 *   - a propose_* call STOPS the loop; approving resumes it
 *   - commit and reject verbs are withheld from the model and denied in the ledger
 *   - no endpoint configured is an honest error, not a crash
 *
 * Fake model context (same shape as the local tests) + stubbed fetch playing
 * an OpenAI-compatible endpoint. Real `defaultProposalStore` like the local
 * suite, since the approve-resume coupling is the thing under test.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  defaultProposalStore,
  type Proposal,
} from "webmcp-staged";
import { activityLog } from "../activity";
import { ByoAgent } from "./agent";
import { clearEndpoint, configureEndpoint } from "./client";

interface FakeToolInfo {
  name: string;
  description?: string;
  inputSchema?: string;
}

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

interface ScriptedReply {
  content?: string | null;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
}

/** Stub fetch with a queue of OpenAI chat-completion payloads. */
function stubEndpoint(replies: ScriptedReply[]) {
  const queue = [...replies];
  const seen: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(init?.body);
      const next = queue.shift() ?? { content: "done" };
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: next.content ?? null,
                tool_calls: (next.toolCalls ?? []).map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
              finish_reason: (next.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
            },
          ],
        }),
      };
    })
  );
  return seen;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function useEndpoint() {
  configureEndpoint({
    url: "https://byo.example/v1",
    apiKey: "k",
    model: "test-model",
  });
}

afterEach(() => {
  clearEndpoint();
  vi.unstubAllGlobals();
  activityLog.clear();
  for (const p of defaultProposalStore.list()) defaultProposalStore.remove(p.id);
});

describe("ByoAgent loop", () => {
  it("runs a read tool then finishes, feeding the result back", async () => {
    useEndpoint();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: READ_TOOLS,
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "12 rows" }] }),
    });
    stubEndpoint([
      { toolCalls: [{ id: "c1", name: "run_sql", args: { query: "SELECT 1" } }] },
      { content: "Found 12 rows." },
    ]);
    const agent = new ByoAgent(() => mc as never);

    await agent.run("count rows");

    expect(calls).toEqual([{ name: "run_sql", args: { query: "SELECT 1" } }]);
    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "final" && e.text.includes("12 rows"))).toBe(true);
  });

  it("stops at propose_* and resumes when the human approves", async () => {
    useEndpoint();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mc = makeMc({
      tools: [...READ_TOOLS, PROPOSE_TOOL],
      calls,
      onExecute: (name) => {
        if (name === "propose_flag_rows") {
          const staged: Proposal = {
            id: "byo-prop-1",
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
            structuredContent: { proposalId: "byo-prop-1", summary: "flag 3 rows" },
          };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    stubEndpoint([
      { toolCalls: [{ id: "c1", name: "propose_flag_rows", args: { where: "x<1" } }] },
      { content: "Approved, done." },
    ]);
    const agent = new ByoAgent(() => mc as never);

    const runPromise = agent.run("flag underpaid");
    await tick();
    await tick();
    expect(agent.getState().status).toBe("waiting-approval");
    expect(agent.getState().pendingProposalId).toBe("byo-prop-1");

    defaultProposalStore.remove("byo-prop-1");
    await runPromise;
    const st = agent.getState();
    expect(st.status).toBe("done");
    expect(st.events.some((e) => e.kind === "approved")).toBe(true);
    expect(calls.some((c) => c.name.startsWith("commit_"))).toBe(false);
  });

  it("denies a hallucinated commit_* in the ledger and keeps going", async () => {
    useEndpoint();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    // commit_add_filter IS registered (for the human UI) but withheld from
    // the model — exactly the production shape the denial path relies on.
    const mc = makeMc({
      tools: [...READ_TOOLS, { name: "commit_add_filter", description: "commit" }],
      calls,
      onExecute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    stubEndpoint([
      { toolCalls: [{ id: "c1", name: "commit_add_filter", args: { proposalId: "x" } }] },
      { content: "Understood." },
    ]);
    const agent = new ByoAgent(() => mc as never);

    await agent.run("try to commit");

    expect(calls.some((c) => c.name.startsWith("commit_"))).toBe(false);
    expect(
      activityLog.list().filter((e) => e.kind === "denied" && e.tool === "commit_add_filter")
    ).toHaveLength(1);
    expect(agent.getState().status).toBe("done");
  });

  it("errors honestly with no endpoint configured", async () => {
    const mc = makeMc({ tools: READ_TOOLS, calls: [], onExecute: () => ({}) });
    const agent = new ByoAgent(() => mc as never);
    await agent.run("anything");
    expect(agent.getState().status).toBe("error");
  });
});
