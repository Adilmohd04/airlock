# Staged Agent Authority

_A protocol for letting an AI agent act on data it must not exfiltrate, such
that the acting is **provable** rather than promised._

Version 0.1 (draft) · 2026-09-02 · Reference implementation: Airlock ·
Primitive: [`webmcp-staged`](../packages/webmcp-staged)

---

## 0. Why this is a protocol, not a feature

Every agent-on-data product makes two promises: "the agent won't leak your
data" and "the agent won't change things behind your back." Both are almost
always **assertions** — a sentence in a privacy policy, a toggle in a settings
panel. A security reviewer cannot check them, so they don't.

Staged Agent Authority (SAA) is an attempt to make those two promises
**checkable by a third party who does not trust the vendor**. It does that with
three commitments that are structural, not optional:

1. **Reads are disclosed; writes are gated.** The agent may read through a fixed
   tool surface, but it is *structurally incapable* of committing a write — a
   human is the only party that can. Not "shouldn't"; *can't*.
2. **Everything the agent saw is recorded.** A monotonic ledger captures every
   tool call and how many rows/columns it returned, so "what did the model
   actually see?" has an exact answer.
3. **The session emits a signed receipt.** A portable, offline-verifiable
   attestation states — over a signature the vendor cannot forge after the fact
   — which data was touched, that N bytes left the device, which model ran and
   where, and the hash of the inputs. It contains **no raw values**.

The claim SAA makes is narrow and therefore defensible: *not* "trust us with
your data," but "here is a document that proves what happened, and you can check
it without us."

## 1. Terminology

- **Principal** — the human operator. The only party that can authorize a
  write.
- **Agent** — the model (local or cloud) driving the tools. Untrusted with
  respect to writes; disclosure-limited with respect to reads.
- **Tool surface** — the fixed set of operations the page exposes to the agent
  (WebMCP `document.modelContext` in the reference implementation).
- **Read tool** — an operation annotated `readOnlyHint: true`. Runs immediately.
  Discloses data to the agent; never mutates committed state.
- **Staged tool** — a mutating operation, split into a `propose` / `commit` /
  `reject` trio.
- **Proposal** — a staged, not-yet-applied change with a stable id and a
  structured, human-renderable preview.
- **Ledger** — the append-only record of every tool call.
- **Egress monitor** — the runtime counter of every byte the page tries to send
  to the network.
- **Attestation (receipt)** — the signed, portable session summary.

## 2. The authority contract

A conforming implementation MUST enforce all of the following.

### 2.1 The read/write split is honest

- A read tool MUST NOT change committed state. It MAY compute over the data and
  return a bounded result to the agent.
- Every mutating operation MUST be a staged tool. There MUST be **no** tool that
  applies a change to committed state in a single agent-callable step.

### 2.2 Commit requires the Principal

- `propose_<x>` stages a `Proposal` and returns its id. It is itself
  read-only from the host's perspective (it changes nothing yet).
- `commit_<x>` MUST refuse unless the referenced proposal has been **approved by
  the Principal** through a channel the agent does not control. In the reference
  implementation the agent is not even given `commit_*`/`reject_*` in its tool
  list — approval and commit happen in the human UI (`reviewController`).
- A refused commit MUST be recorded in the ledger (`denied`).

### 2.3 Both paths converge

- The human "Approve" action and any programmatic commit MUST run the *same*
  underlying mutation. There is no privileged "agent path" that differs from the
  "human path." This is what makes the ledger a complete account.

### 2.4 Everything is ledgered

- Every tool call — `read`, `propose`, `commit`, `reject`, `denied` — MUST
  append one entry to the ledger with: a stable id, a timestamp, the tool name,
  the arguments, a summary, and (for reads) the rows/columns disclosed.
- The ledger is append-only within a session.

### 2.5 No claim the monitor can contradict

- An implementation MUST NOT display a data-handling claim that its own egress
  monitor or ledger can falsify. Specifically: the phrase "0 bytes out" (or
  equivalent) MUST be a *measured* readout of the egress monitor, never a static
  label. When a cloud agent is active, the UI MUST state, in plain language,
  that the rows/columns each query returns are disclosed to that host.

## 3. Threat model

SAA is designed against the following adversaries. For each, what stops it.

| Threat | Defense in SAA |
| --- | --- |
| **Agent silently mutates data** | Structural: no single-step write tool; commit needs the Principal (§2.2). |
| **Agent exfiltrates via a tool** | Reads are bounded and ledgered; the egress monitor counts every byte; in local mode the model has no network of its own. |
| **Agent exfiltrates via SQL** (`read_csv('http://…')`, stacked statements, comment-hidden payloads) | A single-pass SQL lexer guards every fragment at the tool boundary (reference impl: `engine/duckdb.ts`). |
| **Agent reads a column it was told not to** | Redaction is enforced at view-build time *and* re-checked at the tool boundary; a redacted column is unnameable and never returned. |
| **Vendor lies in the receipt after the fact** | The receipt is signed with a per-install key the vendor would have to compromise to forge; any field edit breaks verification (§5). |
| **Receipt is tampered with in transit** | Signature over canonical bytes; a standalone verifier re-checks it offline (§6). |
| **Receipt leaks the very data it attests over** | The receipt carries only hashes, counts, and names the Principal already knows — never a raw cell value (§5.3). This is a MUST. |
| **Replay / reordering of receipts** | Receipts are hash-chained: each references the hash of the previous, so a sequence is tamper-evident (§5.2). |

**Explicit non-goals.** SAA does not defend against: a malicious *Principal*
(they are the trust root); a compromised browser/OS; a cloud agent legitimately
receiving disclosed rows (that disclosure is recorded, not prevented — the
receipt's job is to state it exactly); or side channels below the JS layer.
Naming these is part of the honesty discipline — a threat model that claims to
cover everything is the half-truth SAA exists to avoid.

## 4. The disclosure ledger

The ledger is the factual basis of the receipt. Each entry:

```
ActivityEntry {
  id: string            // stable, unique within the session
  ts: number            // epoch ms
  kind: "read" | "propose" | "commit" | "reject" | "denied"
  tool: string
  args: object          // the agent's arguments
  summary: string
  returned?: { rows?: number, columns?: string[] }   // reads only
  proposalId?: string
}
```

Derived facts the receipt uses: **rows disclosed** (sum of `returned.rows`) and
**distinct columns seen** (union of `returned.columns`). These quantify
disclosure precisely — the honest answer to "the file never left, but what did
the model actually see?"

## 5. The attestation (receipt) format

A receipt is a single JSON object. Version `saa/0.1`.

### 5.1 Structure

```
AttestationReceipt {
  format: "saa/0.1"
  receipt: {
    id: string                 // uuid for this receipt
    issuedAt: string           // ISO-8601
    app: { name, version, gitSha }
    session: { id, startedAt, endedAt }

    dataset: {
      name: string
      sha256: string           // hash of the RAW input bytes
      rows: number
      columns: number
      redactedColumns: string[]   // names only, never values
    }[]

    agent: {
      modes: ("local" | "cloud" | "byo-endpoint")[]  // every mode used this session
      // For any cloud disclosure, the host and the exact disclosure totals:
      cloud?: { host: string, rowsDisclosed: number, distinctColumns: number }
      // For local execution, the model and that it ran on-device:
      local?: { modelId: string, ranOnDevice: true }
    }

    disclosure: {
      rowsDisclosed: number
      distinctColumnsSeen: string[]
      toolCalls: number
      commits: number
      denied: number
    }

    egress: {
      externalRequests: number
      bytesSent: number
      hosts: string[]
      sealed: boolean
    }

    ledgerSha256: string        // hash of the canonicalized full ledger
    previousReceiptSha256: string | null   // hash chain (§5.2)
  }
  signature: {
    alg: "Ed25519"
    publicKey: string           // base64url, the per-install key
    value: string               // base64url signature over canonical(receipt)
  }
}
```

### 5.2 Hash chain

`receipt.previousReceiptSha256` is the SHA-256 of the canonicalized `receipt`
object of the immediately prior receipt from the same install, or `null` for the
first. A verifier given a sequence checks each link. This makes dropping,
reordering, or substituting a receipt in a series detectable.

### 5.3 What a receipt MUST NOT contain

- No raw cell value, ever. Only hashes, counts, and identifiers (dataset names,
  column names, host names, model ids) the Principal already possesses.
- `dataset.sha256` is over the raw *bytes*; it proves which file was analyzed
  without embedding it.
- The `ledgerSha256` commits to the full ledger without inlining tool arguments
  that could contain a literal value. The full ledger is exported separately if
  the Principal chooses; the receipt only commits to its hash.

### 5.4 Canonicalization

Signing and hashing are over a **deterministic** serialization: object keys
sorted lexicographically, no insignificant whitespace, UTF-8, arrays in their
given order. Two implementations MUST produce byte-identical canonical bytes for
the same logical `receipt`, or signatures will not verify across tools.

## 6. Verification

A verifier — which MUST be able to run **offline with no dependency on the
issuer** — checks, in order:

1. `format === "saa/0.1"`.
2. Recompute `canonical(receipt)`; verify `signature.value` against it using
   `signature.publicKey` and Ed25519.
3. If a chain is presented, verify each `previousReceiptSha256` link.
4. (Optional, if the raw file is on hand) recompute `dataset.sha256` and compare.

Editing **any** field of `receipt` changes the canonical bytes, so step 2 fails.
That is the whole point: the receipt is either intact and signed by the claimed
install, or it is rejected. The reference verifier is a single static
`verify.html` — open it, drop a receipt in, no network.

## 7. Conformance

An implementation conforms to SAA 0.1 if it satisfies every MUST in §2, records
the ledger of §4, and emits receipts per §5 that pass the §6 verification.

The reference implementation is **Airlock** (the app) built on **`webmcp-staged`**
(the primitive: the propose/commit/reject trio and the proposal store). The
primitive is transport-bound to WebMCP today but the contract in §2 is
transport-agnostic — the same split applies to any tool-calling agent host.

## 8. Status and honesty

This is a 0.1 draft, published to be argued with. What is genuinely proven today
is the *mechanism*: the read/write split, the lexer-guarded tool boundary, the
egress monitor, the ledger, and (with this document's implementation) the signed
receipt and its offline verifier. What is **not** proven is adoption — SAA is a
protocol a second implementer has not yet built against. Saying so is itself part
of the discipline the protocol demands.
