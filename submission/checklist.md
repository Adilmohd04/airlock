# Airlock — Devpost Submission Checklist

**Challenge:** OpenAI WebMCP Challenge  
**Submission Deadline:** September 3, 2026, 1:00 PM PT  
**Status:** Ready for submission  

---

## Required Fields

- [ ] **Project Title**
  - **Value:** Airlock: Agent-Native Data Workspace
  - **Status:** ✓ Confirmed

- [ ] **Tagline** (max 60 chars)
  - **Value:** "Analyze private data with AI, never leave your browser. Every change stages for approval."
  - **Status:** ✓ Confirmed (56 chars)

- [ ] **Category**
  - **Value:** AI/ML
  - **Status:** ✓ Select "AI/ML"

- [ ] **Project Description** (for Devpost gallery)
  - **Value:** (from devpost.md Inspiration section, 200–400 words)
    - "Airlock is an agent-native data workspace: analyze sensitive tabular data with AI, keep it in your browser, approve every mutation. Built on WebMCP's honest read/write split and staged-approval pattern."
  - **Status:** ✓ Ready

- [ ] **Built With** (tech stack tags)
  - **Tags:**
    - React
    - TypeScript
    - WebMCP
    - DuckDB-WASM
    - Tailwind CSS
    - @duckdb/duckdb-wasm
    - marked
    - DOMPurify
    - Recharts
  - **Status:** ✓ Ready

---

## Submission Artifacts

- [ ] **Live URL** (must work in WebMCP-enabled context)
  - **URL:** (Netlify deployment URL — TBD)
  - **Requirements:**
    - HTTPS
    - Loads in ChatGPT with WebMCP enabled
    - Loads in Chrome with `chrome://flags/#enable-webmcp-testing` + WebMCP Inspector
    - Shows "0 bytes sent" in Seal indicator
    - Demo data loads ("Load demo" button)
    - Tools register (visible in WebMCP Inspector or built-in Agent Console)
  - **Status:** ⏳ Pending Netlify deploy

- [ ] **Demo Video** (<3 minutes, MP4/WebM)
  - **File:** airlock-demo.mp4 (or .webm)
  - **Duration:** 2:40 (under 3:00 ✓)
  - **Script:** submission/video-script.md
  - **Content:**
    - Load demo HR CSV
    - Chat with agent to analyze compensation gaps
    - Agent proposes filter, derived column, chart
    - Human approves each (show review panel)
    - Agent writes report
    - Human exports filtered dataset
    - Show activity log (audit trail)
    - Seal indicator: "0 bytes sent"
  - **Status:** ⏳ Pending video recording

- [ ] **Repository**
  - **URL:** https://github.com/[username]/openai_webmcp (or provided repo link)
  - **Branch:** main
  - **Requirements:**
    - README.md at root (explains problem, architecture, run instructions)
    - LICENSE (MIT)
    - Source code all in `apps/airlock/src/` and `packages/webmcp-staged/`
    - `npm install && npm run dev` boots the app
    - `npm run build` produces a production bundle
  - **Status:** ⏳ Pending final README + LICENSE

---

## Devpost Form Fields

- [ ] **Inspiration**
  - ✓ Covered in devpost.md (privacy + AI analysis + trust)

- [ ] **What It Does**
  - ✓ Covered in devpost.md (three-column workspace, 8 read tools, 11 staged write tools)

- [ ] **How We Built It**
  - ✓ Covered in devpost.md (monorepo, React, DuckDB-WASM, webmcp-staged primitive, activity ledger)

- [ ] **Challenges**
  - ✓ Covered in devpost.md (DuckDB cold start, privacy precision, 3-day scope, staging state)

- [ ] **Accomplishments**
  - ✓ Covered in devpost.md (full working product, complete tool surface, honest staged approval, zero egress, audit, keyboard UX, joins, reports, CSV export, polyfill)

- [ ] **What We Learned**
  - ✓ Covered in devpost.md (read/write honesty, typed diffs, activity ledger, shared mutation, DuckDB-WASM)

- [ ] **What's Next**
  - ✓ Covered in devpost.md (bigger joins, advanced charts, alerts, versioning, BI export, sharing, NL)

---

## Judging Criteria (OpenAI WebMCP Challenge)

- [ ] **WebMCP Leverage** (skillful, non-trivial tool use)
  - **Demonstrated:**
    - Honest read/write split: 8 read tools (registerTool + readOnlyHint: true) vs. 11 staged write tools (registerStagedTool)
    - Staged approval pattern: propose_* generates typed diff (no state change), commit_* requires human approval, reject_* blocks commit
    - Tools visible to host (ChatGPT, Chrome inspector) with readOnlyHint annotations
    - Activity ledger logs every tool call (read, propose, commit, reject, denied) with args and result
  - **Evidence:** devpost.md § "How We Built It" + apps/airlock/src/agent/tools.tsx (19 registered tools)

- [ ] **Execution** (coherent working product)
  - **Demonstrated:**
    - Full React workspace with human UI (grid, charts, reports)
    - Integration with WebMCP tools
    - Review panel with typed diff previews per tool
    - Activity log showing full audit trail
    - Keyboard shortcuts for approve/reject
    - Responsive grid, live updates on approve/reject
    - Polyfill path for local dev
  - **Evidence:** video-script.md (demo walkthrough) + apps/airlock/src/components/** (full React UI)

- [ ] **Potential Impact** (real problem/audience)
  - **Problem:** Teams with sensitive data (HR comp, medical, financial) can't use ChatGPT for analysis due to data policy
  - **Solution:** Keep data in browser, use AI via WebMCP, human approves every change
  - **Audience:** Analysts, HR teams, financial analysts, healthcare orgs, compliance officers
  - **Precision:** Raw bytes never leave; query results shown in activity ledger; Seal indicator proves 0 egress
  - **Evidence:** devpost.md § "Inspiration" + "Potential Impact" + readme (TBD)

- [ ] **Creativity & Ambition** (bold, inventive approach)
  - **Creative elements:**
    - "Airlock" framing: physical metaphor for trust boundary
    - Visible agent's touch: amber pending edges, green commit flashes, teal agent-added columns
    - Shared mutation contract: agent and human use same store methods
    - Activity ledger as transparency engine: audit trail answers "what did the agent ask, what did it see?"
    - Bigger-swing features: multi-dataset joins, agent-authored reports, gated export
  - **Ambition:** Not a toy "agent chat about data" — a production-grade workspace where human and agent collaborate with mutual trust
  - **Evidence:** devpost.md § "What It Does" + "What We Learned" + CLAUDE.md design system

---

## Pre-Launch Checklist

### Code Quality
- [ ] `npm run typecheck --workspace apps/airlock` passes
- [ ] No console errors or warnings in dev or production builds
- [ ] No network requests post-load (Network tab shows only static assets)
- [ ] SealStatus shows "0 bytes sent" in all normal flows

### Functionality
- [ ] Demo CSV loads via "Load demo" button
- [ ] Grid renders with correct row/column counts
- [ ] Column profiles show correct statistics (type, nulls, distinct)
- [ ] User can add filter → grid updates
- [ ] User can add derived column → grid updates
- [ ] User can add chart → Chart tab renders
- [ ] User can rename column → header updates
- [ ] User can export CSV → file downloads
- [ ] Agent console (Ctrl/Cmd + `` ` ``) lists all 19 tools
- [ ] Invoking read tool in console → appears in activity log
- [ ] Invoking staged tool in console → appears in review panel as proposal
- [ ] Approve proposal → review panel updates, grid re-renders, activity log shows commit
- [ ] Reject proposal → proposal clears, grid unchanged

### WebMCP Integration
- [ ] In Chrome `#enable-webmcp-testing`, WebMCP Inspector shows all registered tools
- [ ] Tools have correct `readOnlyHint` annotations (8 read tools true, 11 write tools false/unset)
- [ ] Tool descriptions are clear and accurate
- [ ] Input schemas are correct (e.g., `add_filter` requires "expression")
- [ ] Tool results are valid JSON with `content: [{type: "text", text: ...}]`
- [ ] Staged tool trio (propose_*, commit_*, reject_*) works end-to-end

### Performance & UX
- [ ] App boots in <5 seconds (first paint)
- [ ] Grid virtualization: scrolling 1000+ row dataset is smooth (60fps)
- [ ] Approve/reject responses in <200ms
- [ ] Chart renders in <1 second
- [ ] Keyboard shortcuts (⏎ approve, ⌫ reject) work in review panel
- [ ] Focus management: keyboard navigation through proposals
- [ ] Dark mode is readable; no WCAG contrast violations on key text

### Deployment (Netlify)
- [ ] `netlify deploy --prod` succeeds
- [ ] Live URL responds with 200
- [ ] HTTPS enabled
- [ ] CORS headers correct (if needed for WASM)
- [ ] Gzip enabled for JS/CSS
- [ ] `.wasm` MIME type correct (`application/wasm`)
- [ ] No CDN requests (egress stays 0)

### Video
- [ ] Duration: 2:40–2:50 (under 3:00)
- [ ] Script: shot-by-shot (submission/video-script.md)
- [ ] Audio: clear voiceover, no background noise
- [ ] Visuals: high-resolution (1080p+), readable fonts (14pt+ for UI text)
- [ ] Captures:
  - Load demo data
  - Agent proposals in review panel
  - Approve filter (row count update)
  - Approve derived column (column appears, tinted)
  - Approve chart (Chart tab switches, chart renders)
  - Approve report
  - Export (download happens)
  - Activity log visible
  - Seal status visible ("0 bytes sent")

### Documentation
- [ ] Root README.md includes:
  - Problem statement
  - What Airlock does
  - Architecture diagram (ASCII or image)
  - How to run: `npm install && npm run dev`
  - How to build: `npm run build`
  - Tool inventory (list of 8 read + 11 write tools)
  - How to test WebMCP (local flags, Inspector, polyfill)
  - Screenshots showing each major UI element
  - License and credits
- [ ] LICENSE file (MIT) at repo root
- [ ] CLAUDE.md documents all key constants and conventions
- [ ] devpost.md covers all four judging criteria
- [ ] video-script.md is timing-accurate and demonstrates all key features

### Final Checks
- [ ] Readme prose runs through humanize-writing skill ✓
- [ ] Video script prose runs through humanize-writing skill ✓
- [ ] Devpost.md prose runs through humanize-writing skill ✓
- [ ] No secrets in repo (API keys, passwords, auth tokens)
- [ ] `.gitignore` excludes node_modules, dist, .env
- [ ] Git history is clean (no large binaries, commit messages are clear)

---

## Submission Day (Sept 3, 1:00 PM PT)

1. **Verify live URL is up** (15 min before deadline)
2. **Upload demo video to platform** (must be hosted on Devpost or linked to public URL)
3. **Fill Devpost form:**
   - Project title
   - Tagline
   - Description (from devpost.md)
   - Inspiration, What it does, How we built it, etc. (copy from devpost.md)
   - Built with tags
   - Links: live URL, GitHub repo, video URL
4. **Submit** (click "Submit Project")
5. **Confirm submission receipt** (Devpost sends email)

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| WebMCP not available in ChatGPT | Polyfill + WebMCP Inspector path verified locally before deadline |
| DuckDB-WASM doesn't load | Self-hosted bundle, Netlify `Cross-Origin-Embedder-Policy` headers verified |
| Demo video exceeds 3 min | Script timed at 2:40; buffer of 20 seconds |
| Privacy claim wrong | Every egress point logged; Seal shows 0 bytes; activity log shows what agent saw |
| Staging state inconsistency | All commits flow through shared `datasetStore` methods; tested approve/reject cycles |
| Production build fails | `npm run build` passes locally; typecheck clean |

---

## Notes

- **Devpost submission form:** https://devpost.com/software/airlock (TBD)
- **Repository:** C:\Users\Ashi\Desktop\Adil\devpost\openai_webmcp
- **Contact:** sadathanwar312@gmail.com
- **Repo visibility:** Public (required for Devpost)
