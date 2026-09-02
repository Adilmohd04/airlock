# Airlock — North Star

_The definitive positioning and strategy doc. Reconciles two independent strategy
reviews (Claude fork + Kiro/GPT research) that reached the same conclusion._

Last updated: 2026-09-01 · Owner: Sadath · Status: direction locked, execution open

---

## 1. The thesis (one sentence)

**Airlock is the verifiable way to let AI work with data you are not allowed to
share — with cryptographic proof of exactly what any model saw, and an option to
run the model entirely on your own device so nothing leaves at all.**

Not "a data workspace." Not "chat with your data." The product is **provable data
handling for AI**, and the workspace is how you deliver it.

---

## 2. The problem is real, painful, and widespread

"I want AI help with this data but I can't paste it into ChatGPT" is a daily
blocker for millions of knowledge workers: compensation, financials, customer
lists, contracts, patient data, logs, anything under NDA or regulation.

It is not hypothetical — it is documented and getting worse (2026):

- ~11% of content pasted into ChatGPT contains confidential information.
- ~20% of 2025 data breaches involved shadow AI (employees using unsanctioned
  tools).
- A Feb 2026 federal ruling pulled 31 Claude chat sessions into a prosecution —
  AI chats are not privileged and are discoverable.
- HR / compensation / legal / health data is singled out as the highest-risk
  category to expose.

The pain grows structurally: AI capability and adoption are outrunning corporate
data governance. That gap is the wedge.

**Which of the three sub-problems we lead with matters:**

| Sub-problem | Strength | Notes |
| --- | --- | --- |
| **Privacy** — "this cannot go to a third party" | Strongest, underserved | Lead here — _if the claim survives scrutiny_ (see §3) |
| **Control** — "don't let the agent silently mutate things" | Real, narrower | This is the `webmcp-staged` primitive; a supporting act |
| **Capability** — "ChatGPT can't query my 2M-row file well" | Real, crowded | Code Interpreter, Julius, Hex, Claude analysis — do not lead here |

---

## 3. The flaw at the core — and the fix

**"Your data never leaves the browser" is not true when a cloud agent drives.**
The raw file stays local, but the moment ChatGPT calls `run_sql` and gets 200
rows back, those rows — and the column values, and the questions asked — are in
OpenAI's context window. Airlock's own activity ledger measures this exactly
("rows disclosed").

A security reviewer catches this in 30 seconds. If they feel misled, they are
gone permanently — and they are precisely the buyer who matters.

**Two fixes, do both:**

### Fix A — Bring-your-own-model, including fully in-browser (the "god mode" move)

Run the model on the user's own device via **WebLLM + WebGPU** (or a company's
private Azure/Bedrock endpoint). Then "nothing leaves this tab — not the file,
not a single value, not the questions" is **literally true, end to end.**

This is now technically real, not wishful:

- WebGPU + WebLLM/Transformers.js run Qwen 2.5 3B, Llama 3.2 3B, Phi-3.5 at
  ~80% of native speed, entirely on the user's GPU.
- Small models now do **reliable tool-calling over long sequences** (Qwen 2.5,
  purpose-built local-agent models). Airlock's tools have tight schemas, which is
  exactly what small models need.
- Airlock's architecture _already_ assumes an external tool-caller. A local model
  is just another WebMCP client calling the same registered tools. The
  propose → approve → commit gate is unchanged.

The demo that makes people say "no way": airplane mode, load a comp CSV, ask
"find pay gaps by gender, flag anyone >15% below market, write a summary" — and
watch it happen, offline, Seal reading 0 bytes, every mutation staged.

### Fix B — Reframe the headline around the receipt

Even with a cloud model, the honest and still-valuable claim is: **"your raw file
never leaves; only the specific slices the agent queried do — and here is a
signed, timestamped record of exactly what those were."**

That record is a **compliance artifact companies pay consultants to produce.**
Sell it as the deliverable, not a footnote.

---

## 4. Positioning: what Airlock is (and is not)

**Is:** "The verifiable way to let AI work with data you can't share."
**Is not:** "An agent-native data workspace for everyone."

The second framing has a claim that is half-true and a market that is
everyone-and-therefore-no-one. Kill it.

### Do not go horizontal yet

The core tech (in-browser DuckDB + WebMCP tools + staged approval + egress proof
+ local LLM) is domain-agnostic, so horizontal expansion is possible **later**.
Building for "individual, manager, founder, support agent, salesperson, analyst,
developer" simultaneously is the single most reliable way to build something
nobody feels is theirs — no sharp copy, no workflow depth, no word of mouth.

Figma started with UI designers. Linear with dev teams. Notion with notes.
**Horizontal is earned, not a starting position.**

### The beachhead: pay-equity / compensation analysis

Airlock's existing comp demo is a genuinely strong wedge:

- Sensitive data (the textbook "cannot paste this" case).
- Recurring workflow — comp cycles, pay-equity audits, board prep — not one-off.
- A real buyer with budget: People / Total Rewards / employment counsel.
- A compliance angle (pay-transparency laws in EU, UK, US states) that makes the
  audit trail a requirement, not a nicety.

Become "the only safe way to do AI-assisted pay-equity analysis," own that
completely, then widen to adjacent regulated-data workflows (financial close,
vendor-contract review, clinical-ops reporting).

---

## 5. The moat — three assets competitors will not easily copy

Each individual ingredient exists elsewhere. Only the **complete, provable,
offline, human-gated loop** is defensible. Rank of durability:

1. **Verifiable trust receipt.** Signed, timestamped, exportable
   data-handling attestation: what the agent saw, that 0 bytes left, which model
   ran and where, hashes of inputs and outputs. Built on top of the existing
   egress monitor + activity ledger — cheap to build, enormous credibility. This
   is the thing a compliance reviewer accepts in place of "trust me."
2. **Fully-local agent loop.** File + compute + model + approval all on-device.
   A platform can copy "local files + approval gating" in a quarter; a browser
   product where the _model itself_ never phones home is a different claim.
3. **The honesty discipline already in the code.** The `readOnlyHint` split, an
   egress monitor that actually backs the claim, every tool call logged, base
   table immutable. This is rare and it is the seed of the trust brand the whole
   strategy rests on. Protect it ruthlessly — one dishonest claim burns it.

---

## 6. Competitive map

| Category | Players | Where Airlock wins |
| --- | --- | --- |
| Cloud AI data analysis | ChatGPT Code Interpreter, Claude analysis tool, Gemini | Data never uploaded; provable |
| Chat-with-data apps | Julius, Hex Magic, Count, Fabi | Local compute + approval + audit; not cloud |
| Local LLM runners | Ollama, LM Studio, Jan | Agentic data work + approval UX + browser-native, zero install for the app |
| DuckDB-WASM apps | Rill, Evidence, MotherDuck | Agent-native + human-gated mutation |
| Incumbent | Excel + Copilot | The "cannot send this to Microsoft" segment |

**The platform-absorption risk is real.** OpenAI/Anthropic/Google all have data
analysis; "local files + approval" is a small feature for them. The defense is
the trust/audit/compliance layer plus vertical workflow depth — never the raw
tech.

---

## 7. Roadmap (summary — full spec in `BUILD_PROMPT.md`)

| Tier | What | Why | Effort |
| --- | --- | --- | --- |
| **0 — Baseline integrity** | Finish data-io (xlsx/parquet/clipboard), merge green branches, close egress-guard holes, ship the hackathon submission | Protects what exists | Low |
| **1 — Fully-local agent** | In-browser LLM (WebLLM + WebGPU) driving Airlock's WebMCP tools, offline, with a dead-simple model-download step | Makes the privacy claim literally true; the "amazed" moment | High — the headline build |
| **2 — The moat** | Trust receipt · redaction + local model = provable blindfolding · provenance-linked reports · local multi-source (folder, Postgres, Sheet) | Turns a demo into a product with a durable moat | Medium each, sequence by buyer |

**Sequencing:** Tier 0 now (protect the base) → Tier 1 spec + build (headline) →
Tier 2 #1 trust receipt (highest credibility per hour) → the rest by which buyer
you are chasing.

---

## 8. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Privacy claim fails a security review | Fatal | Fix A + Fix B (§3). Never state a claim the ledger can contradict. |
| WebMCP adoption stalls | High | It is live in ChatGPT desktop + Chrome 146 but ~0% real adoption — first-mover, not dead. Keep the local agent + Agent console as a path that does not need WebMCP to win. |
| Platform absorbs the feature | High | Moat = audit/compliance + vertical depth, not tech. Ship the receipt fast. |
| Approval fatigue kills UX | Medium | Reversibility-aware gating: hard-gate egress / destructive / expensive actions, auto-allow reversible view transforms. |
| DuckDB-WASM memory limits | Medium | Be honest about row ceilings; stream/paginate; test the "2M rows" claim before making it. |
| Local model too weak to drive tools | Medium | Tight tool schemas (already have them), constrained agent loop, curated model list, cloud-agent fallback always available. |
| Thin app layer, weak moat | Medium | See §5 — the moat is the loop + the brand, and both compound with use. |

---

## 9. What "top 1%" looks like if we execute

- A compliance-bound team (HR, legal, health, finance) adopts Airlock because it
  is the **only** tool that lets them use AI on their data without a policy
  violation — and they can prove it to their auditor with one export.
- "Airlock it" becomes the verb for "run this past AI safely."
- The trust receipt is cited in a real audit or a real deal.
- Expansion to a second vertical comes from inbound, not outbound.

If we ship the current "workspace for everyone, data never leaves" version
instead, it is a strong hackathon project that the platforms out-feature within a
year. **The gap between those two outcomes is focus and execution, not a new
invention.**

---

## 10. Non-negotiables (carry over from `CLAUDE.md`, and they get stricter)

- The base table is immutable; writes are staged; the read/write split is honest.
- Egress stays at zero and the Seal proves it.
- Every tool call hits the activity ledger.
- **New:** never publish a privacy claim the activity ledger or egress monitor
  can contradict. If the local model is not active, the UI says "slices of your
  data are going to <provider>" in plain language — not buried.
- `webmcp-staged` is extended, never rewritten.
