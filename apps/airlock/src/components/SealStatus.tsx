import { useEffect, useState } from "react";
import { subscribeEgress, getEgress, type EgressState } from "../lib/egress";
import { bytes } from "../lib/format";
import { activityLog } from "../agent/activity";
import { useActivity } from "../agent/hooks";
import { useAgentMode } from "../agent/agentMode";
import { uiStore } from "../engine/uiStore";

/**
 * The Seal — Airlock's core claim, made measurable. It reads the live egress
 * monitor: request-body bytes the page tried to send, and external hosts
 * contacted. Never hardcoded — always `getEgress()` / `subscribeEgress()`.
 *
 * The network count alone is not the whole truth when a native WebMCP host is
 * attached: that host calls tools and receives their results over a channel
 * this monitor cannot see (it is not `fetch`/XHR/beacon/WebSocket). "0 bytes
 * out" would read the same whether the host has just received 500 rows or
 * none. So when a native host is connected the Seal drops the reassuring teal
 * "0 bytes out" entirely, turns amber, and points at the activity ledger's
 * actual disclosure count — the honest measurement (NORTH_STAR.md §3, Fix B).
 *
 * Host presence is keyed off `agentMode`'s detected host, not the selected
 * mode: a host that is attached can call tools regardless of which mode this
 * page's own switcher shows.
 */
export function SealStatus() {
  const [egress, setEgress] = useState<EgressState>(getEgress);
  const [open, setOpen] = useState(false);
  const mode = useAgentMode();
  useActivity(); // re-render when the ledger changes, for the counts below

  useEffect(() => subscribeEgress(() => setEgress(getEgress())), []);

  const breached = egress.externalRequests > 0 || egress.bytesSent > 0;
  const hostConnected = mode.host.kind === "native";
  const hostName = mode.host.name || "the connected AI host";
  const tone = toneFor(breached, hostConnected);

  const rows = activityLog.rowsDisclosed();
  const cols = activityLog.seenColumns();

  const openLedger = () => {
    if (!uiStore.getState().activityOpen) uiStore.toggleActivity();
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${tone.border}`}
        title="What has left this browser over the network"
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
        {breached
          ? `${egress.externalRequests} external · ${bytes(egress.bytesSent)}`
          : hostConnected
            ? rows > 0
              ? `Host connected · ${rows.toLocaleString()} rows disclosed`
              : "Host connected · 0 rows so far"
            : "Sealed · 0 bytes out"}
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-30 w-80 animate-slide-in rounded-lg border border-ink-700 bg-ink-900 p-4 text-xs shadow-2xl">
          <p className="mb-2 font-semibold text-white">
            {breached
              ? "Data has left the page"
              : hostConnected
                ? "Nothing left over the network — but a connected host reads results"
                : "Nothing has left this page"}
          </p>

          <p className="leading-relaxed text-slate-400">
            {hostConnected && !breached ? (
              <>
                This monitor watches this page's own network calls —{" "}
                <code className="text-slate-300">fetch</code>,{" "}
                <code className="text-slate-300">XMLHttpRequest</code>,{" "}
                <code className="text-slate-300">sendBeacon</code>,{" "}
                <code className="text-slate-300">WebSocket</code> — and all four
                read zero. It cannot see the separate channel {hostName} uses to
                call tools and receive their results. That is a real, separate
                disclosure, counted below and itemised in the activity ledger.
              </>
            ) : (
              <>
                Your file is read locally and queried by DuckDB-WebAssembly in
                this tab. The monitor wraps{" "}
                <code className="text-slate-300">fetch</code>,{" "}
                <code className="text-slate-300">XMLHttpRequest</code>,{" "}
                <code className="text-slate-300">sendBeacon</code> and{" "}
                <code className="text-slate-300">WebSocket</code>.
              </>
            )}
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
            {hostConnected && (
              <>
                <Row
                  k="Rows returned to agent tools"
                  v={rows.toLocaleString()}
                  attention={rows > 0}
                />
                <Row
                  k="Columns agent tools have read"
                  v={cols.length ? String(cols.length) : "0"}
                  attention={cols.length > 0}
                />
              </>
            )}
          </dl>

          {hostConnected ? (
            <button
              onClick={openLedger}
              className="mt-3 border-t border-ink-800 pt-2 text-[11px] text-airlock-400 hover:underline"
            >
              Open the activity ledger — every query and payload →
            </button>
          ) : (
            <p className="mt-3 border-t border-ink-800 pt-2 text-[11px] leading-relaxed text-slate-500">
              The agent still receives whatever a read tool returns to it — see
              the activity ledger for every query and payload.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function toneFor(breached: boolean, hostConnected: boolean) {
  if (breached) {
    return { dot: "bg-danger", border: "border-danger/50 bg-danger/10 text-danger" };
  }
  if (hostConnected) {
    return { dot: "bg-pending", border: "border-pending/40 bg-pending/10 text-pending" };
  }
  return {
    dot: "bg-airlock-400",
    border:
      "border-airlock-700/50 bg-airlock-700/10 text-airlock-300 hover:bg-airlock-700/20",
  };
}

function Row({
  k,
  v,
  bad,
  attention,
}: {
  k: string;
  v: string;
  bad?: boolean;
  attention?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{k}</dt>
      <dd className={bad ? "text-danger" : attention ? "text-pending" : "text-airlock-300"}>
        {v}
      </dd>
    </div>
  );
}
