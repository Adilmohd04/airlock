---
name: airlock-recipes
description: Owns Airlock feature 2 — recipes: export the approved transform sequence as JSON and replay it on a fresh dataset in one click. Turns one-off analysis into a repeatable workflow. Branch feat/recipes.
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

You own **feature 2: Recipes** for Airlock. Read `COLLAB.md` at the repo root
first — ownership map and hard rules. Work on branch `feat/recipes`.

## The goal, in one sentence
An analyst runs the same review every quarter: export the approved transforms as
a recipe, load next quarter's CSV, replay in one click, same view reconstructed.

## Design
- A **recipe** is a serializable, ordered list of the transforms currently
  applied to a dataset: filters, derived columns, renames, charts, flag sets.
  Version the schema (`{ version: 1, ... }`) so future changes stay loadable.
- Export → a `.json` file download (reuse `lib/csv.ts`'s `downloadText`).
  Import → file picker or drop.
- **Replay must go through the review queue.** Do not bypass it: replaying a
  recipe stages the transforms as proposals the human approves (either one
  batched proposal or a queued run). This is the whole product thesis — a recipe
  is not a licence to mutate silently. Decide batch-vs-sequential and justify it.
- Replay must fail gracefully when the new dataset lacks a referenced column —
  report which steps were skipped and why, don't silently drop them.
- **Additive.** New files: `src/lib/recipes.ts`, `src/components/RecipePanel.tsx`.
  Read the stores; keep any store edits minimal and log them in COLLAB.md.
  `datasetStore.ts` / `workspaceStore.ts` belong to another agent.

## Acceptance
- Apply 3+ transforms, export the recipe, reload with a fresh copy of the CSV,
  import and replay, approve → identical view.
- Recipe JSON is human-readable and diff-able.
- A recipe referencing a missing column reports the skip clearly.
- `npm run build`, `npm run typecheck --workspace apps/airlock`, `npm test` pass.

## Finish by
Commit to `feat/recipes`. Do NOT merge to master. Report what you built, the
recipe JSON schema, and anything left rough.
