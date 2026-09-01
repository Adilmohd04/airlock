# Requirements Document

## Introduction

Airlock is an agent-native, browser-only data workspace submitted to OpenAI's WebMCP Challenge. The code is healthy (typecheck passes, production build succeeds), but three submission-quality gaps remain that keep it from being a top-tier entry. This feature — **submission-hardening** — closes exactly those three gaps, tightly scoped to the ~2-day deadline:

1. **Screenshots / README integrity** — the root `README.md` links six screenshot images that do not exist, producing broken image references. This workstream removes the broken references and makes producing the intended shots straightforward.
2. **Trust-guarantee test suite** — the product's core trust guarantees (the SQL guard in `duckdb.ts` and the propose→commit human-gating in `reviewController.ts` + `webmcp-staged`) currently have no automated coverage. This workstream stands up a test runner and proves those guarantees hold.
3. **Cold-start loading UX + bundle** — DuckDB-WASM cold start is slow with no visible feedback, and the main JS chunk exceeds Vite's 500 kB warning threshold. This workstream adds a visible initialization indicator and code-splits the bundle, while keeping network egress at zero.

All work must honor the project's non-negotiable conventions: the base table stays immutable (transforms are view-level), read/write tool split stays honest (no write tool skips the review queue), egress stays at zero after load (self-hosted assets, no CDN/analytics/telemetry), the WebMCP polyfill never shadows a native host, `packages/webmcp-staged` is extended-not-rewritten, TypeScript stays strict, and Tailwind semantic tokens are reused.

## Glossary

- **Airlock**: The browser-only, agent-native data workspace application located at `apps/airlock`.
- **README_Renderer**: Any standard Markdown renderer (GitHub, Devpost, IDE preview) that displays the root `README.md` and resolves relative image links.
- **Root_README**: The `README.md` file at the repository root that references the six screenshot images.
- **Screenshot_Set**: The six images referenced by Root_README — `docs/screenshots/01-empty-state.png` through `06-agent-console.png`.
- **Capture_Setup**: The repository artifacts (scripts, configuration, and/or documentation) that let a human produce the Screenshot_Set with minimal manual steps.
- **SQL_Guard**: The lexical validation functions in `apps/airlock/src/engine/duckdb.ts` — `assertSelectOnly`, `assertExpression`, and `assertIdentifier` — that reject unsafe SQL before it reaches DuckDB.
- **Forbidden_Token**: A mutating keyword (`insert`, `update`, `delete`, `drop`, `create`, `alter`, `attach`, `detach`, `copy`, `truncate`, `replace`, `pragma`, `set`, `call`, `install`, `load`, etc.) or a network/file-reader function (`read_csv`, `read_parquet`, `glob`, etc.) that the SQL_Guard rejects.
- **Networkish_Reference**: A URL or resource scheme (`http://`, `https://`, `s3://`, `file://`, etc.) that the SQL_Guard rejects.
- **Proposal_Store**: The `ProposalStore` in `packages/webmcp-staged` that holds pending proposals and their approval status.
- **Staged_Tool**: A WebMCP tool trio (`propose_*`, `commit_*`, `reject_*`) registered via `registerStagedTool`, where `commit_*` is gated on human approval.
- **Commit_Gate**: The enforcement in `webmcp-staged` (and mirrored by `reviewController.ts`) that a `commit_*` call succeeds only when the matching proposal has `status === "approved"`.
- **Test_Runner**: The Vitest-based automated test harness added to the project (none currently exists).
- **Trust_Test_Suite**: The set of automated tests proving the SQL_Guard and Commit_Gate guarantees.
- **DuckDB_Init**: The asynchronous initialization of the DuckDB-WASM engine (`getDb` / `createDb` in `duckdb.ts`) that must complete before queries run.
- **Loading_Indicator**: A visible UI element shown while DuckDB_Init is in progress during cold start.
- **Egress_Monitor**: The network-egress tracker in `apps/airlock/src/lib/egress.ts` that backs the "Seal" indicator.
- **Bundle_Warning**: Vite's build warning emitted when a single chunk exceeds 500 kB (currently ~872 KB / 245 KB gzipped for the main chunk).
- **Build_Process**: The monorepo build invoked by `npm run build`, producing `apps/airlock/dist`.

## Requirements

### Requirement 1: Eliminate broken screenshot references in the README

**User Story:** As a submission judge, I want the project README to render with no broken image links, so that the project looks polished and trustworthy at first glance.

#### Acceptance Criteria

1. WHEN a README_Renderer displays the Root_README, THE Root_README SHALL contain zero Markdown image references (syntax `![alt](path)`) whose target path does not resolve to a file that exists in the repository.
2. WHERE any of the six Screenshot_Set files (`docs/screenshots/01-empty-state.png` through `docs/screenshots/06-agent-console.png`) are absent from the repository, THE Root_README SHALL contain no image reference pointing to that absent file.
3. WHERE a Screenshot_Set file is absent from the repository, THE Root_README SHALL reference in its place either no image or a placeholder image file that exists in the repository.
4. WHEN a README_Renderer displays the Root_README's screenshots section, THE Root_README SHALL retain, for each of the six intended shots, a textual caption of at least 3 words that identifies the shot's content.
5. THE Root_README SHALL contain exactly one link whose target is `docs/screenshots/README.md`.

### Requirement 2: Provide a working screenshot-capture setup

**User Story:** As the project maintainer, I want a straightforward capture setup for the six screenshots, so that I can produce the final images quickly before the deadline.

#### Acceptance Criteria

1. THE Capture_Setup SHALL document, for each of the six shots in the Screenshot_Set (`01-empty-state.png`, `02-grid.png`, `03-review-queue.png`, `04-activity-ledger.png`, `05-seal-popover.png`, `06-agent-console.png`), the exact target file name, a capture window of 1440 × 900 in Chrome using system dark theme, and the dataset precondition that the `compensation.csv` demo is loaded and displaying 812 rows and 14 columns.
2. THE Capture_Setup SHALL specify `docs/screenshots/` as the single destination directory for all six produced images.
3. WHERE a produced image is placed in `docs/screenshots/` using one of the six target file names from the Screenshot_Set, THE Root_README SHALL display that image in its Screenshots gallery with no additional edits to the Root_README.
4. IF a produced image is placed outside `docs/screenshots/` or uses a file name not in the Screenshot_Set, THEN THE Root_README SHALL leave the corresponding gallery slot without a rendered image, indicating the image is not wired in.
5. WHILE the Airlock application is being loaded and captured from its local server, THE Capture_Setup SHALL require 0 request-body bytes sent and 0 external (cross-origin) requests, permitting only same-origin asset loads from the locally served application.

### Requirement 3: Establish an automated test runner

**User Story:** As a submission judge evaluating execution quality, I want the project to have a runnable automated test suite, so that I can verify the trust guarantees are actually enforced.

#### Acceptance Criteria

1. THE Test_Runner SHALL be Vitest, configured to execute TypeScript test files under the project's strict TypeScript compiler settings without requiring a separate compilation step.
2. WHEN a developer runs the project's test command, THE Test_Runner SHALL execute the Trust_Test_Suite in a single non-watch run that terminates on its own within 300 seconds and returns a process exit code of 0 when all tests pass and a non-zero exit code when one or more tests fail.
3. WHEN the Trust_Test_Suite run completes, THE Test_Runner SHALL report to standard output the total number of test cases executed, the number passed, and the number failed.
4. THE Test_Runner SHALL be invocable through a single npm script named `test` defined in the project's package configuration.
5. WHEN the Build_Process runs, THE Test_Runner SHALL NOT create, modify, or delete any file within `apps/airlock/dist`.
6. IF no test files are discovered when the test command runs, THEN THE Test_Runner SHALL return a non-zero exit code and report a message indicating that zero test files were found.

### Requirement 4: Prove the SQL guard rejects unsafe SQL

**User Story:** As a security-conscious judge, I want automated proof that the SQL guard blocks mutation, injection, and network side-channels, so that the "data never leaves the browser" guarantee is verifiable.

#### Acceptance Criteria

1. WHEN a read-query guard receives a fragment containing a Forbidden_Token (for example insert, update, delete, drop, create, alter, attach, detach, copy, truncate, replace, pragma, set, call, install, load, read_csv, read_parquet, parquet_scan, or glob) outside of any string literal or comment, THE SQL_Guard SHALL reject the fragment by throwing an error indicating a disallowed keyword or function, and SHALL NOT execute the fragment.
2. WHEN a read-query guard receives a fragment containing a Networkish_Reference (a scheme such as http://, https://, s3://, or file://), including when that reference appears inside a string literal or comment, THE SQL_Guard SHALL reject the fragment by throwing an error indicating remote URLs are not allowed, and SHALL NOT execute the fragment.
3. WHEN a read-query guard receives a fragment that, after string literals and comments are neutralized, contains a semicolon separating multiple statements, THE SQL_Guard SHALL reject the fragment by throwing an error indicating multiple statements are not allowed, and SHALL NOT execute the fragment.
4. WHEN `assertSelectOnly` receives a fragment whose first significant token (after comments and string literals are neutralized) is not one of the allowed read keywords SELECT, WITH, VALUES, EXPLAIN, TABLE, FROM, PIVOT, or UNPIVOT, THE SQL_Guard SHALL reject the fragment by throwing an error indicating only read queries are allowed, and SHALL NOT execute the fragment.
5. WHEN a read-query guard receives an otherwise valid read query in which a Forbidden_Token or a semicolon appears only inside a string literal or as part of a valid column name, THE SQL_Guard SHALL accept the fragment and SHALL return the fragment trimmed of surrounding whitespace and any single trailing semicolon.
6. WHEN `assertExpression` receives a scalar or boolean expression fragment containing a Forbidden_Token, a Networkish_Reference, or a stacked statement separated by a semicolon (each evaluated outside string literals and comments, except Networkish_References which are rejected even inside literals), THE SQL_Guard SHALL reject the fragment by throwing an error identifying the violation, and SHALL NOT execute the fragment.
7. WHEN `assertIdentifier` receives a value that is not a single bare column name consisting only of a leading letter or underscore followed by letters, digits, or underscores, THE SQL_Guard SHALL reject the value by throwing an error indicating it is not a valid column name.
8. WHEN `assertIdentifier` receives a valid bare column name, THE SQL_Guard SHALL accept it and SHALL return the identifier trimmed of surrounding whitespace.
9. IF a read-query guard, `assertExpression`, or `assertIdentifier` receives input that is empty or contains only whitespace (or only a trailing semicolon and whitespace), THEN THE SQL_Guard SHALL reject the input by throwing an error indicating the SQL is empty, and SHALL NOT execute the input.

### Requirement 5: Prove the propose-to-commit human gating holds

**User Story:** As a judge evaluating the trust model, I want automated proof that a committed change requires prior human approval, so that the "nothing changes without approval" contract is verifiable.

#### Acceptance Criteria

1. IF a `commit_*` tool is invoked for a proposal whose status is `pending`, THEN THE Commit_Gate SHALL refuse to apply the change, SHALL leave the proposal in the Proposal_Store with its status unchanged as `pending`, and SHALL return an error result whose reason indicates the proposal is not approved.
2. IF a `commit_*` tool is invoked for a proposal whose status is `rejected`, THEN THE Commit_Gate SHALL refuse to apply the change, SHALL leave the proposal in the Proposal_Store with its status unchanged as `rejected`, and SHALL return an error result whose reason indicates the proposal is not approved.
3. IF a `commit_*` tool is invoked with a proposalId that does not exist in the Proposal_Store, THEN THE Commit_Gate SHALL refuse to apply the change and SHALL return an error result whose reason indicates the proposal was not found.
4. WHEN a `commit_*` tool is invoked for a proposal whose status is `approved`, THE Commit_Gate SHALL apply the change exactly one time and SHALL remove the proposal from the Proposal_Store such that its proposalId no longer resolves to any proposal.
5. IF a `commit_*` tool is invoked two or more times for the same proposalId that was `approved`, THEN THE Commit_Gate SHALL apply the change no more than one time in total across all invocations, and every invocation after the first successful commit SHALL return an error result whose reason indicates the proposal was not found.
6. WHEN a `commit_*` tool invocation is refused for any reason, THE Staged_Tool SHALL emit exactly one `denied_commit` audit event that identifies the invoked tool name, the supplied proposalId, and a reason describing why the commit was refused.

### Requirement 6: Display a loading indicator during cold start

**User Story:** As a demo viewer, I want visible feedback while the engine initializes, so that the app feels responsive instead of frozen during the multi-second cold start.

#### Acceptance Criteria

1. WHILE DuckDB_Init is in progress, where DuckDB_Init spans from the moment a user initiates loading a dataset until the engine-initialization request either resolves or rejects, THE Airlock SHALL display a Loading_Indicator, and the Loading_Indicator SHALL become visible within 200 milliseconds of load initiation.
2. WHEN DuckDB_Init completes successfully, THE Airlock SHALL remove the Loading_Indicator and display the loaded dataset.
3. IF DuckDB_Init fails, THEN THE Airlock SHALL remove the Loading_Indicator, retain any dataset that was displayed before load initiation, and display an error message that identifies the dataset that failed to load without exposing internal stack traces or log output.
4. THE Loading_Indicator SHALL use only Tailwind semantic tokens already defined in the project and SHALL introduce zero new color definitions.
5. WHILE the Loading_Indicator is rendered, THE Airlock SHALL leave the Egress_Monitor external-request count and sent-byte total unchanged, excepting same-origin asset GETs that the Egress_Monitor classifies as expected.

### Requirement 7: Resolve the large-chunk bundle warning via code-splitting

**User Story:** As a submission judge reviewing build quality, I want the production build to complete without the large-chunk warning, so that the project demonstrates attention to performance.

#### Acceptance Criteria

1. WHEN the Build_Process runs, THE Build_Process SHALL complete with exit code 0 and without emitting Vite's advisory that a chunk is larger than 500 kB after minification for any application chunk.
2. THE Build_Process SHALL split the application such that no single JavaScript application chunk exceeds 500 kB uncompressed (excluding `.wasm` binaries), AND SHALL load the DuckDB-WASM engine as one or more dynamically imported chunks separate from the main application chunk.
3. WHEN the Build_Process runs, THE Build_Process SHALL produce all JavaScript chunks, `.wasm` binaries, worker files, and static assets referenced from the application's own origin with zero cross-origin or CDN host references.
4. WHEN the Airlock application has finished loading and the Egress_Monitor has settled, THE Airlock SHALL report an Egress_Monitor external-request count of zero.
5. WHEN a dynamically imported chunk introduced by code-splitting is loaded at runtime, THE Airlock SHALL load it from the application's own origin such that the Egress_Monitor classifies it as a same-origin asset load and not as an external request.
6. IF a write tool is invoked on the code-split Airlock, THEN THE Airlock SHALL route the change through the review queue and SHALL NOT apply the change until the matching proposal is approved.
