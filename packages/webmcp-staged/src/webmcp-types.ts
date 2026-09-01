/**
 * Minimal, spec-aligned type surface for the WebMCP imperative API
 * (`document.modelContext`). WebMCP is a proposed standard and does not ship
 * stable ambient types in browsers yet, so we declare just enough to build
 * against it safely and to feature-detect at runtime.
 *
 * Reference: https://developer.chrome.com/docs/ai/webmcp/imperative-api
 * Reference: https://github.com/webmachinelearning/webmcp
 */

/** A JSON Schema fragment describing a tool's inputs. Kept loose on purpose. */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema | Record<string, unknown>>;
  items?: JSONSchema | Record<string, unknown>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * Tool annotations. `readOnlyHint` is important for WebMCP hosts: ChatGPT's
 * in-app browser surfaces the tool count split by read vs. write, so annotate
 * honestly.
 */
export interface ToolAnnotations {
  /** True when the tool does not mutate application state. */
  readOnlyHint?: boolean;
  /** Hint that returned content may include untrusted / model-facing data. */
  untrustedContentHint?: boolean;
  [key: string]: unknown;
}

/** A single block of structured tool output. */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

/** The structured result shape WebMCP hosts expect back from `execute`. */
export interface ToolResult {
  content: ToolContentBlock[];
  /** Optional machine-readable payload for hosts that support it. */
  structuredContent?: unknown;
  isError?: boolean;
}

/** Options passed to a tool's execute callback by the browser. */
export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

/** A tool definition as accepted by `document.modelContext.registerTool`. */
export interface WebMCPToolDefinition {
  name: string;
  description: string;
  title?: string;
  inputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: ToolExecuteOptions
  ) => Promise<ToolResult | string | void> | ToolResult | string | void;
}

export interface RegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/** The `document.modelContext` surface we rely on. */
export interface ModelContext {
  registerTool: (
    tool: WebMCPToolDefinition,
    options?: RegisterToolOptions
  ) => Promise<unknown> | unknown;
  getTools?: (options?: {
    fromOrigins?: string[];
  }) => Promise<unknown[]>;
  executeTool?: (
    tool: unknown,
    input: string | Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}
