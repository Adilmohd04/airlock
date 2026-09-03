/**
 * webmcp-staged — plain MCP server adapter
 *
 * Maps a `StagedAuthority` onto the Model Context Protocol server shapes
 * (ListTools / CallTool) without depending on `@modelcontextprotocol/sdk` —
 * the two mappers below return plain objects you wire into whichever server
 * SDK you use:
 *
 *   server.setRequestHandler(ListToolsRequestSchema, async () => ({
 *     tools: toMcpToolDefinitions(authority),
 *   }));
 *   server.setRequestHandler(CallToolRequestSchema, async (req) =>
 *     callMcpTool(authority, req.params.name, req.params.arguments)
 *   );
 *
 * The propose → human review → commit gate is identical across transports;
 * see `STAGED_AUTHORITY_PROMPT` (from "webmcp-staged/authority" or the OpenAI
 * adapter) for the model-facing wording of the rule.
 */

import { StagedAuthority } from "./authority";
import type { JSONSchema } from "./webmcp-types";
import type { ToolResult } from "./webmcp-types";

/** MCP `Tool` shape (the subset ListTools needs). */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

/**
 * Every staged method of the authority as MCP tools: propose_ (readOnlyHint —
 * it only stages), commit_ and reject_. Return this from your ListTools
 * handler. The authority still refuses unapproved commits, so exposing
 * commit_ does not weaken the gate; filter it out here instead if you want
 * commit to be reachable only through your own UI code path.
 */
export function toMcpToolDefinitions(authority: StagedAuthority): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  for (const action of authority.listActions()) {
    tools.push({
      name: action.methods.propose,
      description:
        `${action.description}\n\n` +
        `This stages the change for human review and returns a proposalId. ` +
        `It does NOT apply the change. Call ${action.methods.commit} with the ` +
        `proposalId after the user approves it in the UI.`,
      inputSchema: action.inputSchema ?? { type: "object", properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    tools.push({
      name: action.methods.commit,
      description:
        `Apply a previously proposed "${action.name}" change. ` +
        `Requires a proposalId returned by ${action.methods.propose}. ` +
        `Only succeeds if the user has approved the proposal.`,
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "string",
            description: `The id returned by ${action.methods.propose}.`,
          },
        },
        required: ["proposalId"],
      },
      annotations: { readOnlyHint: false },
    });
    tools.push({
      name: action.methods.reject,
      description: `Withdraw a pending "${action.name}" proposal by proposalId.`,
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
      },
      annotations: { readOnlyHint: false },
    });
  }
  return tools;
}

/** MCP CallTool result (text content; `isError` marks a refused/failed call). */
export interface McpCallToolResult {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

function toMcpResult(result: ToolResult): McpCallToolResult {
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return { content: [{ type: "text", text }], ...(result.isError ? { isError: true } : {}) };
}

/**
 * Handle one MCP CallToolRequest for a staged method. `args` is the decoded
 * `params.arguments` object (pass `{}` when absent). Never throws — refusals
 * and malformed input come back as `isError` results the model can read.
 */
export async function callMcpTool(
  authority: StagedAuthority,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<McpCallToolResult> {
  const resolved = authority.resolveMethod(name);
  if (!resolved) {
    return {
      content: [{ type: "text", text: `Unknown tool "${name}".` }],
      isError: true,
    };
  }
  const input = args ?? {};
  try {
    if (resolved.verb === "propose") {
      return toMcpResult(await authority.propose(resolved.action.name, input));
    }
    const proposalId = String(input.proposalId ?? "");
    return toMcpResult(
      resolved.verb === "commit"
        ? await authority.commit(resolved.action.name, proposalId)
        : authority.reject(resolved.action.name, proposalId)
    );
  } catch (e) {
    return {
      content: [
        {
          type: "text",
          text: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      isError: true,
    };
  }
}
