/**
 * ModelCenter — the AI experience as one first-class place, replacing the old
 * split between the WebMCPStatus popover (which "brain" — local/cloud/BYO)
 * and the LocalModelPanel popover (which on-device model, download/storage).
 * One question — "what is analyzing my data, and where does it run" — one
 * surface to answer it.
 *
 * All state and actions are the real stores, unchanged:
 *  - `localModelStore` (T1-a) — the on-device model's 7-state machine.
 *  - `agentModeStore` (T1-d) — which runtime is selected + honest status copy.
 *  - `agent/byo/client` — the user's own OpenAI-compatible endpoint.
 * This file only recomposes their presentation. The download flow itself
 * (consent → progress → ready) is still `ModelDownloadDialog` — a model
 * "Download" button here opens that, it doesn't reimplement it.
 */

import { useEffect, useRef, useState } from "react";
import { uiStore, useUI } from "../engine/uiStore";
import { classifyHost, recheckHostAttach } from "../agent/hostAttach";
import { activityLog } from "../agent/activity";
import { useActivity } from "../agent/hooks";
import {
  agentModeStore,
  describeMode,
  useAgentMode,
  type AgentMode,
} from "../agent/agentMode";
import {
  clearEndpoint,
  configureEndpoint,
  endpointHost,
  isEndpointConfigured,
} from "../agent/byo/client";
import {
  CloudFallbackNote,
  CustomModelSection,
  HardwareLine,
  formatModelSize,
  getModel,
  localModelStore,
  useLocalModelStore,
  LOCAL_MODELS,
  type LocalModelId,
} from "./LocalModelPanel";

const READ_TOOLS = 8;
const STAGED_ACTIONS = 12;

const RUNTIME_TAB: { id: AgentMode; label: string; hint: string }[] = [
  { id: "local", label: "Local", hint: "Runs on your device" },
  { id: "cloud", label: "Cloud", hint: "Powered by a connected AI host" },
  { id: "byo-endpoint", label: "Bring your own", hint: "Your own AI endpoint" },
];

export function ModelCenter() {
  const ui = useUI();
  const open = ui.localModel.panelOpen;
  const mode = useAgentMode();
  const s = useLocalModelStore();
  const panelRef = useRef<HTMLDivElement>(null);
  useActivity(); // re-render the moment a call lands, while the panel is open

  // A native host overrides whatever runtime tab is stored (same rule as the
  // old WebMCPStatus) — reflect that instead of showing a stale selection.
  const [tab, setTab] = useState<AgentMode>(
    mode.host.kind === "native" ? "cloud" : mode.mode
  );
  useEffect(() => {
    if (open) setTab(mode.host.kind === "native" ? "cloud" : mode.mode);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => uiStore.setLocalModelPanel(false);

  useEffect(() => {
    if (open) void localModelStore.refresh();
    // Opening this panel is an explicit "is a host here now?" moment — catch
    // a host that attached after page load (pill + tools follow via App).
    if (open) recheckHostAttach();
  }, [open]);

  // Focus trap + Escape, same contract as ModelDownloadDialog.
  useEffect(() => {
    if (!open) return;
    const card = panelRef.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        card?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  // API presence is not activity: with the testing flag / origin-trial token on
  // and nothing attached, `mode.host.kind` reads "native" with zero calls made.
  // The banner below must not claim a host "is driving Airlock" until the
  // ledger shows it actually has.
  const hasCalls = activityLog.list().length > 0;
  const badge = describeMode(mode, { hasCalls });
  const activeModel = getModel(s.activeModelId ?? s.selectedModelId);
  const nativeHost = mode.host.kind === "native";

  return (
    <div
      className="modal-overlay p-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-center-title"
        className="modal-panel flex max-h-[80vh] w-full max-w-2xl animate-scale-in flex-col"
      >
        {/* header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-800 px-5 py-4">
          <div>
            <h2 id="model-center-title" className="text-base font-semibold text-white">
              AI
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              {nativeHost
                ? `${mode.host.name || "A connected AI host"} is calling Airlock's tools directly.`
                : "Choose what analyzes your data, and where it runs."}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-mr-1 -mt-0.5 shrink-0 rounded p-1.5 text-slate-500 hover:bg-ink-800 hover:text-slate-200"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
              <path d="M4.3 3.3 8 7l3.7-3.7 1 1L10 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L6 8 2.3 4.3l1-1Z" />
            </svg>
          </button>
        </div>

        {/* runtime tabs */}
        <div className="flex shrink-0 gap-1.5 border-b border-ink-800 px-5 py-3">
          {RUNTIME_TAB.map((t) => {
            const avail = agentModeStore.availability(t.id);
            const active = nativeHost ? t.id === "cloud" : tab === t.id;
            // A blocked runtime is still viewable — clicking it always shows
            // *why* (LocalRuntimeBody surfaces the specific reason below).
            // Only the actual mode-select side effect is gated. A disabled
            // <button> can't be reached by click or keyboard, which is what
            // hid this diagnosis from view in the first place.
            return (
              <button
                key={t.id}
                type="button"
                title={avail.available ? undefined : avail.reason}
                onClick={() => {
                  setTab(t.id);
                  if (!nativeHost && avail.available) agentModeStore.setMode(t.id);
                }}
                className={`flex-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                  active
                    ? "border-airlock-500/60 bg-airlock-700/15 text-airlock-200"
                    : avail.available
                      ? "border-ink-700 text-slate-400 hover:bg-ink-850 hover:text-white"
                      : "border-ink-800 text-slate-600 hover:bg-ink-850"
                }`}
              >
                <span className="block font-medium">{t.label}</span>
                <span className="mt-0.5 block text-[10.5px] text-slate-500">
                  {avail.available ? t.hint : "Unavailable — click to see why"}
                </span>
              </button>
            );
          })}
        </div>

        {nativeHost && (
          <div className="mx-5 mt-3 rounded-lg border border-pending/40 bg-pending/5 px-3 py-2 text-[11px] leading-relaxed text-pending">
            {badge.detail}
          </div>
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === "local" && <LocalRuntimeBody s={s} activeLabel={activeModel.label} />}
          {tab === "cloud" && <CloudRuntimeBody nativeHost={nativeHost} />}
          {tab === "byo-endpoint" && <ByoRuntimeBody />}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-ink-800 px-5 py-2.5 font-mono text-[10.5px] text-slate-500">
          <span>
            {READ_TOOLS} read tools · {STAGED_ACTIONS} staged actions
          </span>
          <button
            className="text-airlock-400 hover:underline"
            onClick={() => {
              if (!uiStore.getState().activityOpen) uiStore.toggleActivity();
              close();
            }}
          >
            Activity ledger →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Local runtime ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { cls: string; word: string }> = {
    running: { cls: "badge-teal", word: "● Running locally" },
    ready: { cls: "badge-teal", word: "● Ready" },
    downloading: { cls: "badge-amber", word: "Downloading…" },
    paused: { cls: "badge-amber", word: "Paused" },
    error: { cls: "badge-red", word: "Error" },
    unavailable: { cls: "badge-neutral", word: "Unavailable" },
    "not-downloaded": { cls: "badge-neutral", word: "Not installed" },
  };
  const m = meta[status] ?? meta["not-downloaded"];
  return <span className={`badge ${m.cls}`}>{m.word}</span>;
}

function LocalRuntimeBody({
  s,
  activeLabel,
}: {
  s: ReturnType<typeof useLocalModelStore>;
  activeLabel: string;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [confirmId, setConfirmId] = useState<LocalModelId | null>(null);

  if (s.status === "unavailable") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-200">Can&apos;t run a model on this browser</p>
        <p className="text-xs leading-relaxed text-slate-400">{s.unavailableReason}</p>
        <CloudFallbackNote />
      </div>
    );
  }

  const installed = LOCAL_MODELS.filter((m) => s.cache.cachedModelIds.includes(m.id));
  const available = LOCAL_MODELS.filter((m) => !s.cache.cachedModelIds.includes(m.id));

  return (
    <div className="space-y-5">
      {/* current model */}
      <div className="rounded-xl border border-airlock-700/40 bg-airlock-700/[0.06] p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-white">
            <span className="text-airlock-400">✦</span> {activeLabel}
          </p>
          <StatusBadge status={s.status} />
        </div>
        {s.status === "downloading" && s.progress && (
          <div className="mt-3">
            <DownloadProgress fraction={s.progress.fraction} loaded={s.progress.loadedBytes} total={s.progress.totalBytes} label={s.progress.label} fetching={s.progress.fetching} />
            <div className="mt-2 flex gap-2">
              <button className="btn btn-ghost !py-1 text-xs" onClick={() => localModelStore.cancelDownload()}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {(s.status === "ready" || s.status === "running") && (
          <div className="mt-2 flex justify-end">
            {s.status === "running" ? (
              <button className="btn btn-ghost !py-1 text-xs" onClick={() => void localModelStore.unload()}>
                Unload (frees GPU)
              </button>
            ) : (
              <button className="btn btn-primary !py-1 text-xs" onClick={() => void localModelStore.load()}>
                Load model
              </button>
            )}
          </div>
        )}
        {s.status === "not-downloaded" && (
          <div className="mt-2 space-y-2 text-xs text-slate-400">
            <p>Download once ({formatModelSize(getModel(s.selectedModelId).downloadBytes)}), then the agent runs on it here — offline, nothing it reads leaves the tab.</p>
            <button className="btn btn-primary !py-1 text-xs" onClick={() => uiStore.openLocalModelDialog()}>
              Set up local model
            </button>
          </div>
        )}
        {s.status === "error" && (
          <p className="mt-2 text-xs leading-relaxed text-danger">{s.error}</p>
        )}
      </div>

      {/* Always visible — not gated on status. The GPU check runs
          independently of whether a model is installed yet, and "is my
          hardware even capable" is the first thing a first-time visitor
          wants answered, not something buried behind a download. */}
      <div>
        <p className="section-label mb-1.5">Hardware</p>
        <div className="rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2.5 text-xs">
          <HardwareLine hardware={s.hardware} />
        </div>
      </div>

      {installed.length > 0 && (
        <ModelSection title="Installed">
          {installed.map((m) => {
            const active = (s.activeModelId ?? s.selectedModelId) === m.id && s.status === "running";
            return (
              <ModelRow key={m.id} label={m.label} meta={`${formatModelSize(m.downloadBytes)} · ~${(m.vramRequiredMB / 1024).toFixed(1)} GB VRAM`}>
                {active ? (
                  <span className="badge badge-teal">Active</span>
                ) : confirmId === m.id ? (
                  <span className="flex items-center gap-2 text-[11px]">
                    <button className="text-danger hover:underline" onClick={() => void localModelStore.deleteWeights(m.id).then(() => setConfirmId(null))}>
                      delete
                    </button>
                    <button className="text-slate-500 hover:text-slate-300" onClick={() => setConfirmId(null)}>
                      keep
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-3 text-[11px]">
                    <button
                      className="text-airlock-300 hover:underline"
                      onClick={() => {
                        localModelStore.selectModel(m.id);
                        void localModelStore.load();
                      }}
                    >
                      switch
                    </button>
                    <button className="text-slate-500 hover:text-danger" onClick={() => setConfirmId(m.id)}>
                      delete
                    </button>
                  </span>
                )}
              </ModelRow>
            );
          })}
        </ModelSection>
      )}

      {available.length > 0 && (
        <ModelSection title="Available">
          {available.map((m) => (
            <ModelRow
              key={m.id}
              label={m.label}
              meta={`${formatModelSize(m.downloadBytes)} · ~${(m.vramRequiredMB / 1024).toFixed(1)} GB VRAM${m.tier === "default" ? " · recommended" : ""}`}
              sub={m.blurb}
            >
              <button
                className="btn btn-secondary !py-1 text-[11px]"
                onClick={() => {
                  localModelStore.selectModel(m.id);
                  uiStore.openLocalModelDialog();
                }}
              >
                Download
              </button>
            </ModelRow>
          ))}
        </ModelSection>
      )}

      <div>
        <button
          type="button"
          className="section-label flex w-full items-center justify-between"
          aria-expanded={showCustom}
          onClick={() => setShowCustom((v) => !v)}
        >
          <span>Your own model</span>
          <span>{showCustom ? "▴" : "▾"}</span>
        </button>
        {showCustom && (
          <div className="mt-2">
            <CustomModelSection state={s} />
          </div>
        )}
      </div>

      <div className="border-t border-ink-800 pt-3 text-[11px] text-slate-500">
        Cached on this device:{" "}
        <span className="stat-num">
          {s.cache.bytesOnDisk == null
            ? "size unavailable"
            : s.cache.bytesOnDisk === 0
              ? "nothing cached"
              : formatModelSize(s.cache.bytesOnDisk)}
        </span>
      </div>
    </div>
  );
}

function DownloadProgress({
  fraction,
  loaded,
  total,
  label,
  fetching,
}: {
  fraction: number;
  loaded: number;
  total: number;
  label: string;
  fetching: boolean;
}) {
  const pct = Math.round(fraction * 100);
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
        {fetching ? (
          <div className="h-full rounded-full bg-pending transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
        ) : (
          <div className="refresh-bar h-full w-full" />
        )}
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-slate-400">
        {fetching ? (
          <>
            <span className="text-slate-200">{pct}%</span>
            <span>
              {formatModelSize(loaded)} / {formatModelSize(total)}
            </span>
          </>
        ) : (
          <span>{label}</span>
        )}
      </p>
    </div>
  );
}

function ModelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="section-label mb-1.5">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ModelRow({
  label,
  meta,
  sub,
  children,
}: {
  label: string;
  meta: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-slate-200">{label}</p>
        <p className="mt-0.5 font-mono text-[10.5px] text-slate-500">{meta}</p>
        {sub && <p className="mt-1 text-[11px] leading-snug text-slate-500">{sub}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Cloud runtime ────────────────────────────────────────────────────────

function CloudRuntimeBody({ nativeHost }: { nativeHost: boolean }) {
  // What the page itself measured at load (main.tsx bootstrap): whether the
  // browser exposed a real WebMCP API, or only the testing-flag/polyfill
  // surface with no agent driving. This is the honest "why not connected" —
  // everything beyond it (app version, model, workspace) is outside what the
  // page can observe, so that stays a checklist, not a claim.
  //
  // NOTE: classified live on every render — not from the agent-mode store,
  // whose host.kind is frozen at module-load values from BEFORE the polyfill
  // installs. Reading the store here would report "no API" for a tab that
  // actually has the local shim up with nobody attached.
  const live =
    typeof document === "undefined"
      ? ("absent" as const)
      : classifyHost((document as Document).modelContext as unknown);
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-pending/30 bg-pending/5 p-4">
        <p className="flex items-center gap-1.5 text-sm font-medium text-pending">☁ Cloud</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
          {nativeHost
            ? "A connected AI host (e.g. ChatGPT) calls Airlock's tools directly over WebMCP. The slices of data it queries are sent to that host's model provider — every call is logged in the activity ledger below, in plain terms, as it happens."
            : "Connect Airlock to ChatGPT (or another WebMCP host) to drive it from there. The slices of data a cloud model queries leave this tab to that provider — this is the one mode that does not claim zero egress, and the ledger records exactly what left."}
        </p>
      </div>
      {!nativeHost && (
        <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2.5 text-[11px] leading-relaxed">
          <p className="font-medium text-slate-300">Why “not connected” (re-checked every time this panel opens):</p>
          {live === "absent" ? (
            <p className="mt-1 text-slate-400">
              There is <span className="font-mono text-slate-200">no WebMCP API object</span> on
              this page at all — not even Airlock&apos;s built-in local shim. That means the
              page&apos;s WebMCP layer didn&apos;t initialize. Reload the tab; if this message
              persists, the app bundle itself failed to start that layer.
            </p>
          ) : (
            <p className="mt-1 text-slate-400">
              The page exposes its <span className="text-slate-200">local shim only</span> — no
              host is attached to this tab. A host appears here when the testing flag is on{" "}
              <span className="text-slate-200">and</span> the browser was relaunched (Chrome
              build permitting), or when ChatGPT&apos;s browser drives the page. Work through
              the checklist below from the top.
            </p>
          )}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Local mode is the only mode where nothing the agent reads leaves this
        tab. Cloud trades that for a stronger model and no download.
      </p>
      <details className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2">
        <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-300">
          Still shows “not connected” in the top bar?
        </summary>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-slate-500">
          <li>Open this page in the ChatGPT desktop app's built-in browser (latest version), not a regular browser tab.</li>
          <li>Let the agent open the page itself — a tab you navigated to by hand has no agent attached to it.</li>
          <li>Drive it with ChatGPT Work or Codex on Sol or Terra (Luna has site tools disabled).</li>
          <li>Site tools aren't offered in Enterprise or Edu workspaces.</li>
          <li>Load a dataset in this tab first — the tools only exist once a dataset is loaded.</li>
        </ul>
      </details>
    </div>
  );
}

// ── Bring your own ───────────────────────────────────────────────────────

function ByoRuntimeBody() {
  const mode = useAgentMode();
  const [url, setUrl] = useState(mode.byo?.url ?? "");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    setError(null);
    agentModeStore.setByoConfig(url ? { url, hasKey: key.length > 0 } : null);
    try {
      if (url && key) {
        configureEndpoint({ url, apiKey: key, model });
      } else if (!url) {
        clearEndpoint();
        setKey("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-400">
        An OpenAI-compatible endpoint — Azure OpenAI, OpenAI, or a local Ollama
        via <span className="font-mono text-slate-300">http://localhost</span>.
        Drive it from the Agent console&apos;s BYO tab once connected.
      </p>
      <div className="space-y-2">
        <label className="block text-xs text-slate-500">
          Endpoint URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={commit}
            placeholder="https://your-endpoint.example/v1"
            className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 font-mono text-xs text-slate-200"
          />
        </label>
        <label className="block text-xs text-slate-500">
          API key
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onBlur={commit}
            placeholder="sk-... (memory only, never stored)"
            className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 font-mono text-xs text-slate-200"
          />
        </label>
        <label className="block text-xs text-slate-500">
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={commit}
            placeholder="gpt-4o-mini"
            className="mt-1 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 font-mono text-xs text-slate-200"
          />
        </label>
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <p className="text-[10.5px] leading-relaxed text-slate-600">
        {isEndpointConfigured() ? (
          <>Connected to {endpointHost()}. Queries and answers travel there — counted in egress, never zero-claimed.</>
        ) : (
          <>Not connected yet.</>
        )}
      </p>
    </div>
  );
}
