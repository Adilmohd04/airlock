import { useEffect, useState } from "react";
import {
  agentModeStore,
  describeMode,
  measuredHeadline,
  useAgentMode,
  type AgentMode,
  type AgentModeState,
} from "../agent/agentMode";
import { uiStore } from "../engine/uiStore";
import { getEgress, subscribeEgress, type EgressState } from "../lib/egress";
import { activityLog } from "../agent/activity";
import { useActivity } from "../agent/hooks";

// Static because `tools.tsx` is frozen and registers the surface
// unconditionally. Keep in step with `agent/tools.tsx`: 8 `registerTool`
// (list_datasets, get_dataset_summary, list_columns, profile_column,
// preview_rows, run_sql, describe_workspace, get_activity_log) and 12
// `registerStagedTool` (add/remove/clear filter, add/remove derived column,
// rename_column, redact_column, add_chart, flag_rows, join_datasets,
// export_view, write_report).
const READ_TOOLS = 8;
const STAGED_ACTIONS = 12;

const MODE_LABEL: Record<AgentMode, string> = {
  local: "Local",
  cloud: "Cloud",
  "byo-endpoint": "Bring your own",
};

/**
 * The status pill: which "brain" is driving the agent, what that plainly means
 * for where data goes, and the read-vs-staged tool split (unchanged by mode).
 * All the "what happens to my data" wording comes from `describeMode()` in
 * `agent/agentMode.ts` so this and `SealStatus` can never say two different
 * things about the same state.
 */
export function WebMCPStatus() {
  const mode = useAgentMode();
  const [open, setOpen] = useState(false);
  const [byoUrl, setByoUrl] = useState(mode.byo?.url ?? "");
  const [byoKey, setByoKey] = useState("");
  const [egress, setEgress] = useState<EgressState>(getEgress);

  useEffect(() => subscribeEgress(() => setEgress(getEgress())), []);
  // Re-render when tools are called so the badge can flip from "no calls yet"
  // to the connected-host copy on the first call.
  useActivity();
  const hasCalls = activityLog.list().length > 0;

  // The store's initial snapshot is built before `main.tsx`'s bootstrap sets
  // `window.__airlockWebMCP` / attaches the polyfill (module evaluation runs
  // ahead of that async sequence). Re-detect once mounted, and again on any
  // host/tool-list change the polyfill or a native host fires.
  useEffect(() => {
    agentModeStore.refreshDetection();
    const onChange = () => agentModeStore.refreshDetection();
    document.addEventListener("modelcontexttoolschange", onChange);
    document.addEventListener("toolchange", onChange);
    return () => {
      document.removeEventListener("modelcontexttoolschange", onChange);
      document.removeEventListener("toolchange", onChange);
    };
  }, []);

  const badge = describeMode(mode, { hasCalls });
  const tone = toneFor(mode);
  const localAvail = agentModeStore.availability("local");

  // "0 bytes out" is a *measured* claim — `measuredHeadline` only emits it when
  // the egress monitor actually reads zero (COLLAB rule 5). Otherwise it falls
  // back to `describeMode` and the Seal shows any breach in red.
  const egressClear = egress.externalRequests === 0 && egress.bytesSent === 0;
  const headline = measuredHeadline(mode, egressClear, { hasCalls });

  const commitByo = () => {
    agentModeStore.setByoConfig(
      byoUrl ? { url: byoUrl, hasKey: byoKey.length > 0 } : null
    );
  };

  const openLedger = () => {
    if (!uiStore.getState().activityOpen) uiStore.toggleActivity();
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${tone.border}`}
        title={badge.detail}
      >
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        <span className={tone.text}>{headline}</span>
      </button>

      {open && (
        <div className="card absolute left-0 top-9 z-30 w-96 animate-slide-in p-4 text-xs shadow-2xl">
          <p className="mb-1 font-semibold text-white">Agent mode</p>
          <p className="mb-3 leading-relaxed text-slate-400">{badge.detail}</p>

          <div role="radiogroup" aria-label="Agent mode" className="flex gap-1.5">
            {(Object.keys(MODE_LABEL) as AgentMode[]).map((m) => {
              const avail = agentModeStore.availability(m);
              // A native host is effectively "Cloud" no matter what mode is
              // stored (see describeMode) — reflect that in the radio.
              const active =
                mode.host.kind === "native" ? m === "cloud" : mode.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!avail.available}
                  title={avail.reason}
                  onClick={() => agentModeStore.setMode(m)}
                  className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "border-airlock-500/60 bg-airlock-700/20 text-airlock-300"
                      : "border-ink-700 text-slate-400 hover:bg-ink-800 hover:text-white"
                  }`}
                >
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>

          {!localAvail.available && (
            <p className="mt-2 leading-relaxed text-pending">
              Local unavailable — {localAvail.reason}
            </p>
          )}

          {mode.host.kind === "native" && (
            <button
              onClick={openLedger}
              className="mt-3 block text-airlock-400 hover:underline"
            >
              View the activity ledger — what this host has seen →
            </button>
          )}

          {mode.mode === "byo-endpoint" && mode.host.kind !== "native" && (
            <div className="mt-3 space-y-1.5 border-t border-ink-800 pt-3">
              <label className="block text-slate-500">
                Endpoint URL
                <input
                  value={byoUrl}
                  onChange={(e) => setByoUrl(e.target.value)}
                  onBlur={commitByo}
                  placeholder="https://your-endpoint.example/v1"
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-slate-200"
                />
              </label>
              <label className="block text-slate-500">
                API key
                <input
                  type="password"
                  value={byoKey}
                  onChange={(e) => setByoKey(e.target.value)}
                  onBlur={commitByo}
                  placeholder="sk-..."
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-slate-200"
                />
              </label>
              <p className="text-[10px] leading-relaxed text-slate-600">
                Preview control only — this connection is not wired up in this
                build (Tier 2). Nothing is sent here yet.
              </p>
            </div>
          )}

          <dl className="mt-3 space-y-1 border-t border-ink-800 pt-3 font-mono text-[11px] text-slate-500">
            <div className="flex items-center justify-between">
              <dt>Live surface</dt>
              <dd className="text-slate-400">{surfaceLabel(mode)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt>Tool surface</dt>
              <dd>
                {READ_TOOLS} read · {STAGED_ACTIONS} staged
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

/** Which mechanism is actually able to call Airlock's tools right now. */
function surfaceLabel(state: AgentModeState): string {
  if (state.host.kind === "native") return "native WebMCP host";
  if (
    state.mode === "local" &&
    (state.localModelStatus === "running" || state.localModelStatus === "ready")
  ) {
    return "in-browser model";
  }
  if (state.host.kind === "polyfill-only") return "local polyfill · Agent console";
  return "none active";
}

interface Tone {
  dot: string;
  text: string;
  border: string;
}

/**
 * Colour is a claim too: the trusted teal is earned only by a genuinely sealed
 * state (local mode, model actually running). A native host takes precedence
 * over whatever mode is selected (see `describeMode`) and always gets the
 * attention amber — never the reassuring teal or the "applied" green. This is
 * external data flow, not a safe default.
 */
function toneFor(state: AgentModeState): Tone {
  if (state.host.kind === "native") {
    return {
      dot: "bg-pending",
      text: "text-pending",
      border: "border-pending/40 bg-pending/10",
    };
  }
  if (
    state.mode === "local" &&
    (state.localModelStatus === "running" || state.localModelStatus === "ready")
  ) {
    return {
      dot: "bg-airlock-400",
      text: "text-airlock-300",
      border: "border-airlock-700/50 bg-airlock-700/10",
    };
  }
  return {
    dot: "bg-ink-500",
    text: "text-slate-400",
    border: "border-ink-700 bg-ink-850",
  };
}
