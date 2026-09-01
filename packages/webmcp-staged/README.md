# webmcp-staged

Register [WebMCP](https://github.com/webmachinelearning/webmcp) tools with staged human approval:

```
propose  ->  human reviews  ->  commit (or reject)
```

WebMCP lets a web page expose tools an AI agent can call directly. For tools
that **mutate state**, you usually do not want the agent to apply changes
silently. `webmcp-staged` gives you the application-side half of a
human-in-the-loop contract: the agent *proposes* a change, your UI renders it
as a pending diff, and nothing is applied until a human approves it.

- **Zero-dependency core.** Works in vanilla JS.
- **Optional React bindings** with lifecycle-managed registration.
- **Feature-detected.** No-ops cleanly in browsers without WebMCP, so your app
  keeps working everywhere.
- **Read/write honest.** The `propose_*` tool is annotated `readOnlyHint: true`
  (it only stages); `commit_*` is a write. Hosts like ChatGPT surface this split.

## Install

```bash
npm install webmcp-staged
```

## Core usage (vanilla)

```ts
import { registerStagedTool, defaultProposalStore } from "webmcp-staged";

registerStagedTool({
  name: "rename_column",
  description: "Rename a column in the active dataset.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
    },
    required: ["from", "to"],
  },
  prepare: ({ from, to }) => ({
    summary: `Rename "${from}" -> "${to}"`,
    preview: { kind: "rename", from, to },
  }),
  commit: ({ from, to }) => {
    applyRename(from as string, to as string); // your app logic
    return `Renamed ${from} to ${to}.`;
  },
});

// Render pending changes for the human to approve:
defaultProposalStore.subscribe((proposals) => renderReviewPanel(proposals));
```

This registers three WebMCP tools: `propose_rename_column`,
`commit_rename_column`, and `reject_rename_column`. `commit_*` refuses to run
until the matching proposal has been approved in your UI.

## React usage

```tsx
import { useStagedTool, useProposals } from "webmcp-staged/react";

function ReviewPanel() {
  const { pending, approve, reject } = useProposals();
  return pending.map((p) => (
    <div key={p.id}>
      {p.summary}
      <button onClick={() => approve(p.id)}>Approve</button>
      <button onClick={() => reject(p.id)}>Reject</button>
    </div>
  ));
}

function useDatasetTools() {
  useStagedTool({
    name: "rename_column",
    description: "Rename a column in the active dataset.",
    inputSchema: { /* ... */ },
    prepare: ({ from, to }) => ({ summary: `Rename ${from} -> ${to}`, preview: { from, to } }),
    commit: ({ from, to }) => renameColumn(from, to),
  });
}
```

Plain, non-staged tools use `registerTool` / `useWebMCPTool`.

## API

- `registerStagedTool(config, options?)` — register a propose/commit/reject trio.
- `registerTool(tool, options?)` — register a single tool with feature detection.
- `ProposalStore` / `defaultProposalStore` — holds pending proposals.
- `isWebMCPAvailable()` / `getModelContext()` — runtime detection.
- React: `useStagedTool`, `useWebMCPTool`, `useProposals`, `useWebMCPAvailable`.

## License

MIT
