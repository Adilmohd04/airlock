/**
 * webmcp-staged
 *
 * Register WebMCP tools with staged human approval (propose -> review -> commit).
 * Framework-light core; optional React bindings live in `webmcp-staged/react`.
 */

export {
  getModelContext,
  isWebMCPAvailable,
  registerTool,
  registerStagedTool,
  ProposalStore,
  defaultProposalStore,
} from "./core";

export type {
  Proposal,
  ProposalListener,
  StagedToolConfig,
  RegisterStagedToolResult,
  StagedAudit,
  StagedAuditEvent,
} from "./core";

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
