# Airlock: Agent-Native Data Workspace

**Tagline:** Analyze private data with AI. Never leaves your browser.

**In one paragraph:** Airlock is a data workspace where an AI agent reads your spreadsheet through WebMCP tools, proposes filters, derived columns, charts and reports, and none of it takes effect until you approve it. The file never uploads anywhere. Every query the agent runs, and every result it saw, is written to an on-screen ledger, so "what did the AI actually see" has a literal answer instead of a policy document's promise.

---

## Inspiration

Compensation data, medical records, anything with a person's name next to a number. That's exactly the data people want AI help analyzing, and exactly the data they're told not to paste into a chat window. The usual response is to do the analysis by hand, hire someone, or build a dashboard that answers last quarter's questions and none of this quarter's.

Language models are already good at this kind of work. They read a schema, write a join, notice that one department's pay ratio is off. The part that doesn't work is where the spreadsheet goes to get analyzed.

Airlock keeps the file on the machine that opened it. DuckDB compiled to WebAssembly runs the SQL in the tab. The agent reaches it only through WebMCP tools that return query results, not files. Any tool that would change the workspace stages a diff first and waits for a person to click approve. The data doesn't move. The agent's queries are all on the record. That's the whole idea: a session works with a table you'd never paste into ChatGPT.

---

## What It Does

Airlock is a three-column workspace. The left rail lists loaded datasets and every column with a live profile: type, null percentage, distinct count. The center holds three tabs, Grid (the current view, filters and derived columns already applied), Charts, and Report. The right rail stacks a review queue above an activity log, so a pending proposal and the full history of what already happened sit next to each other.

The agent's WebMCP surface is 8 read tools and 12 staged write actions, all registered in `apps/airlock/src/agent/tools.tsx`.

Read tools run the moment they're called and are marked `readOnlyHint: true`: `list_datasets`, `get_dataset_summary`, `list_columns`, `profile_column`, `preview_rows`, `run_sql` (SELECT-only, enforced), `describe_workspace`, `get_activity_log`. Nothing they do can change the workspace. They just look, and every look is logged.

Write actions are different. `add_filter`, `remove_filter`, `clear_filters`, `add_derived_column`, `remove_derived_column`, `rename_column`, `redact_column`, `add_chart`, `flag_rows`, `join_datasets`, `export_view`, `write_report`: each one registers as a `propose_*` / `commit_*` / `reject_*` trio. `propose_*` builds a typed preview (a filter shows rows kept vs. total, a derived column shows three sample rows with the new value computed) and changes nothing. `commit_*` refuses to run until a human has approved the matching proposal in the review panel. There is no path from agent intent to applied change that skips that queue.

A person can do everything the agent can, clicking to add a filter, add a derived column, rename a header, through the same UI, and it lands in the same store. Approve a proposal with Enter, reject with Backspace. The Seal indicator in the top bar reads live bytes sent since load; in normal use it stays at zero.

### What makes it more than a filter-and-chart demo

- **Sessions.** Close the tab, come back tomorrow, and the dataset, filters, derived columns, charts, reports and the full activity log are still there. Airlock stores the original file bytes in IndexedDB and rebuilds the DuckDB table on load by replaying the same import path the file first went through: CSV and JSON as text, Parquet as raw bytes. No second data format, no lossy intermediate. If storage is blocked, or you're in a private window, the app boots anyway and just doesn't save.
- **Recipes.** Export an approved sequence of filters and derived columns as a small JSON file, load a fresh CSV next quarter, replay it in one click. Replay does not apply anything directly. It re-stages every step as a pending proposal through the same review queue, so a recipe is a suggestion, not a bypass. A step naming a column the new file doesn't have gets reported and skipped, not silently dropped.
- **Citations.** When the agent's report claims "engineering is paid 8% below market," that sentence carries a `[cite:<id>]` marker pointing at the exact ledger entry (query, arguments, row count) that produced the number. Click it and the evidence opens inline. A citation pointing at nothing, or at a proposal rather than a read, renders as a struck-through red chip instead of quietly disappearing. Before you approve a report, the proposal card shows how many claims are cited and how many aren't, so you're judging evidence, not prose.
- **Redaction.** Mark a column redacted, from the column list, or the agent can propose it after noticing something that looks like PII, and the agent loses that column completely. Not in row previews, not in a profile, not inside an aggregate, not through a derived-column expression that references it, not in an export. `SELECT *` is refused outright while any column is redacted, so there's no wildcard escape hatch. Every blocked attempt lands in the activity log as a denial, so the record shows the agent tried and was stopped. Un-redacting is a human-only action. There's no tool for it.
- **Real files, not toy CSVs.** Import handles CSV, JSON, TSV, pasted clipboard data with delimiter sniffing, a folder picked through the File System Access API, and Parquet, read natively through DuckDB-WASM's linked reader at zero added dependency cost. Export goes out through the same staged `export_view` tool as everything else, as CSV. `.xlsx` import and export were built and then pulled before merge. More on why below.

---

## How We Built It

**Monorepo, npm workspaces.**

`packages/webmcp-staged/` is the reusable primitive underneath all of this: `registerTool` for reads, `registerStagedTool` for a `propose_* → human review → commit_*` trio, zero runtime dependencies in the core, React bindings on top. It's written to be extended, not rewritten, and it stayed that way through five feature branches.

`apps/airlock/` is the application:

- `src/engine/`: the DuckDB-WASM wrapper and the SQL guards, plus three observable stores built on `useSyncExternalStore`. `datasetStore` (per-dataset columns, filters, derived columns, profiles, redaction state), `workspaceStore` (the dataset list, joins, source bytes for persistence), `uiStore` (active tab, focused column).
- `src/agent/tools.tsx`: the entire WebMCP surface described above.
- `src/agent/activity.ts`: the transparency ledger. Every read, propose, commit, reject and denial gets an entry with arguments, a result summary and an id. That id is what a citation marker points at.
- `src/agent/citations.ts`, `src/agent/reports.ts`: citation resolution and the agent-authored report store.
- `src/lib/`: `egress.ts` (wraps fetch, XHR, sendBeacon and WebSocket to count outbound bytes, backs the Seal indicator), `persistence.ts` (the IndexedDB session layer), `recipes.ts`, `csv.ts`, `markdown.tsx` (marked + DOMPurify, run twice; see Challenges).
- `src/components/`: the React UI. TopBar with SealStatus and SessionMenu, LeftRail with ColumnList and FileDrop, DataGrid, ChartPanel (Recharts), ReportPanel, RecipePanel, ReviewPanel with ProposalCard, ActivityLog, and a built-in AgentConsole for invoking tools by hand without a real WebMCP host.

**Stack:** React 18, TypeScript strict, Vite, Tailwind with the project's semantic tokens (amber for pending, green for committed, red for reject/danger), TanStack Table for the virtualized grid, Recharts, `@duckdb/duckdb-wasm` self-hosted, `@mcp-b/webmcp-polyfill` for local testing, loaded only when `document.modelContext` isn't already present, so a real host is never shadowed.

**Three agents, one repo, a shared log file.** This was built overnight by three coordinating Claude and Kiro sessions with the human offline, using `COLLAB.md` as the only channel between them: branch ownership, feature acceptance criteria, and a running message log every agent read before touching a file. It's not a framework, just a plain markdown file that turned out to be enough discipline to keep five feature branches from stepping on each other, and to catch the bug described below before it reached `main`.

---

## Challenges

**DuckDB-WASM is not small.** The WASM runtime and the demo data add real load time on a cold start. We self-host the bundle instead of pulling it from a CDN, split it into its own async chunk so the main app shell paints first, and show a loading state instead of a blank screen while it initializes.

**Saying "your data never leaves the browser" precisely enough to defend it.** That sentence is true about the file's raw bytes and not true about everything the agent learns. A read tool's whole job is to hand back real content. We chose to state the boundary exactly rather than round it up: raw bytes never leave; query results are returned to the agent, and every one of those results is written to the activity ledger, visible to the human, queryable through `get_activity_log`. The Seal indicator counts bytes sent, not bytes read. One tool, `export_view`, moves data out of the tab, and only on explicit approval.

**A bug that only existed in the combination.** Redaction and session persistence were built on separate branches by different agents, and each shipped clean on its own. Redaction hides a column from every read path the agent has. Persistence writes the whole dataset state, including which columns are hidden, to IndexedDB and rebuilds it on reload. Wire them up naively and a reload of a session with `ssn` redacted would silently stop hiding it, because the redaction flag never made it into the snapshot in the first place. Fixing that exposed a second, quieter problem: the profiling pass that runs right after a table loads reads live sample values into a cache before the redaction state gets restored, so even a column correctly flagged as redacted after reload could still be carrying a cached sample from before the flag existed. The fix restores redactions last and routes each one through the same `redactColumn` function a human's click in the UI uses, so the cached profile gets stripped back to shape-only as part of restoring the flag, not as a separate step someone could forget. Four tests pin the round trip now, including a session saved before redaction existed at all. Neither branch's own test suite would have caught this on its own. It only shows up where the two features overlap, which is the actual argument for merging early and testing the integration rather than saving that for the night before the deadline.

**Closing the SQL side channels, twice.** `run_sql` was guarded from day one against writes and multi-statement stacking. It took a second pass to notice that a networkish URL sitting inside a SQL comment (`-- see https://evil.example`) slipped past the guard, because the check ran on a comment-stripped copy of the query while the same URL in a string literal or bare expression was already rejected. Small gap, but it undercuts the exact claim the product makes. Fixed the same night the gap was found: the network check now runs on the text before comments are stripped, and the test that had documented the hole as accepted behavior got flipped into a regression test that asserts rejection instead.

**Keeping five feature branches from corrupting each other's state.** `datasetStore.ts`, `tools.tsx` and `workspaceStore.ts` each got touched by three or four different branches: persistence adding `serialize`/`hydrate`, redaction adding a column blindfold, citations adding evidence markers, data I/O adding a source-bytes union type. The rule that held it together was mechanical. Every mutation, agent or human, goes through the same store method, and every merge got re-gated on the full test suite before landing. It wasn't glamorous. It's also the reason five features merged without a single silent regression, and the one real cross-feature bug got caught by a test instead of by a user.

---

## Accomplishments

- **All five planned features shipped and merged**, not four with one left on a branch: named sessions, recipe replay, cited reports, per-column redaction, and native multi-format import (CSV, JSON, TSV, Parquet, clipboard paste, File System Access).
- **248 tests passing** (243 in the app, 5 in the reusable primitive). `npm run build` and `npm run typecheck` clean. `npm audit --omit=dev` reports zero vulnerabilities.
- **A staged-approval loop that actually holds.** `commit_*` errors out on an unapproved proposal, the agent's own `reject_*` tool and a denied commit attempt both land in the ledger, and the human Approve button and the agent's `commit_*` call are the same code path underneath, not two paths that happen to agree today.
- **Redaction that survives every path we tried to break it with:** rows, profiles, aggregates, derived-column expressions, `SELECT *`, and joins. 41 tests specifically target the guard side of this.
- **A citation mechanism with no new trust surface.** A citation is a pointer into the ledger that already exists, not a second store that could drift out of sync with it. The XSS handling is three layers deep on purpose: the marker syntax is inert to the markdown parser, the id it captures is charset-locked to exactly what the ledger's id generator produces, and DOMPurify runs twice, once on the agent's raw markdown with a tight allowlist, again after chip injection with a slightly widened one. Agent text never reaches the second pass as trusted markup.
- **Native Parquet at zero added dependencies**, because DuckDB-WASM's linked reader already does it. Confirmed against the actual library version in a throwaway test harness before committing to the approach.
- **A parser we chose not to ship.** `.xlsx` import and export were fully built, using SheetJS. Before merge, `npm audit` flagged two unpatched high-severity advisories in that dependency, one of them prototype pollution, sitting directly in the code path that parses a file a stranger's spreadsheet app produced. We pulled it rather than ship a known-vulnerable parser inside a tool whose entire pitch is that this is the safe place for sensitive files. `main` audits clean today because of that call, not despite it.

---

## What We Learned

Read/write honesty is not a formality. It's the mechanism. `readOnlyHint: true` tells a host it can run a tool without asking, and everything downstream depends on that being true. The moment a "read" tool could mutate state, the whole trust model collapses, so every read tool in this build is a pure lookup with no side effect beyond a log entry.

A typed preview beats a paragraph of justification. Telling a human "this filter keeps 127 of 812 rows" before they approve it is a stronger signal than any amount of agent-written explanation, and it's checkable in a way prose isn't.

The activity ledger turned out to be the answer to the hardest question this kind of product has to answer: what did the AI actually see? Not what data exists. What did it actually query, and what came back. Citations just point at entries that were already being written for a different reason, which is probably why they were cheap to add once the ledger existed.

Two features can each be correct and still combine into a bug neither one's tests would catch. That's not a novel insight in the abstract, but living through it (redaction and persistence, a real security regression, caught the same night by a probe test written specifically to check the seam) is a different thing than knowing it in principle.

---

## What's Next

**Excel, once there's a parser worth trusting.** SheetJS 0.20.x fixes the advisories that made us pull 0.18.x, but only the CDN tarball has it, and that install path isn't available in this environment. `.xlsx` comes back the day a patched build is installable from a source we can pin and audit.

**Sharing the method instead of the spreadsheet.** A recipe plus a cited report is a complete, reproducible piece of analysis that contains zero rows of the original data. Send a colleague the recipe and the report; they run it against their own copy. That's already possible with what's built. It just hasn't been the headline yet.

**Redaction enforced by the database, not just by our validator.** Right now a redacted column is blocked by a lexical guard checked before the query runs. The stronger version is a DuckDB connection with actual column-level grants, so the boundary lives in the engine instead of in code we wrote and tested ourselves. Defense in depth is good. Defense in the engine is better.

**Checking whether a cited query actually supports the sentence it's attached to**, not just whether the citation resolves. Right now a citation proves a number came from a real query. It doesn't yet prove the query's result matches the claim.

**Bigger joins, more chart types, and a recipe that watches a folder.** Three-plus dataset joins with cached intermediates, scatter and histogram charts, and a recipe that re-runs itself against new files and reports what changed.

**Still ahead of submission:** the live deploy, the recorded demo video, and real screenshots replacing the placeholder set. Everything described above under "What It Does" is built and tested; those three items are packaging, not development, and they're the last mile before a judge can actually open this.

---

## Technical Verification

- `npm install` at the repo root, then `npm run dev`. The landing screen renders, "Load demo" loads `compensation.csv` (812 rows), and the grid populates.
- The built-in Agent Console (Ctrl/Cmd + `` ` ``) lists all 20 registered tool actions and invokes any of them by hand, including the full propose → approve → commit loop. No external host required to verify the WebMCP surface.
- `run_sql("UPDATE dataset SET base_salary = 0")` is rejected by `assertSelectOnly` before it reaches DuckDB.
- Invoking `commit_add_filter` on a proposal that hasn't been approved yet fails; approving it in the review panel first makes the same commit succeed and the grid updates immediately.
- Redact a column, then try `run_sql("SELECT name FROM dataset")`, `SELECT *`, and a concatenation expression referencing it. All three are refused and logged as denials.
- `npm test` at the root runs both workspaces: 248 tests passing (243 airlock, 5 webmcp-staged). `npm audit --omit=dev` reports zero vulnerabilities.

---

## Why It Matters

The honest version of "AI for your private spreadsheet" isn't a chatbot with a bigger context window and a promise not to log your data. It's an agent that can only reach your data through tools that are either provably read-only or provably staged for your approval, running in a tab that never uploads the file in the first place. Airlock is that, built specifically for the people who currently can't use AI on their own data at all: HR teams looking at comp equity, analysts with financial statements, anyone whose spreadsheet has a name column they can't paste into a chat window.

The agent proposes. The human approves. Both write to the same ledger, and that ledger is the whole privacy claim, spelled out instead of asserted.
