/**
 * AttestationPanel — one click turns the current session into a signed,
 * portable Staged Agent Authority receipt (see docs/PROTOCOL.md).
 *
 * This is the moat surface. It reads the session's own record — the ledger, the
 * egress monitor, the datasets, the agent mode — and produces:
 *   1. `airlock-attestation-<date>.json`  — the signed receipt (verify offline
 *      at /verify.html), and
 *   2. a printable one-page HTML summary of the same facts.
 *
 * It asserts nothing the receipt can't back: the panel shows the measured
 * egress and disclosure counts straight from the stores, and the receipt
 * carries only hashes/counts/identifiers — never a raw value.
 */

import React from "react";
import { usePersistence } from "../lib/persistence";
import {
  buildReceipt,
  receiptToJson,
  receiptToPrintableHtml,
  verifyReceipt,
  type AttestationReceipt,
} from "../lib/attestation";
import { getEgress } from "../lib/egress";
import { activityLog } from "../agent/activity";

function download(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export function AttestationPanel() {
  const persistence = usePersistence();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState<{
    receipt: AttestationReceipt;
    verified: boolean;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // A stable session id + start for the receipt. Prefer the persisted session;
  // fall back to an ephemeral one so a receipt is still producible before the
  // first autosave (honest: it just won't chain to a stored history).
  const sessionMeta = persistence.sessions.find(
    (s) => s.id === persistence.currentSessionId
  );
  const sessionRef = React.useRef({ id: `ephemeral-${Date.now()}`, startedAt: Date.now() });
  // SessionMeta exposes updatedAt (last activity), not createdAt — use it as the
  // session marker. The receipt's session.startedAt is thus "as of last save".
  const session = sessionMeta
    ? { id: sessionMeta.id, startedAt: sessionMeta.updatedAt }
    : sessionRef.current;

  const egress = getEgress();

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const receipt = await buildReceipt({ session });
      const verified = await verifyReceipt(receipt); // self-check before we hand it over
      setLast({ receipt, verified });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    if (!last) return;
    download(
      `airlock-attestation-${dateStamp()}.json`,
      receiptToJson(last.receipt),
      "application/json"
    );
  };

  const exportHtml = () => {
    if (!last) return;
    download(
      `airlock-attestation-${dateStamp()}.html`,
      receiptToPrintableHtml(last.receipt),
      "text/html"
    );
  };

  const entries = activityLog.list().length;

  return (
    <div className="relative">
      <button
        type="button"
        className="btn btn-ghost shrink-0 whitespace-nowrap !px-2 !py-1 text-xs"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Produce a signed, verifiable record of what the agent did this session"
      >
        Attestation
      </button>

      {open && (
        <div className="card absolute right-0 z-30 mt-2 w-80 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="panel-title">Session attestation</span>
            <button
              className="text-xs text-slate-500 hover:text-slate-300"
              onClick={() => setOpen(false)}
            >
              close
            </button>
          </div>

          <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
            A signed, portable record of exactly what happened this session —
            which data was touched, how many network requests carried data out
            ({egress.externalRequests} — 0 means none did), and which model ran
            where. It carries hashes and counts, never your values. Verify it
            offline at{" "}
            <span className="font-mono text-slate-300">/verify.html</span>.
          </p>

          <div className="mb-2 rounded-md bg-ink-950 px-2 py-1.5 font-mono text-[11px] text-slate-400">
            <div>{entries} tool call(s) ledgered</div>
            <div>{activityLog.rowsDisclosed()} row(s) disclosed</div>
            <div className={egress.externalRequests === 0 ? "text-commit" : "text-danger"}>
              egress: {egress.externalRequests} external · {egress.bytesSent} bytes
            </div>
          </div>
          <p className="mb-2 text-[10px] leading-relaxed text-slate-600">
            Disclosed rows reach the agent inside this tab — that is counted
            above. Egress counts only network requests that carried data out.
          </p>

          {error && <p className="mb-2 text-[11px] text-danger">{error}</p>}

          {!last ? (
            <button
              className="btn btn-primary w-full text-xs"
              onClick={generate}
              disabled={busy}
            >
              {busy ? "Signing…" : "Generate signed receipt"}
            </button>
          ) : (
            <div className="space-y-2">
              <p
                className={`text-[11px] ${last.verified ? "text-commit" : "text-danger"}`}
              >
                {last.verified
                  ? "✓ Receipt generated and self-verified."
                  : "✗ Self-verification failed — do not trust this receipt."}
              </p>
              <div className="flex gap-2">
                <button className="btn btn-primary flex-1 text-xs" onClick={exportJson}>
                  Download .json
                </button>
                <button className="btn btn-ghost flex-1 text-xs" onClick={exportHtml}>
                  Printable
                </button>
              </div>
              <button
                className="btn btn-ghost w-full text-xs"
                onClick={() => setLast(null)}
              >
                Regenerate
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
