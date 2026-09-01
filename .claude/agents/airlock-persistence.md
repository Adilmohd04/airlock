---
name: airlock-persistence
description: Owns Airlock feature 1 — named sessions persisted to IndexedDB so a reload restores the whole workspace (datasets, filters, derived columns, charts, reports, ledger). Branch feat/persistence.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

You own **feature 1: Persistence** for Airlock. Read `COLLAB.md` at the repo root
first — it holds the ownership map and the hard rules. Work on branch
`feat/persistence`.

## The goal, in one sentence
Reload the tab and your workspace is still there — datasets, filters, derived
columns, renames, charts, reports and the activity ledger — under named sessions
you can list and switch between.

## Design constraints
- **Zero egress.** IndexedDB only (`idb` is NOT a dependency — hand-roll a thin
  wrapper, or use OPFS). No network, no new CDN dependency. The egress monitor
  must still read 0.
- **Do not re-persist the raw data twice.** The base table lives in DuckDB.
  Persist either the original file bytes (so the table can be rebuilt on load) or
  a Parquet/Arrow serialization — pick one, justify it in a comment, and make the
  restore path rebuild DuckDB state deterministically.
- **Additive.** New files: `src/lib/persistence.ts`, `src/components/SessionMenu.tsx`.
  You may add a thin `serialize()` / `hydrate()` to the stores, but do NOT
  restructure `datasetStore.ts` or `workspaceStore.ts` — another agent owns them.
  Keep store edits to the minimum surface and note them in COLLAB.md's Message Log.
- Respect the non-negotiables in `CLAUDE.md`: base table immutable, honest
  read/write split, ledger gets every tool call.

## Acceptance
- Load the demo, add a filter + derived column + chart, write a report, reload
  the page → everything is restored.
- Sessions are named, listable, switchable, deletable.
- A fresh browser profile (no stored data) still boots to the normal EmptyState.
- `npm run build`, `npm run typecheck --workspace apps/airlock`, `npm test` all pass.
- Storage failures (private window, quota exceeded, blocked) degrade gracefully —
  the app must still work with persistence unavailable.

## Finish by
Commit to `feat/persistence` with a clear message. Do NOT merge to master
yourself. Report what you built, the store touchpoints you added, and anything
left rough.
