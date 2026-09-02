/**
 * Example: plain MCP server (Node, @modelcontextprotocol/sdk for the wire —
 * the staged gate itself needs no SDK).
 *
 *   npx tsx examples/mcp-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  StagedAuthority,
  toMcpToolDefinitions,
  callMcpTool,
} from "webmcp-staged";

const authority = new StagedAuthority({
  audit: (e) => console.error("[audit]", e), // stderr: refusals leave a trace
});
authority.register({
  name: "set_flag",
  description: "Flag rows in the dataset where a condition holds.",
  inputSchema: {
    type: "object",
    properties: { condition: { type: "string" }, label: { type: "string" } },
    required: ["condition"],
  },
  prepare: ({ condition, label }) => ({
    summary: `Flag rows where ${String(condition)} (${String(label ?? "flag")})`,
    preview: { condition, label },
  }),
  commit: (input) => {
    // your app logic — only reachable after a human approved
    return `Flagged rows matching ${JSON.stringify(input)}.`;
  },
});

const server = new McpServer({ name: "staged-demo", version: "0.1.0" });

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toMcpToolDefinitions(authority),
}));

server.server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callMcpTool(authority, req.params.name, req.params.arguments)
);

// The human side lives in YOUR client UI: call
//   authority.store.setStatus(proposalId, "approved")
// when the user clicks Approve, then the model's commit_set_flag succeeds.

await server.connect(new StdioServerTransport());
