import { useEffect, useState } from "react";
import { subscribeEgress, getEgress, type EgressState } from "../lib/egress";
import { bytes } from "../lib/format";

/**
 * The seal indicator — Airlock's core claim, made measurable. It reads the
 * live egress monitor: bytes the page has tried to send, and external hosts
 * contacted. The promise is that after load this stays at zero.
 */
export function SealStatus() {
  const [egress, setEgress] = useState<EgressState>(getEgress);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeEgress(() => setEgress(getEgress())), []);

  const breached = egress.externalRequests > 0 || egress.bytesSent > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          breached
            ? "border-danger/50 bg-danger/10 text-danger"
            : "border-airlock-700/50 bg-airlock-700/10 text-airlock-300 hover:bg-airlock-700/20"
        }`}
        title="What has left this browser"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            breached ? "bg-danger" : "bg-airlock-400"
          }`}
        />
        {breached
          ? `${egress.externalRequests} external · ${bytes(egress.bytesSent)}`
          : "Sealed · 0 bytes out"}
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-30 w-80 animate-slide-in rounded-lg border border-ink-700 bg-ink-900 p-4 text-xs shadow-2xl">
          <p className="mb-2 font-semibold text-white">
            {breached ? "Data has left the page" : "Nothing has left this page"}
          </p>
          <p className="leading-relaxed text-slate-400">
            Your file is read locally and queried by DuckDB-WebAssembly in this
            tab. The monitor wraps <code className="text-slate-300">fetch</code>,{" "}
            <code className="text-slate-300">XMLHttpRequest</code>,{" "}
            <code className="text-slate-300">sendBeacon</code> and{" "}
            <code className="text-slate-300">WebSocket</code>.
          </p>
          <dl className="mt-3 space-y-1.5 border-t border-ink-800 pt-3 font-mono">
            <Row k="Request-body bytes sent" v={bytes(egress.bytesSent)} bad={egress.bytesSent > 0} />
            <Row k="External requests" v={String(egress.externalRequests)} bad={egress.externalRequests > 0} />
            <Row k="Same-origin asset loads" v={String(egress.assetRequests)} />
            <Row
              k="Hosts contacted"
              v={egress.hosts.length ? egress.hosts.join(", ") : "—"}
              bad={egress.hosts.length > 0}
            />
          </dl>
          <p className="mt-3 border-t border-ink-800 pt-2 text-[11px] leading-relaxed text-slate-500">
            The agent still receives whatever a read tool returns to it — see the
            Activity ledger for every query and payload.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{k}</dt>
      <dd className={bad ? "text-danger" : "text-airlock-300"}>{v}</dd>
    </div>
  );
}
