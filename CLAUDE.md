# Airlock — project instructions

**Airlock** is an agent-native data workspace: the agent analyzes private tabular
data that never leaves the browser (DuckDB-WASM, self-hosted, zero network after
load), and **every state-changing agent action is staged as a diff the human
approves**. Entry in OpenAI's **WebMCP Challenge** (Devpost) — submissions close
**Sept 3 2026, 1pm PT**. Judged on: WebMCP Leverage · Execution · Potential
Impact · Creativity & Ambition. Needs a live URL, a <3-min video, and this repo.

## Skills — use these

- **`/graphify`** (superpower) — **use for any question about this codebase**:
  architecture, "what calls X", file relationships, data flow, "where is Y
  handled". `graphify-out/` already exists, so treat such questions as a
  `graphify query "..."` first, before grepping. Rebuild after big changes with
  `/graphify . --update`.
- **`/code-review`** — run before every commit and before the final submission.
  `/code-review high` for the pre-deadline pass.
- **`/simplify`** — after a feature lands, to clean up reuse/altitude/dead code.
- **`humanize-writing`** — for anything published under Sadath's name: the
  Devpost writeup, the README prose, the demo-video script. Not for code.
- **`artifact-design` + `dataviz`** — if producing a visual deliverable (pitch
  page, architecture diagram, results chart).
- **`pptx`** — only if a PowerPoint deck is explicitly requested.

## Architecture

Monorepo, npm workspaces. `npm install` at root installs everything.

```
packages/webmcp-staged/     Reusable primitive: propose_* -> human review -> commit_*.
                            Zero-dep core + React bindings + honest readOnlyHint.
                            MIT, published-shaped. DO NOT rewrite — extend only.
apps/airlock/
  src/engine/               DuckDB-WASM wrapper, per-dataset store (factory),
                            workspace store (dataset list + joins), UI store.
  src/agent/                tools.tsx = the whole WebMCP surface (8 read + 11
                            staged). activity.ts = transparency ledger.
                            reports.ts, reviewController.ts, previews.tsx.
  src/components/           React UI. TopBar/Seal/WebMCPStatus, LeftRail,
                            DataGrid, ChartPanel, ReportPanel, ReviewPanel +
                            ProposalCard, ActivityLog, AgentConsole.
  src/lib/                  egress monitor, csv, markdown (sanitized), format.
  public/demo/              bundled HR-compensation demo CSVs (client-side only).
```

Full build plan (phases, verification, open risks):
`C:\Users\Ashi\.claude\plans\parallel-mixing-dusk.md`.

## Non-negotiable conventions

- **The base table is immutable.** Filters, derived columns and renames are
  view-level (`buildViewSql`). `run_sql` is guarded SELECT-only (`assertSelectOnly`).
- **Read vs write split is honest.** Read tools = `registerTool` +
  `readOnlyHint: true`, run immediately. Write tools = `registerStagedTool`,
  human-gated. Never let a write tool skip the review queue.
- **Egress stays at zero.** No CDN fetches, no analytics, no telemetry. The
  egress monitor (`lib/egress.ts`) is installed first in `main.tsx` and the Seal
  indicator shows its count. Self-host any asset.
- **The polyfill must never shadow a native host.** `main.tsx` only initializes
  `@mcp-b/webmcp-polyfill` when `document.modelContext` is absent.
- **Human and agent mutate the same stores** — a filter the agent adds is
  identical to one the human clicked (same grid, same undo).
- Every tool call (read, propose, commit, reject, denied) appends to
  `activityLog`.

## Commands

```bash
npm install                 # root — all workspaces
npm run dev                  # airlock dev server (localhost:5173)
npm run build                # builds webmcp-staged then airlock
npm run typecheck --workspace apps/airlock
```

Local WebMCP testing without ChatGPT: `chrome://flags/#enable-webmcp-testing` +
the WebMCP Inspector extension, or the built-in **Agent console**
(Ctrl/Cmd + `` ` ``) which invokes registered tools by hand.

## Style

TypeScript strict. Match the existing engine files' comment density — short
"why" comments, not "what". Tailwind with the semantic tokens in
`tailwind.config.js` (`pending` amber = awaiting approval, `commit` green =
applied, `danger` red = reject). Dark, monospace for data. No accent stripes.
