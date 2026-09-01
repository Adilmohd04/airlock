# Airlock: Devpost Submission Checklist

**Challenge:** OpenAI WebMCP Challenge
**Submission Deadline:** September 3, 2026, 1:00 PM PT
**Status:** Copy and script ready. Live URL, video and screenshots are not yet
produced (human-owned, see "Still blocked" at the bottom).

---

## Required Fields

- [x] **Project Title**
  - **Value:** Airlock: Agent-Native Data Workspace

- [ ] **Tagline** (Devpost caps this around 60 characters, verify the exact
      limit on the actual form field before submitting)
  - **Value:** "Analyze private data with AI. Never leaves your browser."
  - **Length:** 56 characters, checked by hand, not copied from a stale draft.

- [ ] **Category**
  - **Proposed value:** AI/ML (or whatever category label the WebMCP
    Challenge's own Devpost page actually offers). **Not verified against the
    live Devpost form.** This agent has no way to browse the actual
    challenge page. Confirm the exact category list before submitting.

- [ ] **Project Description** (Devpost gallery summary, roughly 200-400 words)
  - **Value:** Use the "In one paragraph" line plus the Inspiration section
    from `devpost.md`. Do not use the old one-liner that was here before; it
    undersold what's actually built.

- [ ] **Built With** (tech stack tags)
  - React, TypeScript, Vite, WebMCP, DuckDB-WASM, Tailwind CSS, TanStack
    Table, Recharts, marked, DOMPurify, IndexedDB.
  - Dropped `@duckdb/duckdb-wasm` as a separate tag from `DuckDB-WASM`; it's
    the same dependency, listing it twice pads the tag list without adding
    information.

---

## Submission Artifacts

- [ ] **Live URL** (must work in a WebMCP-enabled context)
  - **URL:** not yet deployed.
  - **Requirements once deployed:**
    - HTTPS
    - Loads correctly with a real WebMCP host, or at minimum with Chrome's
      `chrome://flags/#enable-webmcp-testing` + the WebMCP Inspector extension
    - "Load demo" loads `compensation.csv` and the grid populates
    - Seal indicator reads "0 bytes sent" after load
    - Agent Console (Ctrl/Cmd + `` ` ``) lists all 20 registered tool actions
  - **Status:** blocked on the human. Not something this pass could do.

- [ ] **Demo Video** (<3 minutes, MP4/WebM)
  - **File:** not yet recorded.
  - **Script:** `submission/video-script.md`, rewritten this pass. Timed at
    ~2:42 against the full merged feature set (persistence, recipes,
    citations, redaction, native data I/O), with an explicit trim plan if the
    take runs long.
  - **Status:** blocked on the human. Recording, not writing, is what's left.

- [ ] **Repository**
  - **URL:** https://github.com/Adilmohd04/airlock (from `git remote -v` in
    this checkout; confirm this is the repo you want public and linked before
    submitting)
  - **Branch:** `main`
  - **Verified in this checkout:** `npm install && npm run dev` boots the app;
    `npm run build` and `npm run typecheck --workspace apps/airlock` are
    clean; `npm test` passes 248 tests (243 airlock, 5 webmcp-staged);
    `npm audit --omit=dev` reports zero vulnerabilities; `LICENSE` (MIT) and
    `README.md` exist at the repo root.

---

## Devpost Form Fields

All eight are drafted in `devpost.md`: Inspiration, What It Does, How We Built
It, Challenges, Accomplishments, What We Learned, What's Next, plus a
Technical Verification section and a closing "Why It Matters." Copy each
section body directly; don't re-summarize it by hand on the form, that's how
drift between the two documents starts.

---

## Judging Criteria: where each one is answered in `devpost.md`

- **WebMCP Leverage.** "What It Does" (the read/write split, 8 read tools vs.
  12 staged actions, the `propose_* / commit_* / reject_*` trio) and "How We
  Built It." Ground truth: `apps/airlock/src/agent/tools.tsx`.

- **Execution.** The full workspace description in "What It Does," the
  "Technical Verification" section (things actually run and checked in this
  checkout, not asserted), and `video-script.md` for what a judge sees end to
  end.

- **Potential Impact.** "Inspiration" and "Why It Matters" name the actual
  audience (HR comp, medical, financial data that can't go into a chatbot
  today) and state the privacy claim precisely: raw bytes never leave, tool
  results are shown in the activity ledger, one gated tool moves data out.

- **Creativity & Ambition.** "What makes it more than a filter-and-chart
  demo" (sessions, recipes, citations, redaction) plus the two real incident
  stories in "Challenges": the persistence-times-redaction bug caught by
  integration testing before it reached `main`, and the SQL-comment egress
  gap found and closed the same night. Both are drawn from `COLLAB.md`'s
  message log and checked against the actual diffs, not paraphrased from
  memory.

  One correction from the previous draft of this checklist: it claimed the
  UI tints agent-added columns teal to distinguish them from human-added
  ones. Checked against `DataGrid.tsx`: the teal "derived" marker applies to
  *any* derived column, agent or human, with no separate agent-origin styling.
  That's not a smaller claim, it's actually the better one: the workspace has
  no visual distinction between "the agent did this" and "you did this,"
  because the whole point is that there isn't one underneath.

---

## Functionality spot-checks (run these against whatever build gets deployed)

- [ ] "Load demo" loads `compensation.csv`, grid shows 812 rows.
- [ ] Add a filter, derived column, chart, rename, by hand, and by the agent
      via the Agent Console, in each case as a staged proposal.
- [ ] Approve with Enter, reject with Backspace, both from the review panel.
- [ ] `commit_add_filter` on an unapproved proposal fails; approving first
      makes it succeed.
- [ ] Redact a column from the ColumnList, then try `run_sql` against it
      three ways (bare select, `SELECT *`, inside a concatenation). All three
      refused and logged as `denied`.
- [ ] Reload the tab after making changes. Session, filters, derived columns,
      redaction state and the activity log all come back.
- [ ] Export a recipe, load a fresh dataset, replay it. Steps stage as
      proposals, none apply without approval.
- [ ] Write a report with `[cite:...]` markers, click a chip, confirm it
      opens the matching ledger entry inline.
- [ ] Import a `.parquet` and a `.tsv` file alongside CSV/JSON.
- [ ] Export the current view. Confirm it's a `.csv` and there is no `.xlsx`
      option anywhere in the export path (that feature was deliberately
      removed; if it reappears in the UI, something regressed).
- [ ] Seal indicator stays at "0 bytes sent" through the entire sequence
      above.

---

## Documentation

- [x] Root `README.md` exists (problem statement, architecture, run
  instructions, tool inventory, screenshots section). Note: as of this pass
  the README still describes 8 read + 11 staged tools and doesn't mention
  persistence, recipes, redaction, citations or the wider import formats.
  It's out of scope for this pass (submission/ only, no application-source or
  root-doc edits) but it should get the same correction `devpost.md` got
  before submission, since a judge who clones the repo will read it.
- [x] `LICENSE` (MIT) at repo root.
- [x] `devpost.md` covers all four judging criteria, corrected against
  `COLLAB.md` and the actual code in `apps/airlock/src/agent/tools.tsx`,
  `citations.ts`, `duckdb.ts` and `persistence.ts`.
- [x] `video-script.md` is timed, reflects the merged feature set, and
  includes an explicit cut plan if the recording runs long.

---

## Final checks

- [x] Prose in `devpost.md` and `video-script.md` drafted against the
  `humanize-writing` skill's structural rules and word bans (voice-profile
  calibration samples are still a stub in this environment; see note below).
- [ ] No secrets in the repo (not re-checked this pass; last verified in the
  submission-hardening work per `COLLAB.md`).
- [ ] Git history clean, no large binaries.

**Voice-profile note:** `references/voice-profile.md` in the humanize-writing
skill has no calibration samples from Sadath yet, just the identity and
audience sections. The rewrite followed the skill's structural rules (sentence
and paragraph rhythm, no em dashes, no hedge-assert-restate, no banned
vocabulary, first person, contractions) as closely as they can be applied
without those samples. If the result doesn't sound like you, the fastest fix
is pasting two or three samples of your own writing into that file and asking
for another pass, not re-editing by hand from scratch.

---

## Submission Day (Sept 3, 1:00 PM PT)

1. Verify the live URL is up, at least 15 minutes before the deadline.
2. Upload the demo video (hosted on Devpost, or linked from a public URL you
   control).
3. Fill the Devpost form: title, tagline, description, the eight narrative
   sections (copied from `devpost.md`), Built With tags, and the three links
   (live URL, GitHub repo, video).
4. Submit, then confirm the receipt email actually arrived.

---

## Still blocked on the human (could not do these from this pass)

1. **Netlify deploy and live URL.** `DEPLOY.md` and `netlify.toml` are in the
   repo and describe the process; this pass didn't run a deploy or produce a
   URL.
2. **Demo video recording.** The script is ready and timed; nobody has
   recorded it against a running build yet.
3. **Real screenshots.** `docs/screenshots/` still holds the placeholder set
   generated by `gen-placeholders.mjs`, not real captures.
4. **Devpost category selection**, and any other form field that requires
   looking at the actual live Devpost challenge page, which this pass had no
   way to browse.
5. **The README update** flagged above, so the repo a judge clones matches
   what `devpost.md` claims.
