/**
 * Example: WebMCP page transport.
 *
 * A browser page exposing a staged tool to any WebMCP host (ChatGPT desktop,
 * a WebMCP-capable browser — or Airlock's own local agent). Run this inside
 * your page bundle, not as a standalone script.
 */
import { registerStagedTool, defaultProposalStore } from "webmcp-staged";

declare function applyRename(from: string, to: string): void;
declare function renderReviewPanel(
  proposals: { id: string; summary: string }[]
): void;

registerStagedTool({
  name: "rename_column",
  description: "Rename a column in the active dataset.",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
  },
  prepare: ({ from, to }) => ({
    summary: `Rename "${String(from)}" -> "${String(to)}"`,
    preview: { kind: "rename", from, to },
  }),
  commit: ({ from, to }) => {
    applyRename(String(from), String(to));
    return `Renamed ${String(from)} to ${String(to)}.`;
  },
});

// The human approves in YOUR UI; nothing else can apply the change.
defaultProposalStore.subscribe((proposals) => renderReviewPanel(proposals));
