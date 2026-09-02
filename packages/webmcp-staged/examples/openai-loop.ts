/**
 * Example: OpenAI-compatible tool loop (works with OpenAI, Azure OpenAI,
 * vLLM, Ollama's OpenAI endpoint, LangGraph, OpenAI Agents SDK — anything
 * that speaks Chat Completions tool calls).
 *
 * The gate rule: on a propose_ tool call, STOP the loop and wait for the
 * human. The engine still refuses unapproved commits if the model jumps the
 * gun — the refusal is just wasted tokens you can avoid.
 */
import {
  StagedAuthority,
  toOpenAITools,
  toOpenAICommitTools,
  executeOpenAIToolCall,
  STAGED_AUTHORITY_PROMPT,
  type OpenAIToolCall,
} from "webmcp-staged";

declare function approveInUI(proposalId: string): Promise<void>;

// Your app state stays entirely under your control:
const authority = new StagedAuthority({
  audit: (e) => console.log("[audit]", e),
});
authority.register({
  name: "rename_column",
  description: "Rename a column in the active dataset.",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
  },
  prepare: ({ from, to }) => ({
    summary: `Rename "${String(from)}" -> "${String(to)}"`,
    preview: { from, to },
  }),
  commit: ({ from, to }) => {
    yourApplyRename(String(from), String(to));
    return `Renamed ${String(from)} to ${String(to)}.`;
  },
});
declare function yourApplyRename(from: string, to: string): void;

declare function chatCompletion(body: {
  model: string;
  messages: unknown[];
  tools: unknown[];
}): Promise<{
  choices: {
    message: {
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }[];
}>;

export async function runAgent(goal: string): Promise<string> {
  const messages: unknown[] = [
    { role: "system", content: STAGED_AUTHORITY_PROMPT },
    { role: "user", content: goal },
  ];
  const tools = [...toOpenAITools(authority), ...toOpenAICommitTools(authority)];

  for (let step = 0; step < 12; step++) {
    const res = await chatCompletion({
      model: "gpt-4o-mini",
      messages,
      tools,
    });
    const msg = res.choices[0]!.message;
    messages.push(msg);

    if (!msg.tool_calls?.length) return msg.content ?? "";

    for (const call of msg.tool_calls) {
      messages.push(await executeOpenAIToolCall(authority, call));

      // THE GATE: a propose_ call must stop the loop until the human decides.
      if (call.function.name.startsWith("propose_")) {
        const proposalId = lastStagedProposalId(authority);
        const approved = await approveInUI(proposalId); // YOUR UI decides
        if (approved) authority.store.setStatus(proposalId, "approved");
        else authority.store.setStatus(proposalId, "rejected");
      }
    }
  }
  return "Stopped after 12 steps.";
}

declare function lastStagedProposalId(authority: StagedAuthority): string;
