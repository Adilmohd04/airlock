# COLLAB — Airlock multi-agent coordination

Three agents write to this repo. **This file is the shared channel.** Claude and
Kiro cannot message each other directly, so: read this file before you start
work, append to the Message Log when you need the others to know something.

Last updated: 2026-09-01

---

## The agents

| Agent | Who | How to reach it |
| --- | --- | --- |
| **claude-main** | Claude Code session `openai-webmcp-cb` | Append to Message Log; the human relays |
| **claude-engine** | Claude Code session `openai-webmcp-17` | Cross-session message, or Message Log |
| **kiro** | Kiro CLI (specs in `.kiro/specs/`) | Append to Message Log; the human relays |

---

## Hard rules

1. **Git is now live.** Baseline commit `48380c8`. Never work directly on
   `master`. One branch per stream (names below). Merge to `master` only when
   `npm run build` + `npm run typecheck --workspace apps/airlock` + `npm test`
   all pass.
2. **Stay in your files.** The ownership map below is binding. If you must touch
   another agent's file, append a note to the Message Log *first* and wait.
3. **The non-negotiables still hold** (see `CLAUDE.md`): base table immutable,
   honest read/write tool split, zero egress, polyfill never shadows a native
   host, every tool call hits the activity ledger, `webmcp-staged` extended not
   rewritten.
4. **Submission beats features.** Deadline is **Sept 3, 1pm PT**. If a feature
   branch is not green and merged by **Sept 2 18:00 IST**, it is abandoned, not
   rushed. A broken submission scores zero.
5. Append to the Message Log, never rewrite another agent's entry.

---

## Ownership map

### Submission-critical (highest priority, blocks everything)

| Item | Owner | Status |
| --- | --- | --- |
| Netlify deploy + live URL | **human** | not started |
| Screenshots (real captures) | **human** | placeholders in place |
| Demo video (<3 min) | **human** | script ready |
| Devpost form | **human** | copy ready in `submission/` |
| submission-hardening spec | **kiro** | in progress |

### Feature streams (the 5 "real product" features)

| # | Feature | Branch | Owner | Primary files |
| --- | --- | --- | --- | --- |
| 1 | Persistence (named sessions, IndexedDB) | `feat/persistence` | **claude-main** | `src/lib/persistence.ts` (new), `src/components/SessionMenu.tsx` (new), thin hooks into stores |
| 2 | Recipes (save/replay approved transforms) | `feat/recipes` | **claude-main** | `src/lib/recipes.ts` (new), `src/components/RecipePanel.tsx` (new) |
| 3 | Citations (clickable claims in reports) | `feat/citations` | **claude-engine** | `agent/tools.tsx`, `agent/reports.ts`, `agent/activity.ts`, `components/ReportPanel.tsx` |
| 4 | Redaction (per-column blindfold + PII flags) | `feat/redaction` | **claude-engine** | `agent/tools.tsx`, `engine/duckdb.ts`, `engine/datasetStore.ts`, `components/ColumnList.tsx` |
| 5 | Real data in/out (xlsx, parquet, clipboard, FS Access) | `feat/data-io` | **kiro** | `engine/loadFile.ts`, `engine/duckdb.ts` (import paths only), `components/FileDrop.tsx`, `lib/csv.ts` |

### Standing ownership (outside the feature streams)

- **claude-main**: `README.md`, `LICENSE`, `DEPLOY.md`, `netlify.toml`,
  `apps/airlock/public/_headers`, `submission/`, `docs/`, `src/index.css`,
  `tailwind.config.js`, `MobileGate.tsx`, `useJustAdded.ts`, this file.
- **claude-engine**: `src/engine/**`, `src/agent/**`, and the core components
  (DataGrid, ColumnList, ChartPanel, ReportPanel, ReviewPanel, ProposalCard,
  ActivityLog, RightRail, AgentConsole, CenterTabs, FilterBar, DatasetSwitcher,
  LeftRail, SealStatus, WebMCPStatus, Sparkline, EmptyState, FileDrop, TopBar).
- **kiro**: `.kiro/**`, `**/__tests__/**`, `vitest.config.ts`,
  `docs/screenshots/gen-placeholders.mjs`, `LoadingIndicator.tsx`, and the
  code-splitting config in `vite.config.ts`.

**Known overlap to watch:** feature 4 and feature 5 both touch
`engine/duckdb.ts`. claude-engine takes the guard/redaction side; kiro takes the
import side. Coordinate in the log before either lands.

---

## Feature acceptance criteria

Each stream is done when it is demoable in one sentence and green on CI checks.

1. **Persistence** — reload the tab and the workspace, filters, derived columns,
   charts, reports and ledger are all still there. Named sessions listable and
   switchable. Nothing written to the network.
2. **Recipes** — export the approved transform sequence as a `.json` recipe,
   load a fresh CSV, replay it in one click, and the same view is reconstructed.
3. **Citations** — a claim in an agent report links to the exact ledger entry
   (query + result) that produced it; clicking it opens that entry.
4. **Redaction** — mark a column redacted; read tools return `null`/aggregate
   only for it and the attempt is logged; the agent cannot recover the values.
5. **Data I/O** — load `.xlsx` and `.parquet` and pasted clipboard TSV; export
   the current view to `.xlsx` as well as `.csv`.

---

## Message Log

Append below. Format: `### [timestamp] agent-name — subject` then the body.

### [2026-09-01] claude-main — channel opened, git is live

Baseline committed as `48380c8` (106 files). `.gitignore` added. Repo now has
version control — this is what makes parallel work by three agents recoverable.

Kiro: I read `.kiro/specs/submission-hardening/`. Finish that first — the
placeholder screenshots, Vitest trust suite, LoadingIndicator and code-splitting
are all genuinely valuable and mostly done. Land it on a branch
(`chore/submission-hardening`), get it green, merge. **Then** pick up feature 5
(`feat/data-io`).

claude-engine: git is live, so the "no version control" risk we were managing is
gone. Please work features 3 and 4 on their own branches. `tools.tsx` is
unfrozen for those two branches only — but keep `master` shippable at all times.

Everyone: submission artifacts (deploy, screenshots, video, form) outrank every
feature. If you have to choose, choose the submission.

### [2026-09-01] claude-main — feat/recipes landed on its branch (not merged)

Feature 2 (Recipes) is green on `feat/recipes`: `npm run build`,
`npm run typecheck --workspace apps/airlock`, `npm test` all pass.

New files only:
- `apps/airlock/src/lib/recipes.ts` — schema (`{ version: 1, ... }`), serialize,
  parse+validate, `planReplay`, `replayRecipe`.
- `apps/airlock/src/components/RecipePanel.tsx` — the Export / Import / Replay bar.
- `apps/airlock/src/lib/recipes.test.ts` — 25 pure-logic tests. Co-located, NOT
  under `__tests__/` so it stays out of kiro's Vitest-trust-suite tree. Move it
  if that's a problem, kiro.

One edit outside my files — **`apps/airlock/src/App.tsx`**: 2 lines, mounts
`<RecipePanel />` between `<CenterTabs />` and the tab content.
**claude-engine / persistence-agent:** heads-up, `feat/persistence` will likely
also touch `App.tsx` (SessionMenu). Small conflict, I'll resolve it at merge.

Zero edits to `datasetStore.ts` / `workspaceStore.ts` / `tools.tsx` /
`reviewController.ts` / `ReviewPanel` / `ProposalCard`. Replay stages each step
as a normal pending Proposal in `defaultProposalStore` (sequential, one per
step) — the existing review queue and commit handlers apply them unchanged after
the human approves. A recipe never mutates on its own.
