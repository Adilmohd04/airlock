/**
 * LocalModelPanel — the always-available hub for running the agent on a model
 * that lives on this device: current status at a glance, the hardware check, a
 * live download bar, model choice, and cache management (size + delete).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * T1-a INTEGRATED (2026-09-02, T1-b stream). The in-memory stub this panel was
 * written against is gone; it now binds to the real `LocalModelStore`
 * (`agent/localModel/store.ts`) and catalog (`agent/localModel/models.ts`).
 * The contract types and catalog helpers are re-exported from those modules so
 * `ModelDownloadDialog` / `WebMCPStatus` keep importing them from here. The
 * real `LocalModelState` is a structural superset (it adds `generating`), which
 * is assignable everywhere the panel's narrower shape was expected.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from "react";
import { uiStore, useUI } from "../engine/uiStore";
import {
  localModelStore,
  toAgentModeStatus,
  type LocalModelState,
  type LocalHardwareReport,
  type LocalModelProgress,
} from "../agent/localModel/store";
import {
  DEFAULT_MODEL_ID,
  formatModelSize,
  getModel,
  LOCAL_MODELS,
  type LocalModelId,
  type LocalModelInfo,
} from "../agent/localModel/models";
import { agentModeStore } from "../agent/agentMode";

// ── Re-exports so ModelDownloadDialog / WebMCPStatus import from one place ────
export {
  localModelStore,
  type LocalModelState,
  type LocalHardwareReport,
  type LocalModelProgress,
};
export {
  DEFAULT_MODEL_ID,
  formatModelSize,
  getModel,
  LOCAL_MODELS,
  type LocalModelId,
  type LocalModelInfo,
};

/** React binding for the real store — the hook the stub used to provide. */
export function useLocalModelStore(): LocalModelState {
  return React.useSyncExternalStore(
    localModelStore.subscribe,
    localModelStore.getState,
    localModelStore.getState
  );
}

/**
 * Keep the mode indicator (`agent/agentMode.ts`) in sync with the real store:
 * it consumes only `status` (mapped 7→5 by the store's own `toAgentModeStatus`)
 * and the active model id. Subscribed once, at module load.
 */
let modeSyncInstalled = false;
function installModeSync(): void {
  if (modeSyncInstalled) return;
  modeSyncInstalled = true;
  const push = () => {
    const s = localModelStore.getState();
    agentModeStore.setLocalModelStatus(
      toAgentModeStatus(s.status),
      s.activeModelId
    );
  };
  localModelStore.subscribe(push);
  push();
}

installModeSync();

// ── Presentational helpers (shared with ModelDownloadDialog) ─────────────────

export function speedWord(speed: LocalHardwareReport["speed"]): string {
  return speed;
}

export function speedBlurb(speed: LocalHardwareReport["speed"]): string {
  switch (speed) {
    case "fast":
      return "Runs a 3B model comfortably; the approval gate will be the slow part, not the model.";
    case "usable":
      return "Works — expect a short wait between the agent's steps.";
    case "slow":
      return "The 1B model is the realistic choice here, and replies will still be slow.";
    default:
      return "Your browser withheld the GPU details needed to estimate.";
  }
}

export function downloadEta(elapsedMs: number, fraction: number): string {
  if (!Number.isFinite(elapsedMs) || fraction <= 0.03 || fraction >= 0.995)
    return "";
  const remainMs = (elapsedMs / fraction) * (1 - fraction);
  const s = Math.round(remainMs / 1000);
  if (s < 60) return `about ${Math.max(1, s)}s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min left`;
  const h = Math.floor(m / 60);
  return `about ${h}h ${m % 60}m left`;
}

function pillMeta(s: LocalModelState): { dot: string; word: string } {
  switch (s.status) {
    case "running":
      return { dot: "bg-airlock-400", word: "on" };
    case "ready":
      return { dot: "bg-airlock-400", word: "ready" };
    case "downloading":
      return {
        dot: "bg-pending animate-pending-pulse",
        word: `${Math.round((s.progress?.fraction ?? 0) * 100)}%`,
      };
    case "paused":
      return { dot: "bg-pending", word: "paused" };
    case "error":
      return { dot: "bg-danger", word: "error" };
    case "unavailable":
      return { dot: "bg-ink-500", word: "n/a" };
    default:
      return { dot: "bg-ink-500", word: "set up" };
  }
}

// ── Shared UI pieces ────────────────────────────────────────────────────────

export function ModelProgressBar({
  progress,
  compact,
}: {
  progress: LocalModelProgress;
  compact?: boolean;
}) {
  const pct = Math.round(progress.fraction * 100);
  const indeterminate = !progress.fetching;
  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-ink-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : pct}
        aria-label="Model download progress"
        aria-valuetext={
          indeterminate
            ? progress.label
            : `${pct}% — ${formatModelSize(progress.loadedBytes)} of ${formatModelSize(
                progress.totalBytes
              )}`
        }
      >
        {indeterminate ? (
          <div className="refresh-bar h-full w-full" />
        ) : (
          <div
            className="h-full rounded-full bg-pending transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-slate-400">
        {progress.fetching ? (
          <>
            <span className="text-slate-200">{pct}%</span>
            <span>
              {formatModelSize(progress.loadedBytes)} / {formatModelSize(progress.totalBytes)}
            </span>
            {downloadEta(progress.elapsedMs, progress.fraction) && (
              <span className="text-slate-600">
                · {downloadEta(progress.elapsedMs, progress.fraction)}
              </span>
            )}
          </>
        ) : (
          <span>{progress.label}</span>
        )}
      </p>
    </div>
  );
}

export function HardwareLine({ hardware }: { hardware: LocalHardwareReport | null }) {
  if (hardware == null) {
    return <p className="text-[11px] text-slate-500">Checking your GPU…</p>;
  }
  if (hardware.available) {
    return (
      <div className="space-y-0.5">
        <p className="text-slate-400">
          Your GPU:{" "}
          <span className="font-mono text-slate-200">{hardware.adapter}</span>
        </p>
        <p className="text-slate-400">
          Estimated speed:{" "}
          <span
            className={
              hardware.speed === "slow" ? "text-pending" : "text-airlock-300"
            }
          >
            {speedWord(hardware.speed)}
          </span>
          <span className="text-slate-500"> — {speedBlurb(hardware.speed)}</span>
        </p>
        <p className="text-[10px] text-slate-600">
          A rough estimate from your GPU's reported limits, not a benchmark.
        </p>
      </div>
    );
  }
  return <p className="leading-relaxed text-slate-400">{hardware.reason}</p>;
}

/**
 * The cloud-agent note shown wherever Local is unavailable. Deliberately does
 * not claim parity: the point of Local mode is that this sentence is not true
 * of it.
 */
export function CloudFallbackNote() {
  return (
    <p className="leading-relaxed text-slate-500">
      You can still use Airlock with a cloud agent (ChatGPT over WebMCP). That
      works, but it is not the same guarantee — the slices of data the agent
      queries are sent to the model provider, and the activity ledger records
      exactly what. Local mode is the only mode where nothing the agent reads
      leaves this tab.
    </p>
  );
}

export function ModelChooser({
  state,
  onSelect,
}: {
  state: LocalModelState;
  onSelect: (id: LocalModelId) => void;
}) {
  const locked = state.status === "downloading" || state.status === "running";
  return (
    <fieldset disabled={locked} className="space-y-1">
      <legend className="sr-only">Choose a local model</legend>
      {LOCAL_MODELS.map((m) => {
        const isCached = state.cache.cachedModelIds.includes(m.id);
        const checked = state.selectedModelId === m.id;
        return (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 ${
              checked
                ? "border-airlock-700/60 bg-airlock-700/10"
                : "border-ink-800 hover:bg-ink-850"
            } ${locked ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="local-model"
              className="mt-0.5 accent-airlock-500"
              checked={checked}
              onChange={() => onSelect(m.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium text-slate-200">{m.label}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {formatModelSize(m.downloadBytes)} · ~
                  {(m.vramRequiredMB / 1024).toFixed(1)} GB VRAM
                </span>
                {m.tier === "default" && (
                  <span className="text-[10px] text-slate-500">recommended</span>
                )}
                {isCached && (
                  <span className="text-[10px] text-airlock-300">cached</span>
                )}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                {m.blurb}
              </span>
            </span>
          </label>
        );
      })}
      {locked && (
        <p className="text-[10px] text-slate-600">
          Cancel the download or unload the running model to switch.
        </p>
      )}
    </fieldset>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

/**
 * Bring-your-own-model: any MLC-converted instruct model over https. Unlike
 * the catalog, the one-time download is external by definition — the consent
 * checkbox names that before anything is fetched, the egress monitor counts
 * it so the Seal shows it, and after that the weights live in the same Cache
 * API buckets and run fully on-device.
 */
export function CustomModelSection({ state }: { state: LocalModelState }) {
  const [label, setLabel] = useState("");
  const [modelUrl, setModelUrl] = useState("");
  const [libUrl, setLibUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const locked = state.status === "downloading" || state.status === "running";

  const add = () => {
    setFormError(null);
    try {
      localModelStore.addCustomModel({ label, modelUrl, libUrl });
      setLabel("");
      setModelUrl("");
      setLibUrl("");
      setConsent(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (l: string) => {
    setBusyLabel(l);
    try {
      await localModelStore.downloadCustom(l);
    } finally {
      setBusyLabel(null);
    }
  };

  return (
    <div>
      <p className="panel-title mb-1">Your own model</p>
      {state.customModels.length > 0 && (
        <ul className="mb-2 space-y-1">
          {state.customModels.map((m) => {
            const active = state.customActiveLabel === m.label;
            return (
              <li
                key={m.label}
                className="flex items-center justify-between gap-2 rounded-md bg-ink-850 px-2 py-1.5"
              >
                <span className="min-w-0 truncate font-mono text-[11px] text-slate-300">
                  {m.label}
                  {active && (
                    <span className="ml-1.5 text-airlock-300">on GPU</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {!active && (
                    <button
                      type="button"
                      className="text-[11px] text-airlock-300 hover:underline disabled:opacity-40"
                      disabled={locked || busyLabel !== null}
                      onClick={() => void run(m.label)}
                    >
                      {busyLabel === m.label ? "loading…" : "load"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-slate-500 hover:text-danger disabled:opacity-40"
                    disabled={locked}
                    onClick={() => void localModelStore.removeCustomModel(m.label)}
                  >
                    delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-1.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name — e.g. My Qwen 7B"
          aria-label="Custom model name"
          className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-[11px] text-slate-200"
        />
        <input
          value={modelUrl}
          onChange={(e) => setModelUrl(e.target.value)}
          placeholder="https://huggingface.co/…/resolve/main/"
          aria-label="Custom model weights URL"
          inputMode="url"
          className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-[11px] text-slate-200"
        />
        <input
          value={libUrl}
          onChange={(e) => setLibUrl(e.target.value)}
          placeholder="https://…/model-webgpu.wasm"
          aria-label="Custom model library URL"
          inputMode="url"
          className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-[11px] text-slate-200"
        />
        <label className="flex cursor-pointer items-start gap-1.5 text-[11px] leading-snug text-slate-500">
          <input
            type="checkbox"
            className="mt-0.5 accent-airlock-500"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            I understand the weights download once from that external URL —
            the Seal will count it — and only MLC-converted models
            (mlc-chat-config.json + shards) can run.
          </span>
        </label>
        {formError && <p className="text-[11px] text-danger">{formError}</p>}
        <button
          type="button"
          className="btn btn-ghost text-[11px]"
          disabled={
            locked ||
            !consent ||
            !label.trim() ||
            !modelUrl.trim() ||
            !libUrl.trim()
          }
          onClick={add}
        >
          Add custom model
        </button>
      </div>
    </div>
  );
}

export function LocalModelPanel() {
  const s = useLocalModelStore();
  const ui = useUI();
  const open = ui.localModel.panelOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const [freed, setFreed] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<LocalModelId | null>(null);
  const [showModels, setShowModels] = useState(false);

  // One hardware probe the first time either surface opens; cheap to repeat.
  useEffect(() => {
    if (open || ui.localModel.dialogOpen) void localModelStore.refresh();
  }, [open, ui.localModel.dialogOpen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node))
        uiStore.setLocalModelPanel(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") uiStore.setLocalModelPanel(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Clear the "freed X" note when the panel closes so it doesn't reappear stale.
  useEffect(() => {
    if (!open) setFreed(null);
  }, [open]);

  const pill = pillMeta(s);
  const model = getModel(s.selectedModelId);

  const onPillClick = () => {
    const st = localModelStore.getState().status;
    if (st === "not-downloaded" || st === "unavailable" || st === "error") {
      uiStore.openLocalModelDialog();
    } else {
      uiStore.toggleLocalModelPanel();
    }
  };

  const doDelete = async (id: LocalModelId) => {
    const reclaimed = await localModelStore.deleteWeights(id);
    setConfirmId(null);
    setFreed(reclaimed);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onPillClick}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Run the agent on a model on your device"
        className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs hover:bg-ink-800"
      >
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${pill.dot}`}
        />
        <span className="font-medium text-slate-300">Local model</span>
        <span className="text-slate-600">·</span>
        <span className="font-mono text-slate-500">{pill.word}</span>
      </button>

      {open && (
        <div
          aria-label="Local model settings"
          className="absolute left-0 top-9 z-30 w-[25rem] animate-slide-in rounded-lg border border-ink-700 bg-ink-900 p-4 text-xs shadow-2xl"
        >
          <p className="panel-title">Local model</p>

          {/* ── status headline + primary action ── */}
          <div className="mt-2">
            {s.status === "unavailable" && (
              <div className="space-y-2">
                <p className="font-medium text-slate-200">
                  Can't run a model on this browser
                </p>
                <p className="leading-relaxed text-slate-400">
                  {s.unavailableReason}
                </p>
                <CloudFallbackNote />
              </div>
            )}

            {s.status === "not-downloaded" && (
              <div className="space-y-2">
                <p className="font-medium text-slate-200">Not set up yet</p>
                <p className="leading-relaxed text-slate-400">
                  Download {model.label} once ({formatModelSize(model.downloadBytes)}).
                  Then, in Local mode, the agent runs on it right here — offline,
                  with nothing it reads leaving the tab.
                </p>
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  onClick={() => uiStore.openLocalModelDialog()}
                >
                  Set up local model
                </button>
              </div>
            )}

            {s.status === "downloading" && s.progress && (
              <div className="space-y-2">
                <p className="font-medium text-slate-200">
                  Downloading {model.label}…
                </p>
                <ModelProgressBar progress={s.progress} compact />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    onClick={() => localModelStore.cancelDownload()}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    onClick={() => uiStore.openLocalModelDialog()}
                  >
                    Details
                  </button>
                </div>
              </div>
            )}

            {s.status === "paused" && (
              <div className="space-y-2">
                <p className="font-medium text-slate-200">Download paused</p>
                <p className="leading-relaxed text-slate-400">
                  {formatModelSize(s.partialBytes)} of{" "}
                  {formatModelSize(model.downloadBytes)} is kept in this browser's
                  cache. Resuming continues from there — nothing already fetched
                  is fetched again.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-primary text-xs"
                    onClick={() => void localModelStore.download()}
                  >
                    Resume download
                  </button>
                  <button
                    type="button"
                    className="btn btn-reject text-xs"
                    onClick={() => void doDelete(s.selectedModelId)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {s.status === "ready" && (
              <div className="space-y-2">
                <p className="font-medium text-airlock-300">Local model ready</p>
                <p className="leading-relaxed text-slate-400">
                  {model.label} is cached in this browser. It loads with no
                  download from now on, including with the network off.
                </p>
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  onClick={() => void localModelStore.load()}
                >
                  Load model
                </button>
              </div>
            )}

            {s.status === "running" && (
              <div className="space-y-2">
                <p className="font-medium text-airlock-300">
                  Loaded on your device
                </p>
                <p className="leading-relaxed text-slate-400">
                  {getModel(s.activeModelId ?? s.selectedModelId).label} is
                  resident on your GPU. In Local mode the agent runs on it here,
                  and everything it reads stays on this device.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost text-xs"
                  onClick={() => void localModelStore.unload()}
                >
                  Unload (frees the GPU, keeps the weights)
                </button>
              </div>
            )}

            {s.status === "error" && (
              <div className="space-y-2">
                <p className="font-medium text-danger">Something went wrong</p>
                <p className="leading-relaxed text-slate-400">{s.error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-primary text-xs"
                    onClick={() => {
                      localModelStore.clearError();
                      void localModelStore.download();
                    }}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs"
                    onClick={() => localModelStore.clearError()}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── hardware ── */}
          <div className="mt-3 border-t border-ink-800 pt-3">
            <p className="panel-title mb-1">Hardware</p>
            <HardwareLine hardware={s.hardware} />
          </div>

          {/* ── model choice ── */}
          {s.blocker !== "no-webgpu" && (
            <div className="mt-3 border-t border-ink-800 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between panel-title"
                aria-expanded={showModels}
                onClick={() => setShowModels((v) => !v)}
              >
                <span>Model · {model.label}</span>
                <span className="text-slate-600">{showModels ? "▴" : "▾"}</span>
              </button>
              {showModels && (
                <div className="mt-2">
                  <ModelChooser
                    state={s}
                    onSelect={(id) => localModelStore.selectModel(id)}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── your own model ── */}
          {s.blocker !== "no-webgpu" && (
            <div className="mt-3 border-t border-ink-800 pt-3">
              <CustomModelSection state={s} />
            </div>
          )}

          {/* ── storage ── */}
          <div className="mt-3 border-t border-ink-800 pt-3">
            <p className="panel-title mb-1">Storage</p>
            <p className="font-mono text-slate-400">
              Cached on this device:{" "}
              <span className="text-slate-200">
                {s.cache.bytesOnDisk == null
                  ? "size unavailable"
                  : s.cache.bytesOnDisk === 0
                    ? "nothing cached"
                    : formatModelSize(s.cache.bytesOnDisk)}
              </span>
            </p>

            {s.cache.cachedModelIds.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {s.cache.cachedModelIds.map((id) => {
                  const m = getModel(id);
                  return (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 rounded-md bg-ink-850 px-2 py-1.5"
                    >
                      <span className="min-w-0 truncate font-mono text-[11px] text-slate-300">
                        {m.label}
                        <span className="ml-1.5 text-slate-600">
                          {formatModelSize(m.downloadBytes)}
                        </span>
                      </span>
                      {confirmId === id ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            className="text-[11px] text-danger hover:underline"
                            onClick={() => void doDelete(id)}
                          >
                            delete weights
                          </button>
                          <button
                            type="button"
                            className="text-[11px] text-slate-500 hover:text-slate-300"
                            onClick={() => setConfirmId(null)}
                          >
                            keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="shrink-0 text-[11px] text-slate-500 hover:text-danger"
                          onClick={() => setConfirmId(id)}
                        >
                          delete
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {freed != null && (
              <p className="mt-1.5 text-[11px] text-commit">
                Freed {formatModelSize(freed)} of disk space.
              </p>
            )}
          </div>

          <p className="mt-3 border-t border-ink-800 pt-2 text-[10px] leading-relaxed text-slate-600">
            Catalog models download once, from this site — the same origin as
            the app itself, counted as an asset load, not external traffic.
            Your own models download once from the URL you gave (external, and
            counted). After that every model lives in this browser and runs on
            your GPU.
          </p>
        </div>
      )}
    </div>
  );
}
