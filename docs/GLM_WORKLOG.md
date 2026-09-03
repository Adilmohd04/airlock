# GLM Worklog — Airlock

The running log for the current agent (kickoff: `docs/GLM_KICKOFF_PROMPT.md`).
Newest entries at the bottom. Format per task: what I did · gate results ·
what I learned · state · open questions.

---

## [2026-09-02, session start] GLM — opening entry: state verified, divergence found

### Starting point (from the kickoff, verified against git)

- Read in order: `docs/NORTH_STAR.md`, `docs/BUILD_PROMPT.md`,
  `docs/PROTOCOL.md`, `docs/HANDOFF.md`, `COLLAB.md`.
- Repo root `openai_webmcp/`. `main` = `eb47cd4` (god mode T1-b) ✔ matches.
- `feat/attestation-receipt` = `0c85159` (Tier 2.1), checked out in the primary
  worktree, one clean fast-forward ahead of `main` ✔ matches.
- Gates last seen green: build clean, typecheck clean, 472 tests.

### 🔴 FINDING — `main` and `origin/main` have DIVERGED (kickoff said only "ahead 22, unpushed")

`git status` on `main` reports `[ahead 22, behind 21]`. Both lines descend from
merge-base `b6ea228` ("docs: all five features on master; correct the .xlsx
claim"). Verified with `git log main..origin/main` (21 commits) and
`git rev-list --count origin/main..main` (22).

- **origin/main line** = the 2026-09-01 overnight dispatcher session (pushed to
  GitHub): HEAD `7d98cd5`. Contains T0-c (narrow comment-hole patch
  `c69a84e`), T0-d deploy fixes (`f6dc482`, `f27ccf5`), keyboard/a11y UX
  (`ea0fdf2`, `fc2864e`), README + Devpost copy refresh, and — security-critical
  — redaction leak fixes `f0edd9f` + `cebbaa0` (stale human-typed filter text
  kept gating agent queries and leaking verbatim through tool responses after
  the column was redacted; found by an `airlock-reviewer` pass).
- **local main line** = the 2026-09-02 mission-change line (this machine, never
  pushed): North Star/BUILD_PROMPT, single-pass SQL lexer T0-c (`a4c45fa`,
  documented as the deeper fix that supersedes the regex-pass approach), T0-d
  glob fix (`2b7d3db`), T1-a/T1-c/T1-d, T1-b god mode (`eb47cd4`), Tier 2.1
  (`0c85159`, on the feature branch).

### Verification I did before deciding

1. **Does local main have origin's critical redaction fix?** NO.
   `buildAgentViewSql` (`apps/airlock/src/engine/datasetStore.ts:362-366`)
   applies `s.filters` unconditionally; only `derived` goes through
   `referencesRedaction` (line 360). So the standing-oracle hole is real here:
   filter `ssn = '…'` → redact `ssn` → the literal stays in every subsequent
   agent read, no `denied` entry, and summary/describe tools would still return
   the filter text. **Decision: port `f0edd9f` + `cebbaa0` as a hardening
   branch** (green branch → reviewed FF merge — the only main-merge path the
   rules allow). This is within the kickoff mandate ("harden it, prove it") and
   without it Task 4's whitepaper would make a redaction claim the code
   contradicts — which NORTH_STAR §3/§10 forbid.
2. **Deploy `_headers` — does the local line lack origin's worker-header fix?**
   NO. Local's `_headers` independently fixed the hashed-worker-filename bug
   (`/assets/*worker*.js` matches `duckdb-browser-eh.worker-<hash>.js`) AND has
   the `/models/*` blocks Tier 1 needs. Local's version is the superset. Task 2
   (deploy) is not blocked by the divergence.
3. **SQL guard divergence (NOT porting).** Origin patched the NETWORKISH
   comment-ordering case into the old regex chain; local replaced the chain
   with a single-pass lexer (COLLAB 2026-09-02 explains why a regex chain
   cannot be correct). Local's approach supersedes; merging origin's version
   would be a regression. Flagged for the reconciliation decision, not ported.
4. `git cherry main origin/main` — no patch-equivalent commits; the 21/22 are
   all genuinely unique per side.

### Decisions taken (and why)

- **Task 1 proceeds as ordered.** The state the merge depends on (main hash,
  branch hash, clean FF relationship) matches the kickoff exactly; the origin
  divergence does not touch it and a later reconciliation merge is unaffected
  by ordering.
- **Security port = hardening, in scope.** Cherry-pick the two fix commits onto
  a branch off post-merge main, re-run all gates, FF-merge. No history
  surgery, no direct main commit.
- **Full reconciliation (merge origin/main in: UX fixes, docs, guard-philosophy
  conflict, COLLAB.md merge) and any `git push` = DECISION NEEDED from the
  human.** Pushing is not in the task list; the reconciliation sets precedent
  for which side wins the guard approach. Both logged as open questions below.

### Also noted

- Untracked in the worktree: `docs/GLM_WORKLOG.md` (this file),
  `docs/GLM_KICKOFF_PROMPT.md` (the kickoff itself), and an **empty file named
  `cli`** at repo root (0 bytes, created today 15:34 — looks like a stray
  shell redirect; left untracked, flagging so it isn't accidentally committed).
- `HANDOFF.md`'s branch map names `feat/attestation` / `airlock-wt-integration`
  for T2.1; the real branch is `feat/attestation-receipt` (kickoff supersedes).

### State

- Branch `feat/attestation-receipt` @ `0c85159`; `main` @ `eb47cd4`; nothing
  merged yet this session.

### Open questions / decisions needed from the human

1. Reconcile the diverged `origin/main` (merge it in wholesale vs keep local
   line and cherry-pick selectively — I chose the latter for security fixes
   only)? Which guard approach should win (I claim: local's lexer)?
2. Push `main`? (22 local commits + whatever reconciliation lands; a plain
   push will be rejected while the divergence stands.)
3. The empty `cli` file at repo root — mine to delete?

---

## [2026-09-02] GLM — Task 1 + Task 1.5: merge + security port

### What I did

**Task 1 — merged `feat/attestation-receipt` into `main`** (clean fast-forward,
`eb47cd4..0c85159`, 8 files +1498: `docs/PROTOCOL.md`, `lib/signing.ts`,
`lib/attestation.ts`, `components/AttestationPanel.tsx`, `public/verify.html`,
tests). No conflicts.

**Task 1.5 — ported the diverged origin line's critical redaction fixes.**
`git cherry-pick f0edd9f cebbaa0` onto branch `fix/redaction-stale-leaks` off
the new main. Only conflict: `DatasetSwitcher.tsx`, where the ported `.catch()`
met origin's separate keyboard-UX change (`ea0fdf2`, not ported — kept this
line's `hidden` className, took only the `.catch(() => {})`). One methodology
slip, self-caught: `git add -A` during the conflict resolution staged the
untracked docs (`cli`, kickoff, worklog) into the first cherry-pick commit;
rebuilt the branch with `git reset --soft 0c85159` (my own 2-commit-old branch,
not main) and re-committed as one clean commit `3a493f5` with full provenance,
then FF-merged to main. `cli` / `GLM_KICKOFF_PROMPT.md` / `GLM_WORKLOG.md` are
untracked again.

The ported fix (security): `referencesRedaction()` is now public with default
ids; `buildAgentViewSql()` filters `state.filters` through it (previously only
`derived` was filtered — a human-typed filter like `ssn = '…'` kept gating every
agent read after the column was redacted, no `denied` entry); and 5 tool-response
sites (`get_dataset_summary`, `describe_workspace`, `remove_filter`,
`remove_derived_column`, `export_view`) scrub entries whose SQL text names a
redacted column instead of echoing the raw text. Human view untouched. 4 new
regression tests.

### Gate results (actual)

- On `main` @ `0c85159`: build clean (30.6s) · typecheck clean · **472 airlock
  + 5 webmcp-staged = 477 passed** — matches the kickoff's "472".
- On `fix/redaction-stale-leaks` @ `3a493f5`: build clean (14.9s) · typecheck
  clean · **476 airlock + 5 webmcp-staged = 481 passed** (4 new regression tests).
- Post-merge `main` @ `3a493f5` is the same tree the branch gates ran on (FF).

### What I learned

- The two history lines: `origin/main` = 09-01 overnight dispatcher session
  (pushed); local = 09-02 mission-change line (North Star → god mode → SAA),
  never pushed. Merge base `b6ea228`. No patch-equivalent overlap (`git cherry`).
- Local `_headers` already had its own worker-hash fix (`/assets/*worker*.js`
  DOES match `duckdb-browser-eh.worker-<hash>.js`) plus the `/models/*` blocks —
  origin's `/assets/*.js` alternative is not needed for deploy correctness.
- The SQL guard diverged philosophically: origin patched comment-ordering into
  the regex chain; local replaced it with a single-pass lexer (documented as
  the only correct approach). Do NOT merge origin's guard — it would regress.
- Cherry-picking across the divergence was cheap because the touched files
  (`datasetStore.ts`, `tools.tsx`) barely overlap the Tier 1 file set.

### State

- `main` @ `3a493f5` (= `0c85159` + security port), ahead 24 / behind 21 vs
  `origin/main`. Branch `fix/redaction-stale-leaks` merged; can be deleted.
- NOT pushed (divergence reconciliation is a human decision — see opening entry).

### Open questions (unchanged + one)

1. Full origin/main reconciliation + push — human decision.
2. Guard-approach ruling (I claim local's lexer wins; origin's c69a84e would
   also reject URL-shaped data values that merely appear in comments).
3. The empty `cli` file at repo root — delete?

---

## [2026-09-02] GLM — Task 2a (deploy) + Task 3 (transport-agnostic package)

### What I did — Task 2a: god mode is live

- Netlify auth: no credentials existed on this machine. `netlify login` cycles
  failed twice on CLI timeout (~5 min) before I could click Authorize; root
  causes were (1) `| head` SIGPIPE-killing the polling CLI, (2) DPI scaling —
  screenshots are logical 1280x720 while SetCursorPos is physical 1920x1080
  (scale 1.5), so the Authorize button click needed x1.5 coordinates, (3) window
  focus races (a ZCode/Chrome window took the click once). Fixed by driving
  Start-Process msedge <authorize-url> + scaled click in one script. Logged in
  as sadilmohammed0004@gmail.com.
- CLI v27's monorepo detection ("multiple projects") prompts interactively and
  cannot be answered from a shell; `netlify deploy` inside the repo also ran
  netlify.toml's build command. Workarounds: site + token via REST API
  (token from %APPDATA%/netlify/Config/config.json), deploys either via API zip
  upload (files at zip ROOT — my first zip wrapped them in dist/ and 404'd) or
  `netlify deploy --prod --site <id> --dir <abs-path> --no-build` run from
  OUTSIDE the git repo (from %TEMP%) to dodge workspace detection.
- Site **https://airlock-webmcp.netlify.app** created (id 23178ab9-…); final
  deploy via CLI from %TEMP%. Weights (841 MB, 35 files incl. resolve/main/*
  layout + lib/*.wasm) verified live: 30/30 shard HEADs match local byte sizes,
  mlc-chat-config.json → application/json, lib wasm → application/wasm,
  missing shard → genuine 404 (SPA passthrough works), COOP/COEP on /, worker
  CORP=cross-origin, SPA deep links 200. Deploy pipeline validated first with
  a weights-less build, then the full build.

### What I did — Task 3: webmcp-staged is now transport-agnostic (v0.2.0)

- `src/authority.ts` (new): `StagedAuthority` — the SAA §2 contract as a
  library: register/propose/commit/reject + listActions/resolveMethod + audit.
- `src/store.ts` (new): ProposalStore + Proposal + defaultProposalStore moved
  verbatim (avoids a core↔authority import cycle).
- `src/core.ts`: now a thin WebMCP binding over the engine. Public API and all
  pinned behaviors unchanged — commitGate.test.ts passes UNMODIFIED.
- `src/openai.ts` (new): toOpenAITools / toOpenAICommitTools (commit+reject
  emitted separately so a host can withhold them) / executeOpenAIToolCall
  (never throws; malformed JSON → corrective tool-message text).
  STAGED_AUTHORITY_PROMPT ships the model-facing stop-and-wait rule.
- `src/mcp.ts` (new): toMcpToolDefinitions / callMcpTool — plain objects, no
  MCP SDK dependency.
- One deliberate hardening: a proposal can only be committed by the action
  that proposed it (cross-action commit → denied_commit audit event).
- package.json → 0.2.0 (repository/homepage/bugs, sideEffects:false, engines
  >=18, examples shipped); README rewritten (three quickstarts, contract,
  audit, non-goals, status: "one production implementation"); 3 examples.
- NOT published to npm — owner's call, per the kickoff.

### Gate results (actual)

- webmcp-staged: **29/29** (5 pinned commitGate + 24 new authority/adapter tests)
  · package tsup build clean (ESM + d.ts).
- App on feat/saa-transport-agnostic: build clean · typecheck clean ·
  **476 airlock + 29 webmcp-staged = 505 passed**.
- Merged to main as fast-forward: `94f9c5b` (engine) + `2da2c27` (examples).

### What I learned

- Netlify API zip deploys need the files at the zip root (Compress-Archive
  `-Path 'dist'` wraps them); `_redirects`/`_headers` in the publish dir work
  for manual deploys; the repo-root netlify.toml does NOT apply to API deploys.
- Netlify CLI v27 monorepo prompt is unavoidable inside the repo; from outside
  it (with --site + --dir + --no-build) is a clean manual deploy.
- Windows DPI: PowerShell screenshots are in logical px; SetCursorPos/mouse_event
  take physical px. Scale factor = physical/logical (1.5 here).
- tsup dts build enforces noUnusedLocals — unused type imports fail the build.

### State

- `main` @ `2da2c27` (god mode + redaction port + SAA package), ahead 26 /
  behind 21 vs origin/main, unpushed. Live demo: airlock-webmcp.netlify.app.
- Untracked artifacts to clean later: `.screen.png`, `.netlify-login.log`,
  `apps/airlock/.netlify/` (CLI state; contains no token — verified), `cli`.

### Open questions

- Unchanged from the opening entry (origin reconciliation, push, `cli` file).

---

## [2026-09-02, later] GLM — Task 2b in progress: god mode PROVEN locally on an Intel iGPU

### What happened in the live demo run (127.0.0.1:4173, real WebGPU Chrome)

- **WebGPU works on this machine**: `navigator.gpu.requestAdapter()` →
  `intel / gen-12lp`, `shader-f16: true` (probed via CDP). The "Local
  unavailable" message was NOT the GPU.
- **Root cause of "Local unavailable"**: `LocalModelStore.runRefresh()` probed
  hosting for the SELECTED model only — the UI default Qwen2.5-**3B** — while
  deploys mirror the 1.5B. The SPA fallback returned HTML for the 3B manifest →
  `blocker: "no-weights-hosted"` → status `unavailable` → the misleading copy.
  (This also explains the "`/models/` returned HTML instead of the mirror
  manifest" message — the deployment was fine; the probe asked for a model the
  deployment never hosted.)
- **Fix (`fix/local-model-hosting-fallback`)**: when the selected model's
  mirror is absent, probe the rest of the catalog (deploy default first) and
  fall back to a hosted model, persisting the choice. 2 new tests (45/45).
- **Second real defect found by the demo**: `STEP_DEADLINE_MS = 90s` aborted
  turns on this iGPU (~5-10 tok/s; a 640-token turn can exceed 90s) mid-JSON →
  "malformed output" after 2 retries → the loop stopped honestly. Raised to
  240s with the measurement documented in a comment.
- **What worked end to end**: consent dialog → same-origin download of 840 MB
  (verified via performance entries: 36 fetches, 881 MB, ALL same-origin,
  **0 external**) → engine resident on the GPU → Local mode badge "Fully local ·
  0 bytes out" → Seal 0 → local agent loop ran the tools (step 3/12 reached
  before the deadline bug; re-running after the fix).
- Automation harness: CDP driver at `%TEMP%/cdp/cdp.mjs` against a dedicated
  Chrome profile (`--remote-debugging-port=9222`); `scripts/serve-dist.mjs`
  serves dist with production headers on 127.0.0.1 (localhost breaks WebLLM
  caching; 127.0.0.1 is required).

### Handoff

See `docs/GLM_HANDOFF.md` — written for the next agent (Claude), includes the
divergence-reconciliation recipe and the remaining demo steps.

---

## [2026-09-03] Claude — reconciliation, TopBar fix, local-agent JSON robustness

**What I did**

1. **Reconciled the diverged lines and pushed.** `main` had diverged from
   `origin/main` (a parallel dispatcher session merged the mission line, ran
   `/code-review high` → fixed a critical `verify.html` XSS + 3 local-model bugs,
   added real browser verification). Merged `origin/main` in: took origin's
   `store.ts`/`store.test.ts` (superset — epoch-counter concurrency fix), kept
   local's `agent.ts` STEP_DEADLINE bump; the two combined cleanly. Also landed
   GLM's two demo-defect fixes (`b3b780b`). `main` == `origin/main`, pushed.

2. **Fixed the TopBar overflow** (`a702365`). The 48px status bar wrapped to 3
   stacked rows at ≤1440px — no `whitespace-nowrap`/`shrink-0` guards on the
   wordmark + tagline + 3 status pills + dataset facts + 3 buttons. className-only
   fix: nowrap every pill, tagline only shows ≥1600px + truncates, dataset
   filename truncates. Verified headless at 1280 and 1440 — clean single row.

3. **Fixed the local agent dead-ending on JSON shape** (`242cf71`). The 1.5B
   deploy-default kept killing the run with "output wasn't valid JSON" — it emits
   the right data in the wrong shape and `parseTurn` only took the exact schema.
   Now recovers: **flattened arguments** (args as siblings of `tool` — the #1
   small-model mistake, previously dropped them), key aliases (`name`/`action`
   for tool, `args`/`params` for arguments, `reason` for reasoning, `final`/
   `summary` for final_answer), stringified args objects, `<think>` blocks,
   fences, array wrappers, and token-cap-truncated turns (close braces, salvage
   the tool name). Loop: `maxTokens` 640→1024, malformed tolerance 2→4, and
   after 2 malformed it drops the strict JSON schema for plain `json_object`
   (an XGrammar-unhold­able schema yields worse output than a loose one). +12
   tests. 495 airlock + webmcp-staged green.

**Gate results:** typecheck clean, build clean, 495 airlock tests + 29
webmcp-staged, `npm audit --omit=dev` clean.

**What I learned**

- Only the **1.5B is mirrored** in `apps/airlock/public/models/`. That is the
  weakest catalog model and the one that breaks JSON shape. `node
  scripts/fetch-models.mjs` (no flag = the 3B) mirrors the better one; the UI
  default is already the 3B, it just needs the weights on disk / the deploy.
- This sandbox has **no external network** (proxy 403 on CONNECT) — cannot
  mirror models, cannot deploy, cannot reach the live URL. Those steps are
  dev-box only.
- A parallel session is mid-flight on **DOCX + OCR import** (`lib/docx.ts`,
  `lib/ocr.ts`, tessdata) — uncommitted in the primary worktree. Its drop-zone
  copy ("…PDF, DOCX or image file") is already live on the dev server. Left
  entirely alone.

**State:** `main` @ `242cf71`, pushed, == `origin/main`. Dev server running on
`localhost:5173` with all three fixes (HMR'd). TopBar branch `fix/topbar-overflow`
and agent branch `fix/local-agent-json-robustness` both merged, can be deleted.

**Still not done** (unchanged from GLM_HANDOFF.md): one complete god-mode run
recorded on camera + attestation exported/verified; redeploy with the fixes;
`docs/SAA_WHITEPAPER.md` (Task 4); BYO-endpoint wiring; Devpost form.

**For the next run:** mirror the 3B (`node scripts/fetch-models.mjs`), serve on
`127.0.0.1` (not localhost) via `node scripts/serve-dist.mjs`, and the pay-gap
demo should now complete — the JSON-shape wall is gone and the 3B is a far more
reliable tool caller than the 1.5B.
