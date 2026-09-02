# Airlock — Build Prompt (full tiered roadmap)

_Feed this to an implementation agent. It is written to be executed in order.
Read `docs/NORTH_STAR.md` first for the "why"; this file is the "what" and "how"._

---

## How to use this prompt

You are implementing the Airlock roadmap that turns it from a strong demo into a
top-1% product: **the verifiable way to let AI work with data you can't share.**

- Work one Tier at a time, top to bottom. Do not start Tier N+1 until Tier N's
  acceptance criteria pass.
- Each Tier below has: **Goal · Build · Files · Acceptance · Non-goals.**
- Before touching another agent's owned files (`COLLAB.md` ownership map), append
  to the COLLAB Message Log and wait.
- After each Tier: `npm run build` + `npm run typecheck --workspace apps/airlock`
  + `npm test` must all be green. Then `/code-review high` on the diff.
- Rebuild the knowledge graph after each Tier: `/graphify . --update`.

## Guardrails (violating any of these fails the task)

1. **Base table immutable.** Filters / derived columns / renames are view-level
   (`buildViewSql`). `run_sql` stays guarded SELECT-only (`assertSelectOnly`).
2. **Honest read/write split.** Read = `registerTool` + `readOnlyHint: true`,
   immediate. Write = `registerStagedTool`, human-gated. No write tool ever
   skips the review queue.
3. **Egress stays at zero.** No CDN, no analytics, no telemetry. Self-host every
   asset — including model weights (see Tier 1). The egress monitor
   (`lib/egress.ts`) is installed first in `main.tsx`; the Seal shows its count.
4. **Polyfill never shadows a native host.** Only init `@mcp-b/webmcp-polyfill`
   when `document.modelContext` is absent.
5. **Human and agent mutate the same stores.** No divergent code paths.
6. **Every tool call** (read, propose, commit, reject, denied) appends to
   `activityLog`.
7. **Never state a privacy claim the ledger or egress monitor can contradict.**
   If a cloud model is active, the UI says so in plain language.
8. `webmcp-staged` is **extended, never rewritten.**
9. TypeScript strict. Short "why" comments. Tailwind semantic tokens
   (`pending` amber, `commit` green, `danger` red). Dark, monospace for data.

---

## TIER 0 — Baseline integrity (protect what exists)

**Goal:** the hackathon submission is solid and every merged branch is green.
This is table stakes, not the product vision — do it fast, then move on.

**Build:**
- Finish `feat/data-io`: XLSX import (SheetJS, self-hosted), Parquet import
  (DuckDB-WASM native `read_parquet`), clipboard paste → table, drag-drop parity.
- Merge the green `feat/persistence` and `feat/recipes` branches after a full
  smoke test (load → filter → derive → chart → report → reload → replay).
- Close the egress-guard gap: the "networkish string in a SQL comment" bypass in
  `assertSelectOnly` / `assertExpression` — strip comments before pattern checks,
  add a test.
- Verify the live URL: COOP/COEP headers for the DuckDB worker, WASM MIME type,
  SPA redirect, Seal reads 0 external on a cold load.

**Files:** `apps/airlock/src/engine/loadFile.ts`, `engine/duckdb.ts`,
`lib/csv.ts`, `agent/tools.tsx` (guards), `netlify.toml` / `public/_headers`,
plus whatever `feat/persistence` and `feat/recipes` own.

**Acceptance:**
- `npm run build && npm test` green on `master` after merges.
- Import works for CSV, TSV, JSON, XLSX, Parquet, and clipboard paste.
- A crafted `run_sql` payload with a network string inside a `--` or `/* */`
  comment is rejected; test covers it.
- Cold load of the live URL: Seal = 0 external requests.

**Non-goals:** new agent capabilities, any model work, UI redesign.

---

## TIER 1 — Fully-local agent (THE HEADLINE BUILD)

**Goal:** a user completes an entire analysis with **zero data leaving the
device** — no ChatGPT, no account, offline-capable. An optional in-browser LLM
drives Airlock's existing WebMCP tools through the same propose → approve →
commit gate.

This is the single biggest lever for "people are amazed." Spec it properly
(`requirements.md` → `design.md` → `tasks.md` in `.kiro/specs/local-agent/` or
equivalent) before writing code, because it touches the agent layer.

### 1.1 — The local model runtime

**Build:**
- Add `@mlc-ai/web-llm` (Apache-2.0). WebGPU required; feature-detect and fall
  back gracefully (see 1.4).
- **Self-host the weights.** Do not fetch from a CDN or HuggingFace at runtime —
  that breaks the zero-egress guarantee. Options, in order of preference:
  1. Bundle a small quantized model as a first-class asset served same-origin.
  2. If bundle size forbids that, a **one-time, explicitly-disclosed** download
     to Cache API / OPFS, gated behind a clear consent step (see 1.3), after
     which the app is fully offline. The egress monitor must show this download
     as a distinct, expected, one-time event — never hidden.
- Curated model list (start with one, add more later): Qwen2.5-3B-Instruct
  q4f16_1 as the default; Llama-3.2-3B-Instruct as an alternative; a ~1B option
  for weak GPUs.
- Expose a `LocalModelStore` (subscribable, same pattern as `activityLog` /
  `reportStore`): `status: "unavailable" | "not-downloaded" | "downloading" |
  "ready" | "running"`, `progress`, `activeModel`, `download()`, `unload()`.

**Files (new):** `apps/airlock/src/agent/localModel/runtime.ts`,
`localModel/models.ts`, `localModel/store.ts`.

### 1.2 — The local agent loop

**Build:**
- A `LocalAgent` that is a **WebMCP client**: it reads the tool list from
  `document.modelContext` (the polyfill's registered tools — the same ones
  ChatGPT would see) and runs a tool-calling loop against the local model.
- Loop: system prompt (Airlock's role + the non-negotiables in model-facing
  language) → user goal → model emits tool calls → execute via the model context
  → feed results back → repeat until the model produces a final answer or hits a
  step cap (default 12).
- `propose_*` calls behave exactly as with a cloud agent: they stage a diff and
  **stop** — the loop surfaces "waiting for your approval" and does not spin.
  When the human approves in `ReviewPanel`, the loop resumes with the commit
  result.
- Every model tool call still flows through `read()` / `stage()` in `tools.tsx`,
  so the activity ledger is populated identically. No new logging path.
- Robustness for small models: constrain tool-call output with the model's
  structured/JSON mode; on a malformed call, return a corrective tool result
  ("your last call was not valid JSON, retry") rather than crashing; cap retries.

**Files (new):** `apps/airlock/src/agent/localModel/agent.ts`,
`localModel/systemPrompt.ts`. **Touches:** `agent/tools.tsx` only if the tool
list needs a machine-readable export (prefer reading from the model context).

### 1.3 — Model-download UX (make it dead simple)

**Build:**
- First time a user picks "Run locally," show a single clear panel:
  "Airlock will download <model> (~<size>) once. After that it runs entirely on
  your device, offline. Nothing about your data is involved in this download."
  One button: **Download & run locally.**
- Progress bar wired to `LocalModelStore.progress`. Cancelable. Resumable.
- Once cached: the choice is remembered; subsequent sessions show "Local model
  ready" with a one-click load.
- A tiny hardware check up front: "Your GPU: <adapter>. Estimated speed:
  <fast/usable/slow>." If WebGPU is absent, say so and offer the fallback.
- Settings: switch model, delete downloaded weights (frees disk), see exact
  cache size.

**Files (new):** `apps/airlock/src/components/LocalModelPanel.tsx`,
`components/ModelDownloadDialog.tsx`. **Touches:** `components/TopBar.tsx` or
`RightRail.tsx` for the entry point, `engine/uiStore.ts` for panel state.

### 1.4 — Mode selection and honest status

**Build:**
- Three agent modes, user-visible and switchable:
  1. **Local** — in-browser model. Badge: "Fully local · 0 bytes out."
  2. **Cloud (WebMCP host)** — ChatGPT / Chrome native. Badge: "Slices of
     queried data go to <host>." with a link to the ledger.
  3. **Bring-your-own-endpoint** — user pastes a private OpenAI-compatible URL +
     key (their company's Azure/Bedrock). Badge names the host. (Stub the UI now,
     wire fully in Tier 2 if time.)
- The Seal (`SealStatus.tsx`) and `WebMCPStatus.tsx` reflect the active mode.
  In Local mode after model load, Seal must genuinely read 0 external.
- No WebGPU → Local mode disabled with a plain-language reason; Cloud mode still
  works. The product must not hard-depend on WebMCP _or_ WebGPU alone.

**Files:** `apps/airlock/src/components/SealStatus.tsx`,
`components/WebMCPStatus.tsx`, `engine/uiStore.ts`, new
`agent/agentMode.ts`.

### 1.5 — The demo path

**Build:** a scripted "airplane mode" flow that works end to end:
load `public/demo/compensation.csv` → Local mode → "find pay gaps by gender, flag
anyone >15% below market, write a one-paragraph summary" → agent runs read tools,
proposes a flag set + a chart + a report → human approves each → done, Seal at 0.

**Acceptance (Tier 1):**
- With the network throttled to **offline** in DevTools (after model cache), the
  full demo path completes: reads, proposals, approvals, a committed flag set,
  chart, and report.
- Egress monitor shows **0 external requests** during the entire local session
  (the one-time model download happens before, is labeled, and is the only
  network event ever attributable to the model).
- A `propose_*` from the local model stops and waits; approving in `ReviewPanel`
  resumes the loop; the ledger shows `propose` then `commit` with the same
  `proposalId`.
- Malformed tool output from the model is recovered, not fatal (test with a
  forced bad response).
- WebGPU-absent browser: Local mode is cleanly disabled, Cloud mode unaffected,
  no console errors.
- Bundle/asset check: `/code-review high` confirms no runtime fetch to a
  third-party origin for weights or library code.

**Non-goals:** multi-model orchestration, fine-tuning, streaming token UI polish
(basic is fine), RAG over documents, non-tabular data.

---

## TIER 2 — The moat (demo → product)

Sequence these by which buyer you are chasing. #1 first — highest credibility per
hour and it compounds.

### 2.1 — Verifiable trust receipt

**Goal:** after a session, one click produces a signed, portable
**data-handling attestation** a compliance reviewer accepts in place of "trust
me."

**Build:**
- Collect: session id + timestamps; dataset name + SHA-256 of the raw bytes (and
  row/column counts — never the values); every tool call from `activityLog`
  (tool, args, summary, rows/columns disclosed); the agent mode(s) used and, for
  cloud, which host and the exact `rows disclosed` / `distinct columns` totals;
  egress-monitor final state (external requests, bytes, hosts); the model id and
  where it ran; app version + git SHA.
- Canonicalize to stable JSON. Sign it: generate an Ed25519 keypair in
  `crypto.subtle` per install (persisted), sign the canonical bytes, embed the
  public key + signature. Optionally chain entries (hash of previous receipt) so
  a sequence is tamper-evident.
- Export as (a) `airlock-attestation-<date>.json` and (b) a human-readable
  one-page PDF/printable HTML with the same content and a verification snippet.
- A standalone `verify` page (offline, no dependencies) that re-checks a receipt
  file's signature and hash chain.

**Files (new):** `apps/airlock/src/lib/attestation.ts`, `lib/signing.ts`,
`components/AttestationPanel.tsx`, `public/verify.html`. **Reads:**
`agent/activity.ts`, `lib/egress.ts`, `agent/agentMode.ts`.

**Acceptance:** a completed session exports a receipt; the verify page confirms
signature + hashes; editing any field breaks verification; the receipt never
contains a raw cell value.

### 2.2 — Redaction + local model = provable blindfolding

**Goal:** the existing redaction feature (`feat/redaction`) becomes _provable_:
with a local model, "the agent cannot recover redacted values" is a fact, not a
hope.

**Build:**
- Redaction is applied at `buildViewSql` so redacted columns are hashed/masked
  before any tool can read them — including the local agent's reads.
- The attestation (2.1) records which columns were redacted and that the model
  ran locally, so the receipt states "columns X, Y were never exposed to any
  model."
- UI: a redacted column is visibly marked in the grid and in every tool preview.

**Files:** `engine/datasetStore.ts` (`buildViewSql`), `agent/tools.tsx`
(previews), plus `feat/redaction`'s components. Coordinate ownership in COLLAB.

**Acceptance:** a redacted column returns only masked values through every read
tool and `run_sql`; the attestation asserts non-exposure; a test proves the raw
value is unreachable via the tool surface.

### 2.3 — Provenance-linked reports

**Goal:** every claim in an agent-written report links to the exact query that
produced it — analyst-grade defensibility.

**Build:**
- Extend `write_report` so the agent must attach, per finding, the `run_sql` /
  tool call id from the ledger that supports it.
- Report renderer shows each claim with a "source" affordance that opens the
  query + its result snapshot.
- Ties into 2.1: the receipt can include the report and its provenance links.

**Files:** `agent/reports.ts`, `agent/tools.tsx` (`write_report` schema),
`components/ReportPanel.tsx`, `agent/previews.tsx`.

**Acceptance:** a generated report has a resolvable source link per numeric
claim; a claim with no backing query is rejected at propose time.

### 2.4 — Local multi-source (real work is never one CSV)

**Goal:** bring in data from where it actually lives, without breaking the egress
boundary.

**Build (in priority order):**
- **File System Access API**: pick a local folder, see every CSV/Parquet/XLSX in
  it, query across them. Large files stream from disk, not memory.
- **Local Postgres / DuckDB file**: a documented localhost proxy pattern — the
  proxy runs on the user's machine, Airlock talks to `localhost` only, the Seal
  still reads 0 _external_. Ship the proxy as a tiny self-contained binary/script.
- **Google Sheet**: import via the user's own paste/export, or an explicitly
  consented one-shot fetch that the ledger records (this one does touch the
  network — label it unmistakably).

**Files (new):** `engine/sources/` directory,
`engine/workspaceStore.ts` (multi-source registry), `components/SourcePicker.tsx`.

**Acceptance:** query joins across two files from a picked folder with no upload;
the localhost-proxy path keeps Seal external at 0; any networked source is
labeled and ledgered.

---

## Final sequencing

1. **Tier 0** now — protect the base, ship the submission.
2. **Tier 1** — spec (`requirements → design → tasks`), then build. This is the
   headline. Coordinate the agent-layer ownership in COLLAB before starting.
3. **Tier 2.1 (trust receipt)** — immediately after Tier 1.
4. **Tier 2.2 → 2.3 → 2.4** — by buyer priority; each is independently shippable.

After every Tier: green build + tests, `/code-review high`, `/graphify . --update`,
update `docs/NORTH_STAR.md` §7 status, append to COLLAB Message Log.

## Global non-goals (do not build these without a new decision)

- A hosted backend, accounts, or any server that sees user data.
- Mobile-native apps.
- Non-tabular analysis (docs, images, audio).
- A marketplace, plugin system, or public API.
- Horizontal "templates for every department" — one vertical, deep, first.
