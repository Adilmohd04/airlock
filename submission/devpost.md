# Airlock: Agent-Native Data Workspace

**Tagline:** Analyze private data with AI, never leave your browser. Human and agent mutate the same workspace; every state change stages for approval.

---

## Inspiration

Teams with sensitive tabular data—HR compensation, medical records, financial statements—face a trust boundary: they can't paste it into ChatGPT or Claude to ask for analysis, so they either:

1. Do the work manually (slow, repetitive).
2. Hire analysts (expensive).
3. Build custom dashboards (inflexible, doesn't scale to new questions).

Meanwhile, foundation models are *good* at data analysis: they understand SQL, they ask clarifying questions, they recognize patterns. But the data never leaves the building.

**Airlock solves this by inverting the constraint.** Instead of shipping data to an AI, we keep the data on the user's machine and ship a lightweight agent-native workspace. The agent analyzes the data in-browser via WebMCP tools; the human approves every mutation. The data never leaves. The agent's reasoning is auditable. Trust is rebuilt.

---

## What It Does

**Airlock is a three-column React workspace:**

- **Left rail:** Dataset switcher, column list with mini-profiles (type, null %, distinct count).
- **Center:** Tabbed interface — *Grid* (the current view, with filters and derived columns applied), *Charts* (bar/line visualizations), *Report* (agent-authored findings).
- **Right rail:** *Review panel* (pending proposals from the agent, typed diff previews) above an *Activity log* (every tool call, full audit trail).

**The agent can:**
- **Read** (8 tools) — list datasets, profile columns, run SELECT-only SQL, preview rows, describe the current workspace state, and access the activity ledger. All execute immediately, marked `readOnlyHint: true`.
- **Propose mutations** (11 tools) — add/remove filters, add derived columns (e.g., `comp_ratio = base_salary / market_median`), rename columns, add charts, flag rows, join datasets, export to CSV, or write insight reports. Each proposal stages a typed diff in the review panel. The agent cannot mutate state without human approval.

**The human can:**
- Click to add filters, derived columns, charts, or renames directly—same UI, same store as the agent.
- Review and approve/reject each agent proposal via the review panel (keyboard shortcuts: ⏎ approve, ⌫ reject).
- See a live "Seal" indicator in the top bar showing "0 bytes sent"—proof that no data left the browser post-load.
- Export the transformed view (with all filters and derived columns baked in) as a CSV.

**The key insight:** the human and agent mutate the exact same stores. A filter the agent proposes, once approved, is indistinguishable from one the human clicked. Undo is shared. Charts are shared. This is not a separate "agent mode"—it's a unified data workspace.

### Beyond the demo: the four things that make it a tool, not a toy

Staged approval is the mechanism. These are what make someone open it a second time.

- **Named sessions.** Close the tab and come back tomorrow — datasets, filters, derived columns, charts, reports and the full activity ledger are still there. Sessions live in IndexedDB; the original file bytes are stored locally and the DuckDB table is rebuilt through the same import path it first used, so a restore is deterministic by construction. Still zero network.
- **Recipes.** An analyst runs the same compensation review every quarter. Export the approved transform sequence as versioned, diff-able JSON; load next quarter's file; replay in one click. Critically, **replay stages proposals rather than applying them** — a recipe is not a licence to mutate silently. Steps referencing a column the new file lacks are reported and skipped, never silently dropped.
- **Cited claims.** When an agent report says "engineering is paid 8% below market", that claim carries a `[cite:…]` marker resolving to the exact ledger entry — query, arguments, result — that produced it. Click it and the evidence opens inline. Broken or unbacked citations render visibly broken and are logged. The approval card shows **cited vs. uncited claim counts before you approve**, so you judge the evidence, not the prose. This is the anti-hallucination surface.
- **Per-column redaction.** Mark `name` or `ssn` redacted and the agent cannot read those values through any path — not `preview_rows`, not `run_sql`, not an aliased expression or a derived column. Profiles return shape only. Every blocked attempt is logged, so the ledger proves the agent tried. A PII heuristic flags likely-sensitive columns on load as *suggestions* — never auto-redacting, never claiming to be exhaustive. This is what turns the privacy claim from architectural into enforceable.

---

## How We Built It

### Architecture

**Monorepo** (npm workspaces):
- `packages/webmcp-staged/` — a reusable, zero-dependency primitive (`propose_* → human review → commit_*`). Registered tools declare `readOnlyHint: true` (read tools) or `registerStagedTool` (staged writes). Human actions (approve/reject) and agent actions (commit/deny) land in the same queue. MIT-licensed, published-shaped.
- `apps/airlock/` — the application layer.
  - `src/engine/` — DuckDB-WASM (in-browser SQL engine), three observable stores:
    - `datasetStore` — per-dataset state (columns, filters, derived, charts, profiles, renames).
    - `workspaceStore` — workspace-level (dataset list, active dataset, activity log).
    - `uiStore` — UI state (active tab, focused column).
  - `src/agent/tools.tsx` — **all 19 WebMCP registrations** (8 read + 11 staged). Each read tool wraps its logic in a `read()` helper that executes and appends to the activity ledger. Each write tool defines a `prepare()` (builds typed preview, runs read-only queries) and `commit()` (mutates the store, appends to ledger).
  - `src/agent/activity.ts` — activity log store: every tool call (read, propose, commit, reject, denied) with args, summary, timestamp, and origin (`agent` vs. `human`).
  - `src/agent/reports.ts` — stores agent-authored insight reports (markdown), keyed by ID.
  - `src/components/` — React UI: `TopBar`, `SealStatus` (egress counter), `LeftRail`, `ColumnList`, `DataGrid` (virtualized), `ChartPanel` (Recharts), `ReportPanel` (sanitized markdown render), `ReviewPanel` (pending proposals), `ProposalCard` (typed diff previews), `ActivityLog`.
  - `src/lib/` — utilities: `egress.ts` (wraps fetch/XHR to count bytes post-load), `csv.ts` (rows → CSV), `markdown.tsx` (safe markdown render via `marked` + `DOMPurify`), `format.ts` (number/date/bytes formatting).
  - `public/demo/` — bundled demo CSVs (HR compensation, headcount) — no external data sources.

### Tech Stack

- **React 18** + TypeScript strict.
- **TanStack Table** (virtualized grid).
- **Recharts** (bar/line charts).
- **Tailwind CSS** with semantic color tokens (`pending` amber for proposals, `commit` green for applied, `danger` red for reject).
- **@duckdb/duckdb-wasm** — WASM SQL engine, self-hosted bundle.
- **@mcp-b/webmcp-polyfill** — WebMCP in local dev (Vite dev server); native WebMCP in ChatGPT/Chrome with WebMCP enabled.
- **marked + DOMPurify** — safe markdown rendering (agent-authored reports).
- `useSyncExternalStore` pattern for all state (matching the engine's design).

### Design Principles

**Honest split.** Read tools = `registerTool` + `readOnlyHint: true`, auto-execute. Write tools = `registerStagedTool`, human-gated via typed proposals. Hosts like ChatGPT can surface this distinction to the user.

**Data immutability.** The base table is never modified. Filters, derived columns, and renames are view-level transformations (`buildViewSql` constructs a CTE that applies all transforms). You can verify with `run_sql("SELECT * FROM dataset LIMIT 1")` that the underlying data is unchanged.

**Zero egress.** After initial load (the bundled WASM runtime and demo CSVs), *nothing* leaves the browser. The `SealStatus` component shows a live egress counter (via `egress.ts`, which wraps fetch and XHR). Verified: 0 bytes sent in all normal flows.

**Unified mutation.** Agent and human mutate the same stores via the same `datasetStore` methods. No separate agent view, no shadowing—the UI is the source of truth for workspace state.

**Audit trail.** Every tool call (read, propose, commit, reject, denied) appends to `activityLog` with args, result summary, timestamp, and origin. This is the transparency payoff—you can see exactly what the agent queried and what it saw.

---

## Challenges

1. **DuckDB-WASM bundle size and cold start.** The WASM runtime (~10MB gzipped) and initialization add latency. Mitigation: self-host the bundle (avoid CDN cold starts), add a loading state, use DuckDB's streaming import for large CSVs.

2. **Privacy claim precision.** "Data never leaves the browser" is almost true, but read-tool results *are* returned to the agent (as JSON in the tool response). We address this head-on:
   - Every query and its result are logged in the activity ledger.
   - The `get_activity_log` tool lets you ask "what has the agent seen?"
   - The "Seal" indicator shows 0 bytes egress—raw bytes never leave.
   - Marketing copy is precise: "your raw bytes never leave your browser; tool results are shown in the audit log."

3. **Three-day deadline, full-stack scope.** Phase 1 (human-only workspace, no agent yet), Phase 2 (WebMCP layer + review panel), Phase 3 (multi-dataset joins, report writing). Built a staged checkpoint system to ensure Phase 2 is always shippable, with Phase 3 as upside.

4. **Staging area state consistency.** The `webmcp-staged` primitive's proposal store and `datasetStore` mutations must stay in sync. Solution: every commit flows through the same `datasetStore` method (called from `tools.tsx` commit bodies), and the stage/unstage logic is handled by `webmcp-staged`'s `defaultProposalStore`.

5. **Closing the SQL side channels.** An early version guarded only `run_sql`, so an agent could stack statements through a filter expression (`... ); UPDATE ...`) or read a URL from inside DuckDB's worker (`read_csv('https://...')`) — past the egress monitor, which only sees the main thread. We consolidated to three guards (`assertSelectOnly` / `assertExpression` / `assertIdentifier`) backed by one validator, applied to every agent- and human-supplied SQL fragment at both the tool boundary and the store mutators, and every rejection is logged as `denied`.

---

## Accomplishments

- **Full working product.** Boots at `npm run dev`, loads a demo HR dataset, human can add filters/derived columns/charts/renames interactively.
- **Complete WebMCP surface.** 8 read tools (all working, all logged) + 11 staged write tools. Every tool call tested in Chrome with `#enable-webmcp-testing` + WebMCP Inspector, or via the built-in `AgentConsole` (dev panel to invoke tools by hand).
- **Honest staged approval.** `propose_*` tools stage diff previews (e.g., "add_filter: keeps 150 of 800 rows"). Commit refuses until the human approves in the UI. Typed diffs per tool kind (filters show row counts, derived columns show sample values, charts show mini-preview).
- **Zero egress verified.** SealStatus shows live egress counter. All demo data bundled in `public/demo/`, no fetch calls post-load.
- **Audit transparency.** Activity log shows every tool call (read, propose, commit) with args and result summary. `get_activity_log` tool returns the last 40 entries. "What has the agent seen?" is answerable.
- **Keyboard-first review.** Approve (⏎) and reject (⌫) shortcuts in ReviewPanel. Agent can't force a commit—the human has the only key.
- **Multi-dataset joins.** Agent can propose `join_datasets` to merge two loaded datasets. Preview shows result row count. On approval, creates a new "joined" dataset.
- **Agent-authored reports.** `write_report` tool lets the agent draft markdown findings. Human approves. Renders in Report tab (safe markdown via `marked` + `DOMPurify`). Exportable as `.md`.
- **CSV export with transform awareness.** `export_view` exports the *current view* (filters + derived + renames applied) to a CSV. Download only on approval. Preview shows which transforms are included.
- **Polyfill path for local dev.** `@mcp-b/webmcp-polyfill` makes WebMCP always available in dev. AgentConsole lets you invoke tools by hand.

---

## What We Learned

1. **Read/write honesty is the core.** The `readOnlyHint` split is not decoration—it changes how hosts present the tool to the user. This is WebMCP done right: declaring intent clearly.

2. **Staged diffs are underrated.** Showing the human a typed preview ("This filter keeps 50 of 800 rows") before commit is more powerful than textual justification. We built typed preview renderers per tool, and each one is now testable and auditable.

3. **The activity ledger is the transparency engine.** Every tool call in/out is logged. Combine that with `get_activity_log` and you have a human-auditable trace of "what did the AI ask for, and what did it see?" This is the privacy story.

4. **Agent and human must share mutation paths.** If you let the agent mutate state via one code path and the human via another, consistency breaks. We built it so both land in `datasetStore.addFilter()`, `addDerivedColumn()`, etc. The UI is the source of truth.

5. **DuckDB-WASM is underrated for this.** Full SQL, no server, no query to an API. The agent can write complex queries and they just work. Join syntax, window functions, CTEs—all there in-browser.

---

## What's Next

**Excel import, once it can be done safely.** Airlock already reads Parquet, TSV, JSON and pasted clipboard data — Parquet at zero dependency cost, because DuckDB-WASM's reader is natively linked. `.xlsx` was built and then deliberately cut: the only viable npm parser (SheetJS 0.18.5) carries two unpatched high-severity advisories, one of them prototype pollution, in exactly the code path that parses untrusted user files. Shipping a known-vulnerable parser inside a tool whose whole promise is "this is the safe place for your sensitive data" wasn't a trade worth making for one file format. `npm audit` reports zero vulnerabilities. Excel returns when there's a parser we'd defend.

**Share the analysis, never the data.** A recipe plus a cited report is a complete, reproducible piece of work that contains no rows. Send a colleague the method and let them run it against their own copy. That's a fundamentally different sharing model than emailing a spreadsheet, and it falls out of what's already built.

**Redaction that survives the agent getting smarter.** Today's enforcement is a lexical guard plus value masking. The stronger version is a genuinely read-only DuckDB connection with column-level grants, so the boundary is enforced by the engine rather than by our validator. Defence in depth is good; defence in the engine is better.

**Verify the report, not just the claim.** Citations prove a number came from a query. The next step is proving the *query* was reasonable — flagging when an agent cites a query whose result doesn't actually support the sentence it's attached to.

**Multi-table joins** (3+ datasets, cached intermediates), **richer charts** (scatter, histogram, heatmap), and **refresh-and-alert** — point a recipe at a folder, re-run on new files, and surface what changed.

**Immediate:** deploy to Netlify, record the demo, and let judges see the staged approval loop in action. Everything above is roadmap; everything in "What It Does" is built.

---

## Technical Verification

- **Boots:** `npm install` (root) + `npm run dev` → http://localhost:5173 renders EmptyState; "Load demo" loads HR CSV, grid populates.
- **Read tools:** Chrome `#enable-webmcp-testing` + WebMCP Inspector → `list_columns`, `profile_column`, `run_sql` all return correct data.
- **Guarded SELECT:** `run_sql("UPDATE dataset SET salary = 0")` → rejected by `assertSelectOnly`.
- **Staged write:** Invoke `propose_add_filter` in Inspector → proposal appears in ReviewPanel; `commit_add_filter` before approval → error; approve in UI → commit succeeds, grid updates.
- **Egress:** SealStatus reads 0 bytes sent throughout normal use.
- **Audit:** Every tool call (read, propose, commit) in activityLog, visible in ActivityLog component.

---

## Why It Matters

Airlock unlocks a new class of analysis: *human-in-the-loop, agent-native data workspace, zero data egress.* You get the speed of AI + the safety of data staying put + the auditability of an activity ledger. Teams with sensitive data can now ask an agent for analysis without violating their data policy. The honest WebMCP split (`readOnlyHint`, staged approval) is the mechanism that makes this trustworthy.

This is not a demo. It's a foundation for a new way to collaborate with AI on data: the agent proposes, the human approves, both mutate the same workspace, and nothing moves without consent.
