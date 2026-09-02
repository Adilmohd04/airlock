/**
 * webmcp-staged
 *
 * Staged Agent Authority for tool-calling agents: the agent may PROPOSE
 * actions but is structurally incapable of committing them — only the human
 * can — and every refusal is auditable.
 *
 *   propose_<name>  ->  human reviews in YOUR UI  ->  commit_<name> (or reject)
 *
 * One contract, three transports:
 *   - WebMCP pages (browser):            `registerStagedTool` (or ./react hooks)
 *   - OpenAI-compatible tool loops:      `toOpenAITools` + `executeOpenAIToolCall`
 *   - Plain MCP servers (no SDK dep):    `toMcpToolDefinitions` + `callMcpTool`
 *
 * The gate lives in the transport-agnostic `StagedAuthority` engine; every
 * adapter is a thin mapping onto it, so the review UI, the proposal store and
 * the audit stream are shared no matter which host drives the tools.
 */

// ── Core (WebMCP transport + shared re-exports) ──
export {
  getModelContext,
  isWebMCPAvailable,
  registerTool,
  registerStagedTool,
  ProposalStore,
  defaultProposalStore,
  StagedAuthority,
} from "./core";

export type {
  Proposal,
  ProposalListener,
  StagedToolConfig,
  RegisterStagedToolResult,
  StagedAudit,
  StagedAuditEvent,
} from "./core";

// ── Authority engine (transport-agnostic) ──
export {
  proposeNameFor,
  commitNameFor,
  rejectNameFor,
  STAGED_AUTHORITY_PROMPT,
} from "./authority";

export type {
  StagedAction,
  StagedActionInfo,
  StagedAuthorityOptions,
} from "./authority";

// ── OpenAI-compatible tool-loop adapter ──
export {
  toOpenAITools,
  toOpenAICommitTools,
  executeOpenAIToolCall,
} from "./openai";

export type {
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolMessage,
} from "./openai";

// ── Plain MCP server adapter ──
export { toMcpToolDefinitions, callMcpTool } from "./mcp";

export type { McpToolDefinition, McpCallToolResult } from "./mcp";

// ── WebMCP wire types ──
export type {
  JSONSchema,
  ToolAnnotations,
  ToolContentBlock,
  ToolResult,
  ToolExecuteOptions,
  WebMCPToolDefinition,
  RegisterToolOptions,
  ModelContext,
} from "./webmcp-types";
