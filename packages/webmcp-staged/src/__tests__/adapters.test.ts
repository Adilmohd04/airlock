/**
 * adapters.test.ts — the same gate through the OpenAI and MCP transports.
 *
 * Every refusal that the authority engine produces must survive the trip
 * through an adapter as text the model can read (or an isError result for
 * MCP), and a happy path (propose -> human approves -> commit) must apply
 * exactly once. The engine itself is pinned in authority.test.ts and the
 * WebMCP binding in commitGate.test.ts; here we pin the WIRING.
 */

import { describe, it, expect } from "vitest";
import { StagedAuthority } from "../authority";
import { registerStagedTool } from "../core";
import {
  toOpenAITools,
  toOpenAICommitTools,
  executeOpenAIToolCall,
  STAGED_AUTHORITY_PROMPT,
  type OpenAIToolCall,
} from "../openai";
import { toMcpToolDefinitions, callMcpTool } from "../mcp";
import { ProposalStore } from "../store";

function makeAuthority(): { authority: StagedAuthority; store: ProposalStore } {
  const store = new ProposalStore();
  const authority = new StagedAuthority({ store });
  authority.register({
    name: "rename_column",
    description: "Rename a column.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
    prepare: ({ from, to }) => ({
      summary: `Rename ${String(from)} -> ${String(to)}`,
      preview: { from, to },
    }),
    commit: ({ from, to }) => `Renamed ${String(from)} to ${String(to)}.`,
  });
  return { authority, store };
}

const PROPOSAL_ARGS = { from: "ssn", to: "tax_id" };

function call(
  name: string,
  args: unknown,
  id = "call_1"
): OpenAIToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("OpenAI adapter", () => {
  it("emits propose_ tools with the action's schema; commit/reject available separately", () => {
    const { authority } = makeAuthority();
    const tools = toOpenAITools(authority);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.function.name).toBe("propose_rename_column");
    expect(tools[0]!.function.parameters).toMatchObject({ type: "object" });

    const commitTools = toOpenAICommitTools(authority);
    expect(commitTools.map((t) => t.function.name)).toEqual([
      "commit_rename_column",
      "reject_rename_column",
    ]);
    expect(commitTools[0]!.function.parameters.required).toEqual(["proposalId"]);
  });

  it("happy path: propose -> approve in the store -> commit applies once", async () => {
    const { authority, store } = makeAuthority();
    const staged = await executeOpenAIToolCall(authority, call("propose_rename_column", PROPOSAL_ARGS));
    expect(staged.role).toBe("tool");
    expect(staged.content).toContain("Awaiting the user's approval");
    const id = /([0-9a-f-]{36})/.exec(staged.content)?.[1] ?? "";
    expect(store.get(id)?.status).toBe("pending");

    // Nothing applied while pending.
    const refused = await executeOpenAIToolCall(authority, call("commit_rename_column", { proposalId: id }, "call_2"));
    expect(refused.content).toContain("pending the user's approval");

    // The human approves through the app UI.
    store.setStatus(id, "approved");
    const applied = await executeOpenAIToolCall(authority, call("commit_rename_column", { proposalId: id }, "call_3"));
    expect(applied.content).toBe("Renamed ssn to tax_id.");
    expect(store.get(id)).toBeUndefined();
  });

  it("malformed JSON arguments come back as corrective text, not a thrown error", async () => {
    const { authority } = makeAuthority();
    const result = await executeOpenAIToolCall(authority, {
      id: "call_bad",
      type: "function",
      function: { name: "propose_rename_column", arguments: "{from: 'ssn'" },
    });
    expect(result.content).toContain("was not valid JSON");
    expect(result.content).toContain("Retry");
  });

  it("non-object JSON arguments are refused with the corrective shape", async () => {
    const { authority } = makeAuthority();
    const result = await executeOpenAIToolCall(authority, {
      id: "call_arr",
      type: "function",
      function: { name: "propose_rename_column", arguments: "[1,2]" },
    });
    expect(result.content).toContain("was not valid JSON");
  });

  it("unknown tools list the available staged methods", async () => {
    const { authority } = makeAuthority();
    const result = await executeOpenAIToolCall(authority, call("rename_column", PROPOSAL_ARGS));
    expect(result.content).toContain('Unknown tool "rename_column"');
    expect(result.content).toContain("propose_rename_column");
  });

  it("the system-prompt hint states the stop-and-wait rule", () => {
    expect(STAGED_AUTHORITY_PROMPT).toContain("STOP");
    expect(STAGED_AUTHORITY_PROMPT).toContain("does not apply it");
  });
});

describe("MCP adapter", () => {
  it("annotations keep the honest read/write split", () => {
    const { authority } = makeAuthority();
    const tools = toMcpToolDefinitions(authority);
    expect(tools.map((t) => t.name)).toEqual([
      "propose_rename_column",
      "commit_rename_column",
      "reject_rename_column",
    ]);
    expect(tools.find((t) => t.name === "propose_rename_column")!.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tools.find((t) => t.name === "commit_rename_column")!.annotations).toEqual({
      readOnlyHint: false,
    });
  });

  it("propose -> commit flow preserves refusal and approval semantics", async () => {    const { authority, store } = makeAuthority();
    const staged = await callMcpTool(authority, "propose_rename_column", PROPOSAL_ARGS);
    expect(staged.isError).toBeUndefined();
    expect(staged.content[0]!.text).toContain("Staged proposal");

    const id = /([0-9a-f-]{36})/.exec(staged.content[0]!.text)?.[1] ?? "";
    const refused = await callMcpTool(authority, "commit_rename_column", { proposalId: id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("pending the user's approval");

    store.setStatus(id, "approved");
    const applied = await callMcpTool(authority, "commit_rename_column", { proposalId: id });
    expect(applied.isError).toBeUndefined();
    expect(applied.content[0]!.text).toBe("Renamed ssn to tax_id.");
  });

  it("unknown tool and missing arguments are isError results", async () => {
    const { authority } = makeAuthority();
    const unknown = await callMcpTool(authority, "nope", {});
    expect(unknown.isError).toBe(true);

    // commit with no proposalId in arguments -> "No proposal ." refusal.
    const noArgs = await callMcpTool(authority, "commit_rename_column", undefined);
    expect(noArgs.isError).toBe(true);
  });
});

describe("registration robustness", () => {
  const CONFIG = {
    name: "rename_column",
    description: "Rename a column.",
    inputSchema: { type: "object", properties: {} },
    prepare: () => ({ summary: "s", preview: {} }),
    commit: () => "done",
  };

  it("tolerates hosts/fakes whose registerTool returns undefined", () => {
    const mc = { registerTool: () => undefined };
    expect(() =>
      registerStagedTool(CONFIG, { mc: mc as never })
    ).not.toThrow();
  });

  it("swallows AbortError rejections (effect-cleanup unregisters)", async () => {
    const mc = {
      registerTool: () =>
        Promise.reject(new DOMException("tool unregistered", "AbortError")),
    };
    expect(() =>
      registerStagedTool(CONFIG, { mc: mc as never })
    ).not.toThrow();
    // Let the tracked rejection settle — an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 10));
  });
});
