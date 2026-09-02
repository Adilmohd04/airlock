/**
 * webmcp-staged — OpenAI-compatible tool-loop adapter
 *
 * Maps a `StagedAuthority` onto the Chat Completions tool-calling shape used
 * by OpenAI, Azure OpenAI, vLLM, Ollama's OpenAI-compatible endpoint, and most
 * agent frameworks (LangGraph, the OpenAI Agents SDK, ...). Zero dependencies:
 * you keep your own loop; this module only produces the tool manifest and
 * executes one tool call at a time.
 *
 * The gate is unchanged from the WebMCP transport: `propose_*` stages and the
 * loop SHOULD STOP and wait for the human to approve in your UI before the
 * model is allowed to call `commit_*`. Pair this adapter with
 * `STAGED_AUTHORITY_PROMPT` in your system prompt.
 */

import { STAGED_AUTHORITY_PROMPT, StagedAuthority } from "./authority";
import type { ToolResult } from "./webmcp-types";

export { STAGED_AUTHORITY_PROMPT };

/** OpenAI Chat Completions "function" tool definition (subset we emit). */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Build the `tools` array for a Chat Completions request. Read tools you
 * register elsewhere can be appended to this array unchanged.
 */
export function toOpenAITools(authority: StagedAuthority): OpenAITool[] {
  return authority.listActions().map((action) => ({
    // Each staged action surfaces its propose_ method; commit_/reject_ are
    // deliberately listed too — the model must be able to NAME them so the
    // protocol (propose, wait, commit-after-approval) is expressible. The
    // authority refuses commits that the human has not approved, so listing
    // commit_ cannot bypass the gate. Hide reject_ from the manifest by
    // filtering the result if you want agent-side withdrawal disabled.
    type: "function" as const,
    function: {
      name: action.methods.propose,
      description:
        `${action.description}\n\n` +
        `This stages the change for human review and returns a proposalId. ` +
        `It does NOT apply the change. Call ${action.methods.commit} with the ` +
        `proposalId after the user approves it in the UI.`,
      parameters: (action.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
    },
  }));
}

/**
 * The commit_/reject_ companion tools, emitted separately so a host can choose
 * to expose propose_ while withholding commit_ (e.g. only after the human has
 * approved something, or never — approving in YOUR UI then being enough).
 */
export function toOpenAICommitTools(authority: StagedAuthority): OpenAITool[] {
  const tools: OpenAITool[] = [];
  for (const action of authority.listActions()) {
    tools.push({
      type: "function",
      function: {
        name: action.methods.commit,
        description:
          `Apply a previously proposed "${action.name}" change. ` +
          `Requires a proposalId returned by ${action.methods.propose}. ` +
          `Only succeeds if the user has approved the proposal.`,
        parameters: {
          type: "object",
          properties: {
            proposalId: {
              type: "string",
              description: `The id returned by ${action.methods.propose}.`,
            },
          },
          required: ["proposalId"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: action.methods.reject,
        description: `Withdraw a pending "${action.name}" proposal by proposalId.`,
        parameters: {
          type: "object",
          properties: { proposalId: { type: "string" } },
          required: ["proposalId"],
        },
      },
    });
  }
  return tools;
}

/** One OpenAI tool call, as it arrives in `delta.tool_calls` / `message.tool_calls`. */
export interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string };
}

/** The `{"role":"tool"}` message to append to the conversation for this call. */
export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

function resultText(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * Execute one OpenAI tool call against the authority and produce the tool
 * message to append. Never throws: malformed arguments, unknown tools and
 * refused commits all come back as tool-message text the model can read and
 * correct (the corrective-retry pattern), instead of crashing the loop.
 */
export async function executeOpenAIToolCall(
  authority: StagedAuthority,
  call: OpenAIToolCall
): Promise<OpenAIToolMessage> {
  const toolCallId = call.id ?? "";
  const deny = (text: string): OpenAIToolMessage => ({
    role: "tool",
    tool_call_id: toolCallId,
    content: text,
  });

  const resolved = authority.resolveMethod(call.function.name);
  if (!resolved) {
    return deny(
      `Unknown tool "${call.function.name}". Available staged tools: ` +
        authority
          .listActions()
          .flatMap((a) => [a.methods.propose, a.methods.commit, a.methods.reject])
          .join(", ") +
        "."
    );
  }

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.function.arguments
      ? JSON.parse(call.function.arguments)
      : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  } catch (e) {
    return deny(
      `Your last call to ${call.function.name} was not valid JSON (${
        e instanceof Error ? e.message : String(e)
      }). Retry with arguments as a JSON object matching the tool's schema.`
    );
  }

  try {
    if (resolved.verb === "propose") {
      const result = await authority.propose(resolved.action.name, args);
      return { role: "tool", tool_call_id: toolCallId, content: resultText(result) };
    }
    const proposalId = String(args.proposalId ?? "");
    const result =
      resolved.verb === "commit"
        ? await authority.commit(resolved.action.name, proposalId)
        : authority.reject(resolved.action.name, proposalId);
    return { role: "tool", tool_call_id: toolCallId, content: resultText(result) };
  } catch (e) {
    return deny(
      `Tool ${call.function.name} failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}
