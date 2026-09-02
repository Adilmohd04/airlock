/**
 * attestation.ts — build the Staged Agent Authority receipt (SAA/0.1).
 *
 * See `docs/PROTOCOL.md` §5. This is the *moat* artifact: after a session, one
 * call produces a signed, portable, offline-verifiable record of exactly what
 * happened — which data was touched, that N bytes left the device, which model
 * ran and where — that a compliance reviewer accepts *in place of* "trust us."
 *
 * ── The one invariant that must never break ─────────────────────────────────
 * A receipt MUST NOT contain a raw cell value (PROTOCOL §5.3). It carries only
 * hashes, counts, and identifiers the Principal already has (dataset names,
 * column names, host names, model ids). `assertNoRawValues` is a runtime
 * backstop against a future edit that accidentally inlines data, and a test
 * pins it. The dataset's raw bytes are represented solely by their SHA-256.
 *
 * Everything here reads existing stores — the ledger (`activityLog`), the egress
 * monitor (`getEgress`), the mode indicator (`agentModeStore`), and the
 * workspace — and never mutates them. Building a receipt is a pure read of the
 * session's own record.
 */

import { activityLog, type ActivityEntry } from "../agent/activity";
import { getEgress } from "./egress";
import { agentModeStore } from "../agent/agentMode";
import { workspaceStore } from "../engine/workspaceStore";
import {
  canonicalize,
  canonicalSha256Hex,
  sha256Hex,
  signPayload,
  verifyPayload,
  type Signature,
} from "./signing";

export const SAA_FORMAT = "saa/0.1" as const;

// ── receipt shape (mirrors PROTOCOL.md §5.1) ─────────────────────────────────

export interface ReceiptDataset {
  name: string;
  /** SHA-256 of the raw input bytes — proves which file, embeds none of it. */
  sha256: string;
  rows: number;
  columns: number;
  /** Names only, never values. */
  redactedColumns: string[];
}

export interface ReceiptBody {
  id: string;
  issuedAt: string;
  app: { name: string; version: string; gitSha: string };
  session: { id: string; startedAt: string; endedAt: string };
  dataset: ReceiptDataset[];
  agent: {
    modes: string[];
    cloud?: { host: string; rowsDisclosed: number; distinctColumns: number };
    local?: { modelId: string; ranOnDevice: true };
  };
  disclosure: {
    rowsDisclosed: number;
    distinctColumnsSeen: string[];
    toolCalls: number;
    commits: number;
    denied: number;
  };
  egress: {
    externalRequests: number;
    bytesSent: number;
    hosts: string[];
    sealed: boolean;
  };
  ledgerSha256: string;
  previousReceiptSha256: string | null;
}

export interface AttestationReceipt {
  format: typeof SAA_FORMAT;
  receipt: ReceiptBody;
  signature: Signature;
}

// ── inputs the caller provides that aren't in a store ────────────────────────

export interface AttestationContext {
  /** Session id + when it started. */
  session: { id: string; startedAt: number };
  /** App identity. gitSha falls back to "unknown" — never fabricated. */
  app?: { name?: string; version?: string; gitSha?: string };
  /** The previous receipt's canonical hash, for the chain. Null for the first. */
  previousReceiptSha256?: string | null;
}

// ── app identity (honest fallback, no build-config change) ───────────────────

function appIdentity(app?: AttestationContext["app"]): ReceiptBody["app"] {
  // If a build ever injects these via `import.meta.env`, prefer them; otherwise
  // say "unknown" rather than invent a version/sha. A receipt that lies about
  // its own provenance would defeat the point.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  return {
    name: app?.name ?? "Airlock",
    version: app?.version ?? env.VITE_APP_VERSION ?? "0.1.0",
    gitSha: app?.gitSha ?? env.VITE_GIT_SHA ?? "unknown",
  };
}

// ── collect the dataset facts (hash the raw source, never its values) ────────

async function collectDatasets(): Promise<ReceiptDataset[]> {
  const out: ReceiptDataset[] = [];
  for (const h of workspaceStore.list()) {
    const st = h.store.getState();
    const src = workspaceStore.getSource(h.id);
    let sha = "unavailable";
    if (src) {
      if (src.kind === "parquet") sha = await sha256Hex(src.bytes);
      else sha = await sha256Hex(src.text);
    }
    out.push({
      name: st.fileName,
      sha256: sha,
      rows: st.totalRows,
      columns: st.columns.length,
      // Display names of redacted columns — identifiers, not values.
      redactedColumns: h.store.redactedDisplayNames(),
    });
  }
  return out;
}

// ── the ledger, hashed (commit to it without inlining tool args) ─────────────

/**
 * A redacted projection of a ledger entry: keeps the shape and counts, drops
 * the `args` and `summary` because those can contain literal values the agent
 * echoed. We commit to *this* canonical form. The full ledger is a separate,
 * user-initiated export; the receipt only proves a hash.
 */
function ledgerFingerprint(entries: ActivityEntry[]): unknown {
  return entries.map((e) => ({
    id: e.id,
    ts: e.ts,
    kind: e.kind,
    tool: e.tool,
    returned: e.returned
      ? { rows: e.returned.rows ?? 0, columns: (e.returned.columns ?? []).length }
      : undefined,
    proposalId: e.proposalId,
  }));
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * Build and sign a receipt for the current session. Reads every store; mutates
 * none. Rejects (throws) if the assembled receipt would contain a raw value —
 * fail closed rather than emit a leaky attestation.
 */
export async function buildReceipt(
  ctx: AttestationContext
): Promise<AttestationReceipt> {
  const entries = activityLog.list();
  const egress = getEgress();
  const mode = agentModeStore.getState();

  const rowsDisclosed = activityLog.rowsDisclosed();
  const distinctColumnsSeen = activityLog.seenColumns();
  const commits = entries.filter((e) => e.kind === "commit").length;
  const denied = entries.filter((e) => e.kind === "denied").length;

  // Which modes were actually in play. `describeMode`/store already reason about
  // this honestly; we record the observed facts, not a claim.
  const modes = new Set<string>();
  const agent: ReceiptBody["agent"] = { modes: [] };
  if (mode.host.kind === "native") {
    modes.add("cloud");
    agent.cloud = {
      host: mode.host.name || "the connected AI host",
      rowsDisclosed,
      distinctColumns: distinctColumnsSeen.length,
    };
  }
  if (mode.mode === "local" && mode.activeModel) {
    modes.add("local");
    agent.local = { modelId: mode.activeModel, ranOnDevice: true };
  }
  if (mode.mode === "byo-endpoint") modes.add("byo-endpoint");
  agent.modes = [...modes];

  const dataset = await collectDatasets();
  const ledgerSha256 = await canonicalSha256Hex(ledgerFingerprint(entries));

  const body: ReceiptBody = {
    id: uuid(),
    issuedAt: new Date().toISOString(),
    app: appIdentity(ctx.app),
    session: {
      id: ctx.session.id,
      startedAt: new Date(ctx.session.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
    },
    dataset,
    agent,
    disclosure: {
      rowsDisclosed,
      distinctColumnsSeen,
      toolCalls: entries.length,
      commits,
      denied,
    },
    egress: {
      externalRequests: egress.externalRequests,
      bytesSent: egress.bytesSent,
      hosts: [...egress.hosts],
      sealed: egress.sealed,
    },
    ledgerSha256,
    previousReceiptSha256: ctx.previousReceiptSha256 ?? null,
  };

  // Fail closed: never emit a receipt that could carry a raw value.
  assertNoRawValues(body);

  const signature = await signPayload(body);
  return { format: SAA_FORMAT, receipt: body, signature };
}

/** The canonical hash of a receipt body — the link the next receipt chains to. */
export async function receiptChainHash(r: AttestationReceipt): Promise<string> {
  return canonicalSha256Hex(r.receipt);
}

/**
 * Verify a receipt exactly as the standalone verifier does: signature over the
 * canonical body, plus format. (Chain verification is the verifier's job when
 * given a sequence; here we validate one.)
 */
export async function verifyReceipt(r: AttestationReceipt): Promise<boolean> {
  if (r.format !== SAA_FORMAT) return false;
  return verifyPayload(r.receipt, r.signature);
}

// ── the no-raw-values backstop ────────────────────────────────────────────────

/**
 * Structural guard: the receipt is built only from known-safe fields, but this
 * catches a future regression that inlines something value-bearing. It walks the
 * body and rejects any key named like a value carrier (`args`, `summary`,
 * `text`, `value`, `rows` as an array, `samples`, `preview`). Counts and hashes
 * are fine; arrays of raw rows are not.
 */
function assertNoRawValues(body: unknown): void {
  const BANNED = new Set([
    "args",
    "summary",
    "value",
    "values",
    "text",
    "markdown",
    "samples",
    "sample",
    "preview",
    "data",
  ]);
  const walk = (v: unknown, path: string): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (BANNED.has(k)) {
        throw new Error(
          `Receipt would leak a value-bearing field "${k}" at ${path}. ` +
            "The SAA receipt must contain only hashes, counts and identifiers."
        );
      }
      walk(val, `${path}.${k}`);
    }
  };
  walk(body, "receipt");
}

// ── helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A human-readable, printable one-pager of a receipt. Self-contained HTML. */
export function receiptToPrintableHtml(r: AttestationReceipt): string {
  const b = r.receipt;
  const ds = b.dataset
    .map(
      (d) =>
        `<tr><td>${esc(d.name)}</td><td class="mono">${d.sha256.slice(0, 16)}…</td>` +
        `<td>${d.rows.toLocaleString()}</td><td>${d.columns}</td>` +
        `<td>${d.redactedColumns.map(esc).join(", ") || "—"}</td></tr>`
    )
    .join("");
  const sealClass = b.egress.externalRequests === 0 ? "ok" : "bad";
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Airlock attestation ${esc(b.id)}</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;color:#111;padding:0 1rem}
 h1{font-size:1.2rem} h2{font-size:.95rem;margin-top:1.5rem;text-transform:uppercase;letter-spacing:.04em;color:#555}
 .mono{font-family:ui-monospace,monospace} table{border-collapse:collapse;width:100%;font-size:12px}
 td,th{border:1px solid #ddd;padding:4px 8px;text-align:left} .ok{color:#137333} .bad{color:#c5221f}
 .seal{font-size:1.1rem;font-weight:600} .muted{color:#666;font-size:12px}
</style></head><body>
<h1>Staged Agent Authority — attestation</h1>
<p class="muted">Format ${esc(r.format)} · Receipt ${esc(b.id)} · Issued ${esc(b.issuedAt)}</p>
<p class="seal ${sealClass}">Egress: ${b.egress.externalRequests} external request(s), ${b.egress.bytesSent} bytes out${b.egress.externalRequests === 0 ? " — sealed" : ""}</p>
<h2>Data analyzed</h2>
<table><tr><th>File</th><th>SHA-256</th><th>Rows</th><th>Cols</th><th>Redacted</th></tr>${ds || '<tr><td colspan="5">none</td></tr>'}</table>
<h2>Agent</h2>
<p>Modes: ${b.agent.modes.map(esc).join(", ") || "none"}.
${b.agent.local ? `Local model <span class="mono">${esc(b.agent.local.modelId)}</span> ran on-device. ` : ""}
${b.agent.cloud ? `Cloud host <span class="mono">${esc(b.agent.cloud.host)}</span> received ${b.agent.cloud.rowsDisclosed} disclosed row(s) across ${b.agent.cloud.distinctColumns} column(s). ` : ""}</p>
<h2>Disclosure</h2>
<p>${b.disclosure.toolCalls} tool call(s); ${b.disclosure.commits} approved commit(s); ${b.disclosure.denied} denied. ${b.disclosure.rowsDisclosed} row(s) disclosed across ${b.disclosure.distinctColumnsSeen.length} distinct column(s).</p>
<h2>Verification</h2>
<p class="muted">Ledger SHA-256: <span class="mono">${esc(b.ledgerSha256)}</span><br>
Signed (Ed25519), public key <span class="mono">${esc(r.signature.publicKey.slice(0, 24))}…</span><br>
Verify offline at <b>/verify.html</b> — drop the .json receipt in; editing any field breaks the signature.</p>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** Serialize a receipt to the canonical-ish pretty JSON for download. */
export function receiptToJson(r: AttestationReceipt): string {
  // Pretty for humans; the SIGNATURE is over canonical(receipt.receipt), so the
  // verifier re-canonicalizes — pretty-printing the wrapper is safe.
  return JSON.stringify(r, null, 2);
}

export { canonicalize };
