# webmcp-staged

**Staged Agent Authority (SAA) for tool-calling agents** — the agent may
*propose* actions, but is *structurally incapable* of committing them. Only the
human can. Every refusal is auditable.

```
propose_<name>  →  human reviews in YOUR UI  →  commit_<name>   (or reject_<name>)
```

One gate, three transports. The enforcement engine is transport-agnostic;
WebMCP, OpenAI-compatible tool loops and plain MCP servers are thin adapters
over it, sharing one review queue, one proposal store and one audit stream.

| Transport | You write | The agent sees |
| --- | --- | --- |
| **WebMCP** (browser page) | `registerStagedTool(config)` | `propose_x` / `commit_x` / `reject_x` tools |
| **OpenAI-compatible loop** | `toOpenAITools(authority)` + `executeOpenAIToolCall(...)` | the same tool names as function tools |
| **Plain MCP server** (no SDK dep) | `toMcpToolDefinitions(authority)` + `callMcpTool(...)` | the same tool names as MCP tools |

## Why

Every "agent acts on my data" product eventually makes two promises: *the agent
won't change things behind your back* and *you'll know what it did*. Both are
usually just settings toggles — assertions a security reviewer cannot check.

This package turns the first promise into **structure**:

- **There is no single-step write tool.** A mutating action is registered as a
  trio; the only path to `commit_x` runs through a proposal that a human
  approved through a channel the agent does not control (your UI).
- **Refusals are loud.** A commit against a pending/rejected/missing/mismatched
  proposal returns an error result *and* emits an audit event, so "the agent
  tried to commit without approval" is a fact in your log, not a guess.
- **Both paths converge.** Your Approve button and any programmatic commit run
  the same mutation through the same engine — no privileged agent path.
- **Application happens at most once.** The proposal is removed before the
  commit runs; a thrown commit restores it; a second commit is a refusal.

The reference implementation of the full protocol (signed session receipts,
egress accounting, disclosure ledger) is [Airlock](https://github.com/Adilmohd04/airlock);
the protocol spec lives at [`docs/PROTOCOL.md`](https://github.com/Adilmohd04/airlock/blob/main/docs/PROTOCOL.md)
("Staged Agent Authority v0.1").

## Install

```bash
npm install webmcp-staged
```

Zero dependencies. ESM + TypeScript types. Node ≥ 18, any modern browser.

## Quickstart — WebMCP page

```ts
import { registerStagedTool, defaultProposalStore } from "webmcp-staged";

registerStagedTool({
  name: "rename_column",
  description: "Rename a column in the active dataset.",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
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

// The human side: render pending proposals, approve/reject in YOUR UI.
defaultProposalStore.subscribe((proposals) => renderReviewPanel(proposals));
```

No WebMCP host present? `registerStagedTool` no-ops and your app keeps working.

## Quickstart — OpenAI-compatible tool loop

```ts
import {
  StagedAuthority, toOpenAITools, executeOpenAIToolCall, STAGED_AUTHORITY_PROMPT,
} from "webmcp-staged";

const authority = new StagedAuthority();
authority.register({ name: "rename_column", /* same config shape as above */ });

// 1. Advertise the tools on your chat request:
const tools = toOpenAITools(authority);        // propose_x functions
//   (optionally: [...tools, ...toOpenAICommitTools(authority)])

// 2. In your tool-call handler:
for (const call of message.tool_calls) {
  conversation.push(await executeOpenAIToolCall(authority, call));
  // A propose_ call means: STOP the loop and wait for the human.
  // STAGED_AUTHORITY_PROMPT (put it in your system prompt) tells the model why.
}

// 3. The human approves in your UI:
authority.store.setStatus(proposalId, "approved");
// 4. Only then does commit_x succeed.
```

The engine, not the model, enforces the gate: if the model calls `commit_x`
early it gets a refusal message it can read. Malformed JSON arguments get a
corrective message instead of a thrown exception, so small local models survive
the loop.

## Quickstart — plain MCP server (no SDK dependency)

```ts
import { StagedAuthority, toMcpToolDefinitions, callMcpTool } from "webmcp-staged";

const authority = new StagedAuthority();
authority.register({ /* ... */ });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toMcpToolDefinitions(authority),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callMcpTool(authority, req.params.name, req.params.arguments)
);
```

## The human side

`ProposalStore` is the single review queue, whatever the transport:

```ts
authority.store.pending()          // proposals awaiting a decision
authority.store.setStatus(id, "approved" | "rejected");
authority.store.subscribe(render); // UI subscription (stable snapshots)
```

React bindings (`webmcp-staged/react`): `useProposals(store)` returns
`{ pending, approve, reject }`; `useStagedTool(config)` registers for a
component's lifetime; `useWebMCPTool` / `useWebMCPAvailable` for plain tools.

## Audit trail

```ts
new StagedAuthority({
  audit: (event) => {
    // { type: "denied_commit", toolName, proposalId, reason } — the agent
    //   tried to commit an unapproved/rejected/missing/mismatched proposal.
    // { type: "rejected", toolName, proposalId } — the agent withdrew its own
    //   proposal.
  },
});
```

Wire this into your activity log: refusals are exactly the events a compliance
reviewer (or you) will want to see.

## API

| Export | What it is |
| --- | --- |
| `StagedAuthority` | The transport-agnostic engine: `register`, `propose`, `commit`, `reject`, `listActions`, `resolveMethod`, `store`. |
| `registerStagedTool(config, options?)` | WebMCP binding. Registers the `propose_/commit_/reject_` trio; no-ops without a WebMCP host. `options.authority` shares one engine across registrations. |
| `registerTool(tool, options?)` | Register a plain (non-staged) WebMCP tool. |
| `ProposalStore` / `defaultProposalStore` | The review queue. |
| `toOpenAITools(authority)` / `toOpenAICommitTools(authority)` | Chat Completions tool manifest (propose; commit/reject separately so you can withhold them). |
| `executeOpenAIToolCall(authority, call)` | Execute one tool call → a `{"role":"tool"}` message. Never throws. |
| `toMcpToolDefinitions(authority)` / `callMcpTool(authority, name, args)` | MCP ListTools/CallTool mappings as plain objects. |
| `STAGED_AUTHORITY_PROMPT` | Model-facing system-prompt text explaining the stop-and-wait rule. |
| `isWebMCPAvailable()` / `getModelContext()` | WebMCP feature detection. |

Types: `Proposal`, `ProposalStore`, `StagedAction`, `StagedActionInfo`,
`StagedToolConfig`, `StagedAudit(Event)`, `OpenAITool(Call|Message)`,
`McpToolDefinition`, `McpCallToolResult`.

## What this package does NOT do

- It is **not a sandbox**. The agent's read tools can still see whatever you
  return to them; disclosure control is your app's job (in Airlock: redaction
  at the SQL-view layer plus an egress monitor and a signed ledger).
- It does not authenticate the human. The Principal is whoever controls the
  browser/machine — the trust root by definition.
- It does not defend against a malicious human, a compromised browser, or
  side channels below the JS layer. Saying so is part of the design (see the
  protocol's threat model).

## Provenance & status

Built as the approval primitive of **Airlock** (OpenAI WebMCP Challenge
entry), generalized in 2026-09 so any agent host can adopt the same contract.
v0.2.0: transport-agnostic engine + OpenAI/MCP adapters; the WebMCP surface is
unchanged from v0.1 and covered by the same property tests. MIT licensed.
**Status:** one production implementation (Airlock); a second independent
implementer would make SAA a protocol in fact, not just in name.

## License

MIT
