# Airlock — handoff for the next agent

_Written 2026-09-02. `main` @ `4247744`. Feed this file to whoever picks up the build._

Read `docs/NORTH_STAR.md` (the why) and `docs/BUILD_PROMPT.md` (the what) first.
Then `COLLAB.md` (the running log — the authoritative status). This file is the
summary on top of those.

---

## The one-sentence state

Airlock is a working agent-native data workspace with the **UI and engine for a
fully-local AI model in place** — but the **local agent loop is not wired**, so
selecting "Local mode" does not yet make a model drive the tools. That loop
(**T1-b**) is the single most important remaining piece.

---

## What is DONE (merged to `main`, gates green)

`main` gates as of `4247744`: `npm run build` clean · `npm run typecheck
--workspace apps/airlock` clean · `npm test` → **438 passed** · `npm audit
--omit=dev` → **0 vulnerabilities**.

### Baseline product (pre-mission-change, all on `main`)
- Three-column workspace: dataset switcher + column profiles / grid + charts +
  report / review queue + activity ledger.
- **WebMCP surface** — `apps/airlock/src/agent/tools.tsx`: 8 read tools
  (`readOnlyHint: true`, run immediately) + 12 staged tools (`propose_* →
  human approve → commit_*`). Frozen for Tier 1.
- **webmcp-staged** — `packages/webmcp-staged/`, the reusable propose/approve/
  commit primitive. Extend, never rewrite.
- **Persistence** — named IndexedDB sessions; reload restores datasets, filters,
  derived columns, charts, reports, ledger. Stores original file bytes, rebuilds
  the DuckDB table deterministically.
- **Recipes** — export the approved transform sequence as versioned JSON, replay
  on a new file. Replay **stages proposals**, never auto-applies.
- **Citations** — `[cite:<ledgerId>]` markers in agent reports resolve to the
  exact query + result; proposal preview shows cited/uncited/broken counts before
  approval. XSS-safe (double-sanitized).
- **Redaction** — per-column agent blindfold. 12 attack paths closed and tested
  (alias, CTE, concat, CASE, aggregates, `SELECT *`, `SUMMARIZE`, rename evasion,
  …). Un-redact is human-only. Persists across reload (round-trip test proves the
  column stays redacted AND its cached profile stays shape-only).
- **Data I/O** — Parquet (zero deps — DuckDB-WASM native reader), TSV, clipboard
  paste with delimiter sniffing, File System Access picker. `.xlsx` was built
  then **deliberately removed** (`e50709d`): SheetJS 0.18.5 has two unpatched
  high-severity advisories in the untrusted-parse path.
- **SQL guards** — single-pass lexer (`engine/duckdb.ts`), applied to every
  agent/human SQL fragment at the tool boundary AND the store mutators. Blocks
  `;`-stacking, mutating keywords, and network functions (`read_csv('http…')`).
  Closed the "literal hides a comment marker" bypass.
- **Deploy config** — `netlify.toml` + `apps/airlock/public/_headers`: COOP/COEP
  for the DuckDB worker, `application/wasm` MIME, SPA redirect, Node pinned.
  `DEPLOY.md` has the verification checklist. **NOT actually deployed.**

### Tier 1 — the fully-local agent (partial)
| Piece | Status | Branch (merged) |
| --- | --- | --- |
| **T1-a** WebLLM runtime + `LocalModelStore` + model catalog + `scripts/fetch-models.mjs` | ✅ merged `2ef7529` | `feat/local-model-runtime` |
| **T1-c** model-download consent/progress/hardware-check/cache UX | ✅ merged `00f5ff7` | `feat/local-model-ux` |
| **T1-d** agent mode (Local/Cloud/BYO) + honest per-mode Seal + WebMCPStatus | ✅ merged `5aebc43` | `feat/agent-mode` |
| **T1-b** the local agent loop | ❌ **NOT STARTED** | `feat/local-agent-loop` (empty) |

**T1-a details the next agent needs:**
- Default model **Qwen2.5-3B-Instruct q4f16_1** (1.63 GiB). Also 3B-alt,
  1.5B-small, 1B-low-end. Catalog: `apps/airlock/src/agent/localModel/models.ts`.
- **No model supports native tool calls.** `supportsNativeToolCalls: false` is a
  catalog field. T1-b MUST use `response_format: { type: "json_object", schema }`,
  not `request.tools`.
- Weights are **same-origin only** — served from `/models/<id>/resolve/main/…`.
  Guaranteed 4 ways (no third-party URL literal in source; `assertSameOrigin()`
  throws before any fetch; tests pin it; verified live with a real 704 MB mirror).
  `prebuiltAppConfig` (160+ huggingface.co URLs) is never imported.
- Store API for T1-b: `store.chat(request)`, `store.interrupt()`,
  `store.getEngine()`, `generating` flag. **Call `store.chat()` not
  `getEngine().chat()`** so `generating` stays honest.
- Store is a **7-state machine** (`unavailable → not-downloaded → downloading →
  paused → ready → running → error`). T1-c's stub already binds to it;
  integration is "delete the STUB block + 2 imports".

### Two stubs on `main` — do NOT demo these as working
1. **T1-c's `LocalModelStore` binding is an in-memory stub** — real WebGPU probe,
   but a *simulated* download and a `localStorage` flag instead of the Cache API.
   Between `STUB ↓` / `STUB ↑` markers in `LocalModelPanel.tsx`. The real store
   (`agent/localModel/store.ts`) exists on `main` from T1-a — the swap just
   hasn't been done.
2. **No local agent loop.** T1-b.

---

## What REMAINS (in priority order)

### 1. Integrate T1-a's real store into T1-c's UI  — small, do first
Delete the `STUB ↓…STUB ↑` block in `apps/airlock/src/components/LocalModelPanel.tsx`,
replace with `import { localModelStore, useLocalModelStore } from
"../agent/localModel/store"` and `import { LOCAL_MODELS, DEFAULT_MODEL_ID,
getModel, formatModelSize } from "../agent/localModel/models"`. T1-a wrote the
store to match T1-c's interface name-for-name, so component code should not
change. Wire `agentModeStore.setLocalModelStatus(store.status, store.activeModelId)`
from wherever the store is subscribed (T1-d consumes only those two fields).
Gate: 438 tests still pass, WebGPU-absent path still clean.

### 2. T0-d follow-up — deploy config for the weights  — small, blocks the demo
In `netlify.toml` / `apps/airlock/public/_headers`:
- **Exclude `/models/*` from the SPA catch-all redirect.** T1-a proved a
  catch-all returns `200 text/html` for a missing weight file, which makes WebLLM
  "download" the app shell repeatedly and fail deep in a tensor parse.
- Set `Content-Type: application/wasm` for `/models/lib/*`.
Owned by the T0-d stream (`chore/deploy-verify` branch / `airlock-wt-int2`).

### 3. Decide deploy strategy for the weights  — DECISION NEEDED, not code
3B default → ~1.8 GB `dist/` with a single 131 MB shard; may exceed Netlify
limits. Options that keep the "no third-party origin" claim:
- **(a)** Ship the **1B model as the deployable default**, let users opt up to 3B.
- **(b)** Same-origin path **proxied to object storage** (R2/S3) — the browser
  still only ever talks to Airlock's origin, so the Seal and the claim hold.
- **(c)** Don't host weights at all on the public demo; local model is
  "bring your own mirror via `scripts/fetch-models.mjs`", cloud mode is the
  default demo path.
A CDN URL in the model catalog is the one unacceptable answer (breaks the whole
thesis). **This is a call for Sadath.**

### 4. T1-b — the local agent loop  — THE HEADLINE, biggest remaining piece
Spec: `docs/BUILD_PROMPT.md` §1.2. New files:
`apps/airlock/src/agent/localModel/agent.ts`, `localModel/systemPrompt.ts`.
- `LocalAgent` is a **WebMCP client**: reads the tool list from
  `document.modelContext` (same tools ChatGPT sees), runs a tool-calling loop
  against the local model via `localModelStore.chat()`.
- Loop: system prompt → user goal → model emits tool calls (constrained JSON) →
  execute via model context → feed results back → repeat until final answer or
  step cap (default 12).
- **`propose_*` calls stop the loop** and surface "waiting for approval" — do
  NOT spin. Human approves in `ReviewPanel` → loop resumes with the commit result.
- Every model tool call still flows through `read()` / `stage()` in `tools.tsx` —
  ledger populated identically, no new logging path.
- Small-model robustness: constrain output with JSON mode; on malformed output,
  return a corrective tool result ("your last call was not valid JSON, retry"),
  cap retries; pass an `AbortSignal` with a per-step deadline (`chat()` has no
  built-in timeout).
- Context is 4096 tokens on every model — window/summarize tool results, don't
  replay the full transcript.
- `agent/tools.tsx` is **frozen** — read the tool list from the model context,
  don't modify the registration surface. If you think you need to, stop and
  report in COLLAB.
Acceptance: `docs/BUILD_PROMPT.md` §1.5 — offline (DevTools) the full demo path
completes (reads, proposals, approvals, committed flag set + chart + report),
Seal reads 0 external the whole time, a `propose_*` stops and resumes correctly
with one `proposalId` through the ledger, malformed output recovers.

### 5. T1-5 — the demo path  — after T1-b
Scripted airplane-mode flow: load `public/demo/compensation.csv` → Local mode →
"find pay gaps by gender, flag anyone >15% below market, write a one-paragraph
summary" → agent runs read tools, proposes flag set + chart + report → human
approves each → done, Seal at 0. Verify with DevTools network throttled to
offline after the model is cached.

### 6. Tier 2.1 — verifiable trust receipt  — the moat, after Tier 1
Spec: `docs/BUILD_PROMPT.md` §2.1. Branch `feat/attestation`, workspace
`airlock-wt-integration`. New files: `apps/airlock/src/lib/attestation.ts`,
`lib/signing.ts`, `components/AttestationPanel.tsx`, `public/verify.html`.
- Collect session id/timestamps, dataset name + **SHA-256 of raw bytes** (+ row/
  col counts, **never values**), every `activityLog` call, agent mode(s) used +
  for cloud the host + exact rows/columns disclosed, egress final state, model id
  + where it ran, app version + git SHA.
- Canonicalize to stable JSON. **Ed25519 keypair in `crypto.subtle`** per install
  (persisted), sign the canonical bytes, embed pubkey + signature. Chain receipts
  by hash of previous.
- Export as `airlock-attestation-<date>.json` + a printable one-page HTML.
- Standalone offline `public/verify.html` re-checks signature + hash chain.
Acceptance: session exports a receipt; verify page confirms it; editing any field
breaks verification; **no raw cell value ever appears in the receipt**.

### 7. Tier 2.2 / 2.3 / 2.4  — independently shippable, by buyer priority
- **2.2** Redaction × local model = *provable* blindfolding (redaction at
  `buildViewSql`, attestation records non-exposure).
- **2.3** Provenance-linked reports (already partly done by Citations — extend so
  a numeric claim with no backing query is rejected at propose time).
- **2.4** Local multi-source (File System Access folder, localhost-proxy pattern,
  consented Sheet import).

### 8. Ship the submission  — human tasks, still zero
- **Deploy to Netlify.** `main` is green and deployable now (cloud mode works
  without weights). `git checkout main` first.
- **Real screenshots** — `docs/screenshots/` has placeholders + `CAPTURE-GUIDE.md`.
- **Record the demo video** — `submission/video-script.md` (shot 9b = citations,
  now real).
- **Fill the Devpost form** — copy in `submission/`.
- `main` is **~20 commits ahead of `origin/main`** — `git push` when ready.

---

## Rules the next agent must follow (from `COLLAB.md`)

1. **Never commit to `main`.** One branch per stream, branched from `main`. Only
   the dispatcher merges, after gates are green.
2. **Gates before "done":** `npm run build`, `npm run typecheck --workspace
   apps/airlock`, `npm test` — report actual numbers.
3. **Stay in your files.** Need someone else's? Append to COLLAB and stop.
4. **Non-negotiables:** base table immutable; honest read/write tool split; zero
   egress; polyfill never shadows a native host; every tool call hits the
   activity ledger; `webmcp-staged` extended never rewritten.
5. **Never state a privacy claim the ledger or egress monitor can contradict.**
   In Cloud mode the words "your data never leaves your browser" must not appear
   near the Seal. If unsure a sentence is defensible, weaken it.
6. **Never `git reset` / `rebase` / force-move `main`.** (There was a rewind on
   2026-09-01 that dropped a commit; git saved it.)
7. After `npm install` on a fresh checkout, also run `npm run build:pkg` or
   typecheck fails on `webmcp-staged` and now also `@mlc-ai/web-llm`.
8. `@mlc-ai/web-llm` is a real dep now — a fresh clone needs `npm install`.

---

## Gotchas discovered the hard way

- **`localhost` breaks the offline model demo** — WebLLM refuses to cache a
  `model_lib` URL containing "localhost". Use `127.0.0.1` or the deployed origin.
- **Fresh git worktrees have no `node_modules`** and no `packages/webmcp-staged/
  dist` — `npm install && npm run build:pkg`. On Windows `npm install` can die on
  `ENOTEMPTY` unlinking `node_modules/confbox/dist` — delete that dir, re-run.
- **Known flaky test:** `sqlGuard.test.ts` fast-check property tests were made
  deterministic (`6ac0963`); if a fast-check test fails once, re-run before
  treating it as real.
- The `LocalModelStore` progress `loadedBytes` is derived (`fraction × catalog
  bytes`) because WebLLM reports a fraction, not bytes. Fine for a readout.
- Several `agentMode` copy sentences are architectural assertions (DuckDB reads
  the File locally; WebGPU has no network surface) not runtime reads — they
  explicitly defer the measured half to the Seal. Keep that framing.

---

## Branch / workspace map

`main` is the only branch that matters. These worktrees exist with warm
`node_modules` for parallel work:

| Workspace | Stream | Branch |
| --- | --- | --- |
| `openai_webmcp/` | dispatcher, merges | `main` |
| `airlock-wt-dataio` | T0-c (done) | `fix/redaction-guard-lexer` |
| `airlock-wt-int2` | T0-d deploy verify | `chore/deploy-verify` |
| `airlock-wt-persistence` | T1-a (done, 704 MB mirror on disk here) | `feat/local-model-runtime` |
| `airlock-wt-recipes` | **T1-b — free, use this** | `feat/local-agent-loop` |
| `airlock-wt-citations` | T1-c (done) | `feat/local-model-ux` |
| `airlock-wt-redaction` | T1-d (done) | `feat/agent-mode` |
| `airlock-wt-integration` | **T2.1 — free, use this** | `feat/attestation` (empty) |

Old feature branches (`feat/persistence`, `feat/recipes`, `feat/citations`,
`feat/redaction`, `feat/data-io*`, `integration*`) are all merged into `main` —
ignore them.
