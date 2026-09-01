# Implementation Plan: submission-hardening

## Overview

Convert the feature design into a series of incremental, additive coding steps
across three independent workstreams (A: README/screenshots, B: Vitest trust
test suite, C: cold-start loading UX + code-splitting). Every task is
reuse-first and additive; no shipped trust code (`duckdb.ts` guards,
`webmcp-staged/core.ts`) is rewritten. Property tests use `fast-check` with
≥ 100 runs and are tagged `Feature: submission-hardening, Property N`.

The three workstreams touch disjoint files and may be executed in any order.
Within a workstream, follow the numbered sequence.

## Tasks

- [x] 1. Workstream A — README integrity + capture setup
  - [x] 1.1 Add the placeholder-PNG generator script
    - Create `docs/screenshots/gen-placeholders.mjs` — a pure-Node PNG writer
      (using `zlib` + raw PNG chunk writer, no new runtime dependency)
    - Emit a dark 1440×900 placeholder with the target filename centered
    - Write each of the six `NN-*.png` files ONLY if absent (never overwrite a
      real capture)
    - _Requirements: 1.3, 2.3_

  - [x] 1.2 Generate and commit the six placeholder screenshots
    - Run `node docs/screenshots/gen-placeholders.mjs`
    - Confirm `docs/screenshots/01-empty-state.png` … `06-agent-console.png`
      now exist and commit them to the repo
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.3 Add the zero-egress capture convention to the capture guide
    - Modify `docs/screenshots/CAPTURE-GUIDE.md`: add one sentence to the
      "Conventions" block requiring capture against the local dev/preview server
      with the Seal reading `Sealed · 0 bytes out` and no external requests
      triggered
    - _Requirements: 2.5_

  - [x] 1.4 Verify README gallery integrity (fix captions in place if needed)
    - Confirm root `README.md` links `01`…`06` at `docs/screenshots/NN-*.png`
      and that exactly one link targets `docs/screenshots/README.md`
    - For each of the six shots, confirm the caption is ≥ 3 words; lengthen any
      caption < 3 words in place
    - _Requirements: 1.1, 1.4, 1.5, 2.1, 2.2, 2.4_

- [x] 2. Checkpoint - Workstream A verification
  - Confirm no broken image references remain in the rendered README and all
    six placeholders resolve. Ensure all tests pass, ask the user if questions
    arise.

- [x] 3. Workstream B — stand up the Vitest test runner
  - [x] 3.1 Add Vitest + fast-check and per-workspace test scripts/configs
    - Add `vitest` and `fast-check` devDependencies to
      `apps/airlock/package.json` and `packages/webmcp-staged/package.json`
    - Add `"test": "vitest run"` to `apps/airlock/package.json` and
      `packages/webmcp-staged/package.json`
    - Add `"test": "npm run test --workspaces --if-present"` to root
      `package.json`
    - Create `apps/airlock/vitest.config.ts` (`environment: 'node'`, do NOT set
      `passWithNoTests`; Vite-based so `?url` imports resolve)
    - Create `packages/webmcp-staged/vitest.config.ts` (`environment: 'node'`;
      hand-rolled `ModelContext` fake, no jsdom dependency)
    - Ensure `test` is NOT part of any `build` script
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 3.2 Prove the runner works with a trivial smoke test
    - Add a trivial passing test (e.g. `apps/airlock/src/__tests__/smoke.test.ts`)
      and confirm `npm run test` reports total/passed/failed and exits 0
    - _Requirements: 3.2, 3.3_

  - [x] 3.3 Implement the SQL-guard property test suite
    - Create `apps/airlock/src/engine/__tests__/sqlGuard.test.ts`, importing
      `assertSelectOnly`, `assertExpression`, `assertIdentifier` directly from
      `../duckdb` (no code moved)
    - If Vitest asset resolution fails on a `?url` specifier, add a one-line
      Vitest `resolve.alias` stub mapping the four asset modules to empty strings
      (still zero changes to `duckdb.ts`)
    - _Requirements: 4.1–4.9_

  - [ ]* 3.4 Write property tests for the SQL guard
    - Use `fast-check`, `{ numRuns: 100 }` (≥ 100 iterations), each tagged
      `Feature: submission-hardening, Property N`
    - **Property 1: Forbidden tokens outside literals/comments are rejected** —
      _Validates: Requirements 4.1, 4.6; Property 1_
    - **Property 2: Networkish references rejected even inside literals** —
      _Validates: Requirements 4.2, 4.6; Property 2_
    - **Property 3: Stacked statements always rejected** —
      _Validates: Requirements 4.3, 4.6; Property 3_
    - **Property 4: `assertSelectOnly` rejects any non-read leading token** —
      _Validates: Requirements 4.4; Property 4_
    - **Property 5: Safe fragments accepted and returned trimmed; empty→throw** —
      _Validates: Requirements 4.5, 4.9; Property 5_
    - **Property 6: `assertIdentifier` accepts exactly the bare-identifier language** —
      _Validates: Requirements 4.7, 4.8, 4.9; Property 6_
    - Include table-driven example rows per keyword in R4.1 and per allowed
      leading keyword in R4.4

  - [x] 3.5 Implement the commit-gate property test suite
    - Create `packages/webmcp-staged/src/__tests__/commitGate.test.ts`
    - Build a fake `ModelContext` whose `registerTool` records the registered
      `propose_*` / `commit_*` / `reject_*` tools; drive `registerStagedTool` +
      `ProposalStore`; capture `StagedAudit` events (extend-only, never edit
      `core.ts`)
    - _Requirements: 5.1–5.6_

  - [ ]* 3.6 Write property tests for the commit gate
    - Use `fast-check`, `{ numRuns: 100 }`, each tagged
      `Feature: submission-hardening, Property N`
    - **Property 7: A non-approved proposal can never be committed** —
      _Validates: Requirements 5.1, 5.2; Property 7_
    - **Property 9: Every refused commit emits exactly one matching audit event**
      (missing / pending / rejected paths; metamorphic K-refusals → K events) —
      _Validates: Requirements 5.3, 5.6; Property 9_
    - **Property 8: An approved proposal applies at most once, then no longer
      resolves** (sequential invocations required) —
      _Validates: Requirements 5.4, 5.5; Property 8_

  - [ ]* 3.7 Write the concurrent double-commit variant (optional edge case)
    - Add a `Promise.all` concurrent variant to the Property 8 test asserting the
      spy `commit` is invoked ≤ 1 time and the proposalId no longer resolves
    - _Requirements: 5.5; Property 8_

  - [x] 3.8 Implement the egress-classifier property test
    - Create `apps/airlock/src/lib/__tests__/egress.test.ts`
    - If `record` is not exported from `apps/airlock/src/lib/egress.ts`, add a
      one-line additive `export` (no logic change)
    - _Requirements: 7.4, 7.5_

  - [ ]* 3.9 Write property test for the egress classifier
    - Use `fast-check`, `{ numRuns: 100 }`, tagged
      `Feature: submission-hardening, Property 10`
    - **Property 10: same-origin no-body GET → `assetRequests`; else
      `externalRequests` (host recorded)** —
      _Validates: Requirements 7.5, 7.4; Property 10_

- [x] 4. Checkpoint - Workstream B verification
  - Run `npm run test` at root: confirm the Trust_Test_Suite runs single-pass,
    reports total/passed/failed, and exits 0. Ensure all tests pass, ask the
    user if questions arise.
  - _Requirements: 3.2, 3.3_

- [x] 5. Workstream C — cold-start loading state
  - [x] 5.1 Add loading/error state and setters to uiStore
    - Modify `apps/airlock/src/engine/uiStore.ts`: add
      `loading: { active: boolean; datasetName: string | null }` and
      `loadError: { datasetName: string; message: string } | null`
    - Add `beginLoad(name)` (synchronous — fires before any await), `endLoad()`
      (clears loading + loadError), `failLoad(name, message)` (clears loading,
      sets sanitized `Error.message` only — never a stack)
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]* 5.2 Write unit tests for uiStore transitions
    - Test `beginLoad`/`endLoad`/`failLoad` transitions; assert `beginLoad` is
      synchronous and `failLoad` message contains no newline and no
      `"\n    at "` stack marker
    - _Requirements: 6.1, 6.3_

  - [x] 5.3 Create the LoadingIndicator component
    - Add `apps/airlock/src/components/LoadingIndicator.tsx` using only existing
      Tailwind semantic tokens (e.g. `bg-ink-800/90`, `text-airlock-300`, dot
      `bg-pending animate-pending-pulse`); zero new color definitions
    - _Requirements: 6.4_

  - [ ]* 5.4 Write component/static test for LoadingIndicator
    - Assert it renders when `loading.active` and that every class name used
      exists in `tailwind.config.js`
    - _Requirements: 6.4_

  - [x] 5.5 Add load wrappers in loadFile.ts and repoint FileDrop
    - Modify `apps/airlock/src/engine/loadFile.ts`: add `loadFile`/`loadDemo`
      wrappers that call `uiStore.beginLoad` before awaiting the
      `workspaceStore` call, then `endLoad()` on success / `failLoad(name, msg)`
      on failure (re-throw)
    - Repoint `apps/airlock/src/components/FileDrop.tsx` to call these helpers
      instead of `workspaceStore` directly so every load path gets the indicator
    - _Requirements: 6.1, 6.2, 6.3, 6.5_

  - [x] 5.6 Render the indicator and error in the app shell
    - Modify `apps/airlock/src/App.tsx` and/or `EmptyState.tsx` / `FileDrop.tsx`
      to render `LoadingIndicator` while `loading.active` (first load AND reload
      while a dataset is shown) and the `loadError` message with `text-danger`
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 6. Workstream C — code-splitting the DuckDB engine
  - [x] 6.1 Lazy-import the DuckDB-WASM glue in duckdb.ts
    - Modify `apps/airlock/src/engine/duckdb.ts`: change the top-level
      `import * as duckdb from "@duckdb/duckdb-wasm"` to a lazy
      `const duckdb = await import("@duckdb/duckdb-wasm")` inside `createDb()`
    - Keep the `?url` asset imports static and all guards unchanged
    - _Requirements: 7.2, 7.5, 7.6_

  - [x] 6.2 Add manualChunks to the Vite build config
    - Modify `apps/airlock/vite.config.ts`: add
      `build.rollupOptions.output.manualChunks` to separate large vendors
      (`react`/`react-dom`, `recharts`, `marked`+`dompurify`) so no single JS app
      chunk exceeds 500 kB uncompressed
    - Do NOT silence the advisory by raising `chunkSizeWarningLimit`; keep it at
      default so the warning genuinely reflects < 500 kB chunks
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 7. Checkpoint - Workstream C verification
  - Run `npm run build`: confirm exit 0, no ">500 kB" advisory for any app
    chunk, a separate dynamically-imported DuckDB chunk exists, and all chunks
    reference the app's own origin (no CDN/cross-origin host)
  - Run `npm run typecheck`: confirm still clean
  - _Requirements: 7.1, 7.2, 7.3, 7.6_

  - [ ]* 7.1 Write build-output and static-egress checks
    - Assert `npm run build` exit 0, the ">500 kB" advisory is absent, a
      separate DuckDB chunk exists, no `.js` app chunk exceeds 500 kB
      uncompressed, and `dist/` contains no `http(s)://` host references
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 7.2 Write runtime zero-egress integration test
    - With a loaded demo dataset and a settled Egress_Monitor, assert
      `externalRequests === 0` and `bytesSent === 0`
    - _Requirements: 2.5, 6.5, 7.4_

- [x] 8. Final checkpoint - full submission-hardening verification
  - Confirm `npm run test` passes (exit 0, reports counts), `npm run build`
    completes without the >500 kB advisory with a separate DuckDB chunk,
    `npm run typecheck` is clean, and the Seal still reads zero egress. Ensure
    all tests pass, ask the user if questions arise.
  - _Requirements: 3.2, 7.1, 7.4_

## Notes

- Tasks marked with `*` are optional (test-writing and edge-case variants) and
  can be skipped for a faster MVP; core implementation tasks are never optional.
- Every change is additive or a single-line edit; no shipped trust code
  (`duckdb.ts` guards, `webmcp-staged/core.ts`) is rewritten.
- Property tests use `fast-check` with `{ numRuns: 100 }` and carry the
  `Feature: submission-hardening, Property N` tag per the design's Testing
  Strategy.
- Each task references specific requirement clauses and/or property numbers for
  traceability.
- Checkpoints provide per-workstream and final validation gates.
- The three workstreams (A: tasks 1–2, B: tasks 3–4, C: tasks 5–7) are
  independent and may be executed in any order.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "5.1", "6.1"] },
    { "id": 1, "tasks": ["1.2", "3.2", "3.3", "3.5", "3.8", "5.2", "5.3", "6.2"] },
    { "id": 2, "tasks": ["1.3", "3.4", "3.6", "3.9", "5.4", "5.5", "7.1"] },
    { "id": 3, "tasks": ["1.4", "3.7", "5.6", "7.2"] }
  ]
}
```
