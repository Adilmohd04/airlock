# GLM handoff — Airlock status after the 2026-09-02 session

_Continuation brief for the next agent (Claude). Read `docs/GLM_WORKLOG.md`
(the running log) alongside this. Kickoff: `docs/GLM_KICKOFF_PROMPT.md`._

---

## One-paragraph state

The kickoff's Tasks 1–3 are DONE and the Task 2 live proof is ~80% done on a
real Intel iGPU: **https://airlock-webmcp.netlify.app is live with the full
1.5B weights served same-origin** (all 35 files verified byte-for-byte,
headers green), `webmcp-staged` is a **transport-agnostic v0.2.0** (WebMCP +
OpenAI tool-loop + plain-MCP adapters, 505 total tests green, NOT published),
and god mode was **proven on-device** on this machine: consent → 840 MB
same-origin download → Qwen2.5-1.5B resident on the GPU → "Fully local · 0
bytes out" → the local agent loop driving the WebMCP tools. Two real defects
were found BY the demo and fixed (see below). Remaining: finish one complete
agent run on camera (approve the staged diffs), export + verify the
attestation, redeploy the two fixes, and the whitepaper (Task 4).

## Git state — IMPORTANT: `main` and `origin/main` have DIVERGED

- Local `main` = the mission line: god mode (T1-b) + attestation (T2.1) +
  redaction security port + SAA package + two demo-driven fixes.
- `origin/main` = the 09-01 overnight dispatcher line (GitHub has it): redaction
  leak fixes (PORTED — see below), keyboard UX, deploy fixes, README/devpost.
- Merge base `b6ea228`. Local is ahead 27, behind 21. A plain `git push`
  will be REJECTED.
- **Do NOT `git pull` blindly** and do NOT force anything. Recipe:
  1. `git merge origin/main` on a throwaway branch.
  2. Expect conflicts: `COLLAB.md` (local rewrote it; remote appended entries —
     resolve append-only, keep both), `apps/airlock/src/engine/duckdb.ts` +
     `sqlGuard.test.ts` (KEEP LOCAL — the single-pass lexer supersedes the
     remote comment-ordering patch; the remote line even rejects URL-shaped
     *data* in comments, a false positive), `netlify.toml`/`_headers` (keep
     local's — it has the /models/* rules), README/submission docs (prefer
     whichever reads true after god mode; local's is older, remote's predates
     Tier 1).
  3. Run all three gates, then FF-merge to main and push.
- What was DELIBERATELY cherry-picked from origin/main already:
  `f0edd9f` + `cebbaa0` (critical redaction stale-filter leak) — landed as
  `3a493f5` with 4 regression tests. Nothing else from that line was taken.

## What is DONE (all on local `main`, gates green)

1. **T2.1 merged** (`0c85159`): PROTOCOL.md (SAA v0.1), signing.ts, attestation.ts,
   verify.html (offline verifier), AttestationPanel. 477 tests.
2. **Redaction leak port** (`3a493f5`): `referencesRedaction()` public; filters
   scrubbed from `buildAgentViewSql` + 5 tool-response sites; 4 regression
   tests. 481 tests.
3. **webmcp-staged v0.2.0 transport-agnostic** (`94f9c5b`, `2da2c27`):
   `src/authority.ts` (StagedAuthority engine), `src/store.ts` (ProposalStore
   moved verbatim), core.ts = thin WebMCP binding (public API unchanged —
   commitGate.test.ts passes UNMODIFIED), `src/openai.ts` (toOpenAITools /
   toOpenAICommitTools / executeOpenAIToolCall — never throws, corrective
   retry text, STAGED_AUTHORITY_PROMPT), `src/mcp.ts` (no SDK dep), 3 examples,
   real README. One hardening: cross-action commits denied + audited.
   **Do not publish to npm without the owner's OK.**
4. **Netlify**: site `airlock-webmcp` (`https://airlock-webmcp.netlify.app`),
   created via API (CLI v27's monorepo prompt can't be scripted; deploy with
   `npx netlify deploy --prod --site 23178ab9-0013-4b4a-84dd-01390b689090
   --dir <ABS path to apps/airlock/dist> --no-build` **from outside the git
   repo** e.g. %TEMP%). Netlify auth is logged in on this machine (token in
   %APPDATA%/netlify/Config/config.json). Weights: `node scripts/fetch-models.mjs
   --deploy` (already on disk: apps/airlock/public/models/, 841 MB, gitignored).
5. **Demo-driven fixes on `fix/local-model-hosting-fallback`** (merge after gates):
   - `store.ts` — hosting-probe fallback through the catalog (deploy default
     first) when the selected model isn't mirrored; 2 new tests (45/45 in
     store.test.ts). This killed the bogus "Local unavailable" /
     "/models/ returned HTML" reports on deploys that mirror only the 1.5B.
   - `agent.ts` — `STEP_DEADLINE_MS` 90s → 240s (measured: Intel gen-12lp runs
     ~5-10 tok/s; 90s aborted 640-token turns mid-JSON and read as "malformed
     output"). Documented in the comment.
   - `scripts/serve-dist.mjs` — dist server with production headers for the
     127.0.0.1 demo (WebLLM refuses to cache `localhost` URLs).

## The live demo — what worked, what's left (Task 2b)

WORKED (verified, on 127.0.0.1:4173 via scripts/serve-dist.mjs in a real
WebGPU Chrome — WebGPU IS available on this iGPU, `shader-f16: true`):
consent → 840 MB download counted as same-origin asset loads (36 fetches,
881 MB, external requests: 0 — verified via performance entries) → "Fully
local · 0 bytes out" → model resident → local agent loop drove the tools
(get_dataset_summary etc. in the ledger) → propose-loop halt/resume machinery
exercised (an earlier run hit the old deadline bug and recovered/stopped
honestly — keep that in the writeup as the honesty layer working).

LEFT:
1. One complete run on camera: load `demo/compensation.csv` → Local mode →
   "Find pay gaps by gender, flag anyone paid more than 15% below their market
   median, and write a one-paragraph summary." → approve each staged diff in
   the review queue → Seal reads 0 the whole time. Budget ~10-20 min on the
   iGPU (steps are slow; the 240s deadline is intentional).
2. Export the attestation (TopBar → Attestation) and verify it at /verify.html
   (offline page, same origin). Save the receipt JSON into docs/ as evidence.
3. Redeploy with the two fixes + re-verify the live URL.
4. Cloud-mode check: the built-in Agent console already exercises the same
   tools; for a native host enable chrome://flags/#enable-webmcp-testing (user
   asked for this) or open the URL in ChatGPT desktop. BYO-endpoint mode is
   still a stub (user asked; it needs an honest egress story — bytes to their
   endpoint are NOT zero and the Seal/ledger must say so).
5. User-requested feature (assess honestly vs NORTH_STAR's non-tabular
   non-goal): multi-file upload — PDF/DOCX/images/video. PDF/DOCX→text-table
   via self-hosted parsers (pdfjs/mammoth) keeps zero-egress; images/video do
   NOT fit the DuckDB tabular thesis — say so rather than fake it.

## Harness

- CDP driver: `%TEMP%/cdp/cdp.mjs` (ws installed there) against a dedicated
  Chrome profile `--user-data-dir=%TEMP%/chrome-airlock
  --remote-debugging-port=9222`. The debug port intermittently dies — relaunch
  and reconnect. Target selection pins `127.0.0.1:4173`.
- Screenshots via `node cdp.mjs shot out.png`; DPR is 1.5 (screenshot px ÷ 1.5
  = CSS px for Input.dispatchMouseEvent).
- Gates: `npm run build` · `npm run typecheck --workspace apps/airlock` ·
  `npm test` (expected 476 airlock + 29 webmcp-staged + 2 in store.test.ts).
- `docs/GLM_WORKLOG.md` is the source of truth — append, never rewrite.

## Honesty rules that remain binding

Never state a privacy claim the egress monitor or ledger can contradict; the
receipt contains no raw values; `verify.html`'s canonicalize stays
byte-identical to signing.ts; `agent/tools.tsx` registration surface frozen;
webmcp-staged extended, never rewritten; no npm publish without the owner.
