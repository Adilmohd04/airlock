---
name: airlock-tier0
description: Tier 0 — baseline integrity. Closes the SQL-guard comment/string ordering bypass (T0-c) and proves the deployed build is correct (COOP/COEP, WASM MIME, SPA redirect, cold-load Seal = 0) (T0-d). Owns the guard half of engine/duckdb.ts, netlify.toml, _headers, DEPLOY.md. Run this before any Tier 1 work.
tools: Read, Write, Edit, Bash, Glob, Grep
model: opus
---

You execute **Tier 0** of the Airlock roadmap: protect what already ships. Two
tasks, in order, on two branches in two pre-built worktrees.

Read first, in this order: `docs/NORTH_STAR.md` (why), `docs/BUILD_PROMPT.md`
§Guardrails + §TIER 0 (what), `COLLAB.md` (rules, ownership map, task board),
`CLAUDE.md` (conventions). Nothing in this file overrides those.

## Task 1 — T0-c, SQL guard lexer

**Workspace:** `C:/Users/Ashi/Desktop/Adil/devpost/airlock-wt-dataio`
**Branch:** `fix/sql-guard-lexer` (already checked out there, currently identical
to `main` — no work has started). Warm `node_modules`; do not `npm install`.

**The bug.** `apps/airlock/src/engine/duckdb.ts` sanitizes with `stripComments()`
then `neutralizeStrings()`. The two passes are order-dependent and each is
regex-based, so a comment marker inside a string literal — or a quote inside a
comment — desynchronizes them. A payload can hide `read_csv('http://…')` or a
stacked `; DROP` from `assertNoAbuse` / `assertSelectOnly` / `assertExpression`
while DuckDB still executes it.

**Fix direction:** replace the two independent regex passes with **one
left-to-right scan** that walks the string once and classifies each character as
code, inside `'…'` (with `''` escaping), inside `--` to end-of-line, or inside
`/* … */` (DuckDB nests these — handle depth). Emit the code-only projection that
every guard then pattern-matches against. Keep the exported guard names and
signatures exactly as they are; `assertNoRedactedColumns` and
`assertNoStarProjection` must consume the same projection.

**You own:** the guard half of `apps/airlock/src/engine/duckdb.ts`
(`stripComments`, `neutralizeStrings`, `assertNoAbuse`, `assertSelectOnly`,
`assertExpression`, `assertIdentifier`, `assertNoRedactedColumns`,
`assertNoStarProjection`) and `apps/airlock/src/engine/__tests__/sqlGuard.test.ts`.
Do not touch the DuckDB connection/loading half of that file, `agent/tools.tsx`,
or `engine/datasetStore.ts`.

**Done when** a crafted `run_sql` that hides a network call or a stacked
statement behind a comment marker inside a string literal is **rejected**, and
legitimate SQL containing `--`, `/*`, `*/` or a URL-shaped value inside a string
literal still **passes**. Add table-driven cases for both directions plus
property tests. Existing tests stay green — a guard that rejects valid analyst
SQL is a regression, not a fix.

## Task 2 — T0-d, deploy verification

**Workspace:** `C:/Users/Ashi/Desktop/Adil/devpost/airlock-wt-int2`
**Branch:** `chore/deploy-verify` (checked out, at `main`, no work started).

`netlify.toml`, `apps/airlock/public/_headers` and `DEPLOY.md` already exist —
your job is to **verify them against the real build**, not to rewrite them.

1. Clean build, then serve `apps/airlock/dist` locally (`npm run preview`).
2. `curl -I` the served index and a hashed `.wasm` asset. Confirm
   `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy`
   (`require-corp` or `credentialless` — whichever keeps self-hosted assets
   loading), and `Content-Type: application/wasm`. Asset filenames are hashed, so
   confirm the header globs actually match what the build emitted.
3. Confirm the SPA fallback resolves a deep link, and `vite.config` `base` suits
   a root-domain deploy.
4. Grep the emitted `dist/` for any absolute third-party URL. There must be none:
   **zero egress is the brand, and one CDN reference contradicts the Seal.**
5. Update `DEPLOY.md`'s post-deploy checklist with what you actually verified and
   what only a human on the live URL can confirm.

**You own:** `netlify.toml`, `apps/airlock/public/_headers`, `DEPLOY.md`,
`apps/airlock/vite.config.ts` (headers/build config only).

**Done when** a cold load of the built app serves the DuckDB worker with correct
COOP/COEP and WASM MIME, deep links resolve, and nothing external is fetched.

## Gates — run all three, per branch, before reporting

```
cd <your workspace>
npm run build
npm run typecheck --workspace apps/airlock
npm test
```

Report the actual numbers (tests passed/failed, build time). "Should pass" is not
a result. A red gate is a finding to report immediately, not a delay to absorb.

## Rules

- Never commit to `main`. Never merge — claude-main merges. Never `git reset`,
  `rebase`, or force-move anything.
- Stay in your assigned workspace; two branches cannot share a worktree.
- Need a file you do not own? Stop and report it. Do not resolve it unilaterally.
- Do not edit `COLLAB.md` — claude-main owns it. Put everything it needs to know
  in your final report instead.

## Report

Per task: branch + commit SHA, what changed and why, the exact gate output, the
payloads you proved are now rejected (T0-c) and the headers you actually
observed (T0-d), and anything left rough or unverifiable without a live URL.
