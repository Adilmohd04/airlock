# Graph Report - openai_webmcp  (2026-09-01)

## Corpus Check
- Corpus is ~16,592 words - fits in a single context window. You may not need a graph.

## Summary
- 405 nodes · 710 edges · 18 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- React UI Components
- Dataset Store & Query Model
- Activity Ledger & Reports
- webmcp-staged Package Config
- WebMCP Staged Tool Core
- Airlock Package Dependencies
- Airlock TypeScript Config
- Workspace & Dataset Loading
- webmcp-staged TS Config
- Airlock Build Tooling
- Monorepo Workspace Config
- Egress Monitor & Seal
- Airlock Project Concepts

## God Nodes (most connected - your core abstractions)
1. `DatasetStore` - 37 edges
2. `WorkspaceStore` - 24 edges
3. `compilerOptions` - 18 edges
4. `react` - 17 edges
5. `useActiveDataset()` - 16 edges
6. `runQuery()` - 14 edges
7. `ActivityLog` - 13 edges
8. `rid()` - 13 edges
9. `registerStagedTool()` - 13 edges
10. `compilerOptions` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Airlock agent-native data workspace` --references--> `webmcp-staged library`  [INFERRED]
  apps/airlock/index.html → packages/webmcp-staged/README.md
- `App()` --calls--> `useAirlockTools()`  [EXTRACTED]
  apps/airlock/src/App.tsx → apps/airlock/src/agent/tools.tsx
- `CenterTabs()` --calls--> `useReports()`  [EXTRACTED]
  apps/airlock/src/components/CenterTabs.tsx → apps/airlock/src/agent/hooks.ts
- `useAirlockTools()` --calls--> `runQuery()`  [EXTRACTED]
  apps/airlock/src/agent/tools.tsx → apps/airlock/src/engine/duckdb.ts
- `SealStatus()` --indirect_call--> `getEgress()`  [INFERRED]
  apps/airlock/src/components/SealStatus.tsx → apps/airlock/src/lib/egress.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Staged tool trio (propose/commit/reject)** — packages_webmcp_staged_readme_webmcp_staged, packages_webmcp_staged_readme_staged_approval, packages_webmcp_staged_readme_readonlyhint_split [EXTRACTED 0.80]

## Communities (18 total, 0 thin omitted)

### Community 0 - "React UI Components"
Cohesion: 0.07
Nodes (32): App(), CenterTabs(), ChartPanel(), abbrevType(), ColumnList(), DataGrid(), fmt(), rowMatchesAnyFlag() (+24 more)

### Community 1 - "Dataset Store & Query Model"
Cohesion: 0.07
Nodes (23): ColumnProfile, CreateDatasetOptions, DatasetState, DatasetStore, DerivedColumn, errorMessage(), FilterClause, FlagSet (+15 more)

### Community 2 - "Activity Ledger & Reports"
Cohesion: 0.06
Nodes (25): ActivityEntry, ActivityKind, ActivityLog, Listener, useReports(), ToolPreview, InsightReport, Listener (+17 more)

### Community 3 - "webmcp-staged Package Config"
Cohesion: 0.05
Nodes (39): description, devDependencies, react, tsup, @types/react, typescript, exports, ./react (+31 more)

### Community 4 - "WebMCP Staged Tool Core"
Cohesion: 0.13
Nodes (27): anySignal(), asToolResult(), defaultProposalStore, errorResult(), getModelContext(), isWebMCPAvailable(), newProposalId(), Proposal (+19 more)

### Community 5 - "Airlock Package Dependencies"
Cohesion: 0.07
Nodes (27): dependencies, dompurify, @duckdb/duckdb-wasm, marked, @mcp-b/webmcp-polyfill, react, react-dom, recharts (+19 more)

### Community 6 - "Airlock TypeScript Config"
Cohesion: 0.08
Nodes (23): compilerOptions, allowImportingTsExtensions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+15 more)

### Community 7 - "Workspace & Dataset Loading"
Cohesion: 0.19
Nodes (3): createDatasetStore(), Origin, WorkspaceStore

### Community 8 - "webmcp-staged TS Config"
Cohesion: 0.11
Nodes (18): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, jsx, lib, module, moduleResolution (+10 more)

### Community 9 - "Airlock Build Tooling"
Cohesion: 0.12
Nodes (17): devDependencies, autoprefixer, postcss, tailwindcss, @types/react, @types/react-dom, typescript, vite (+9 more)

### Community 10 - "Monorepo Workspace Config"
Cohesion: 0.12
Nodes (16): description, engines, node, license, name, private, scripts, build (+8 more)

### Community 11 - "Egress Monitor & Seal"
Cohesion: 0.23
Nodes (11): SealStatus(), bodySize(), EgressState, emit(), getEgress(), installEgressMonitor(), Listener, listeners (+3 more)

### Community 12 - "Airlock Project Concepts"
Cohesion: 0.25
Nodes (9): Airlock agent-native data workspace, DuckDB-WASM in-browser analytics engine, Data never leaves the browser, Feature-detected no-op without WebMCP, Human-in-the-loop mutation contract, readOnlyHint split: propose_* read-only, commit_* write, Staged human approval (propose -> review -> commit), WebMCP (web page exposes tools to AI agent) (+1 more)

## Knowledge Gaps
- **121 isolated node(s):** `name`, `private`, `version`, `type`, `description` (+116 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `React UI Components` to `webmcp-staged Package Config`, `Activity Ledger & Reports`, `Egress Monitor & Seal`, `WebMCP Staged Tool Core`?**
  _High betweenness centrality (0.252) - this node is a cross-community bridge._
- **Why does `keywords` connect `webmcp-staged Package Config` to `React UI Components`?**
  _High betweenness centrality (0.120) - this node is a cross-community bridge._
- **Why does `DatasetStore` connect `Dataset Store & Query Model` to `React UI Components`, `Activity Ledger & Reports`, `Workspace & Dataset Loading`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _121 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `React UI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.0715846994535519 - nodes in this community are weakly interconnected._
- **Should `Dataset Store & Query Model` be split into smaller, more focused modules?**
  _Cohesion score 0.0707070707070707 - nodes in this community are weakly interconnected._
- **Should `Activity Ledger & Reports` be split into smaller, more focused modules?**
  _Cohesion score 0.062409288824383166 - nodes in this community are weakly interconnected._