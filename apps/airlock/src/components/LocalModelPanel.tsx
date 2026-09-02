/**
 * LocalModelPanel — the always-available hub for running the agent on a model
 * that lives on this device: current status at a glance, the hardware check, a
 * live download bar, model choice, and cache management (size + delete).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION SEAM. T1-a owns the real `LocalModelStore`
 * (`agent/localModel/store.ts`) and its catalog (`agent/localModel/models.ts`).
 * Neither is importable on this branch yet, so everything between the two
 * `STUB ↓` / `STUB ↑` markers below is a throwaway in-memory implementation of
 * the interface this UI needs, coded against the state machine in the T1-c
 * acceptance criteria and against T1-a's already-landed `runtime.ts`
 * (`GpuReport`, `HostingReport`, `LoadProgress`, same-origin weights).
 *
 * To integrate once T1-a lands:
 *   1. delete the stub block (everything between the markers) and the
 *      `export const localModelStore` / `useLocalModelStore` that follow it;
 *   2. `import { localModelStore, useLocalModelStore } from "../agent/localModel/store"`
 *      — the store must expose `getState()/subscribe()` plus the methods on the
 *      `LocalModelStore` interface below (names chosen to match);
 *   3. `import { LOCAL_MODELS, DEFAULT_MODEL_ID, getModel, formatModelSize,`
 *      `type LocalModelId } from "../agent/localModel/models"` and delete the
 *      local copies. `LocalModelInfo` here is a structural subset of T1-a's, so
 *      the component code below the stub does not change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from "react";
import { uiStore, useUI } from "../engine/uiStore";

// ── Contract this UI binds to ───────────────────────────────────────────────

/** Mirrors `agent/localModel/models.ts#LocalModelId` (4-model curated list). */
export type LocalModelId =
  | "Qwen2.5-3B-Instruct-q4f16_1-MLC"
  | "Llama-3.2-3B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
  | "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/** Structural subset of `agent/localModel/models.ts#LocalModelInfo`. */
export interface LocalModelInfo {
  id: LocalModelId;
  label: string;
  tier: "default" | "alternate" | "small" | "low-end";
  params: string;
  blurb: string;
  /** One-time download total (weights + kernel lib), bytes. */
  downloadBytes: number;
  vramRequiredMB: number;
  license: string;
}

/**
 * The state machine. `paused` and `error` extend BUILD_PROMPT's documented five
 * (`unavailable | not-downloaded | downloading | ready | running`) because the
 * T1-c acceptance criteria call for a real design of the cancelled and failed
 * states. `unavailableReason` + `blocker` sit underneath `"unavailable"` so the
 * UI can tell "no WebGPU in this browser" apart from "this deployment never
 * mirrored the weights" — T1-a's `runtime.ts` treats those as distinct too.
 */
export type LocalModelStatus =
  | "unavailable"
  | "not-downloaded"
  | "downloading"
  | "paused"
  | "ready"
  | "running"
  | "error";

export type LocalModelBlocker = "none" | "no-webgpu" | "no-weights-hosted";

export interface LocalModelProgress {
  /** 0..1. Real fraction from the runtime; bytes below are derived from it. */
  fraction: number;
  loadedBytes: number;
  totalBytes: number;
  /** The runtime's own status line, shown verbatim. */
  label: string;
  /** true = pulling weights over the (same-origin) network; false = warming the GPU. */
  fetching: boolean;
  elapsedMs: number;
}

export interface LocalHardwareReport {
  available: boolean;
  /** e.g. "nvidia - ampere"; "" when unavailable. */
  adapter: string;
  speed: "fast" | "usable" | "slow" | "unknown";
  /** Plain-language; "" when available. */
  reason: string;
}

export interface LocalModelCache {
  /** Bytes held in the browser's model cache, or null when indeterminate. */
  bytesOnDisk: number | null;
  cachedModelIds: LocalModelId[];
}

export interface LocalModelState {
  status: LocalModelStatus;
  selectedModelId: LocalModelId;
  /** The model resident on the GPU (status `running`), else null. */
  activeModelId: LocalModelId | null;
  progress: LocalModelProgress | null;
  /** Bytes kept in cache from a cancelled download (drives "resume"). */
  partialBytes: number;
  /** Sanitized message; set iff status === "error". */
  error: string | null;
  /** Set iff status === "unavailable". */
  unavailableReason: string | null;
  blocker: LocalModelBlocker;
  /** null until the first hardware probe resolves. */
  hardware: LocalHardwareReport | null;
  cache: LocalModelCache;
}

export interface LocalModelStore {
  getState(): LocalModelState;
  subscribe(listener: () => void): () => void;
  /** Probe WebGPU (and, in the real store, the same-origin weight mirror). */
  refresh(): Promise<void>;
  selectModel(id: LocalModelId): void;
  /** Start, or resume after a cancel, the one-time download for the selection. */
  download(): Promise<void>;
  /** Cancel an in-flight download; cached shards survive → `paused`. */
  cancelDownload(): void;
  /** Bring the cached model onto the GPU: `ready` → `running`. */
  load(): Promise<void>;
  /** Free the GPU, keep the weights: `running` → `ready`. */
  unload(): Promise<void>;
  /** Delete a model's cached weights. Resolves with bytes reclaimed. */
  deleteWeights(id: LocalModelId): Promise<number>;
  /** Leave the `error` state without retrying. */
  clearError(): void;
}

// ── Catalog (mirrors agent/localModel/models.ts, numbers measured 2026-09-02) ─

export const LOCAL_MODELS: readonly LocalModelInfo[] = [
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 3B Instruct",
    tier: "default",
    params: "3B",
    blurb:
      "Best tool-calling accuracy of the four. Needs a GPU with about 2.5 GB free.",
    downloadBytes: 1_743_386_559 + 5_438_957,
    vramRequiredMB: 2504.76,
    license: "Qwen Research License",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B Instruct",
    tier: "alternate",
    params: "3B",
    blurb:
      "Alternative 3B. Slightly larger download, slightly lower GPU requirement.",
    downloadBytes: 1_816_632_516 + 5_957_281,
    vramRequiredMB: 2263.69,
    license: "Llama 3.2 Community License",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 1.5B Instruct",
    tier: "small",
    params: "1.5B",
    blurb:
      "Half the download. The pick for an integrated GPU that still needs valid tool calls.",
    downloadBytes: 875_705_761 + 5_225_782,
    vramRequiredMB: 1629.75,
    license: "Apache-2.0",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B Instruct",
    tier: "low-end",
    params: "1B",
    blurb:
      "For weak or integrated GPUs: about 0.9 GB of VRAM. Expect more malformed tool calls.",
    downloadBytes: 704_397_819 + 5_320_982,
    vramRequiredMB: 879.04,
    license: "Llama 3.2 Community License",
  },
];

export const DEFAULT_MODEL_ID: LocalModelId = "Qwen2.5-3B-Instruct-q4f16_1-MLC";

export function getModel(id: LocalModelId): LocalModelInfo {
  return LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[0];
}

/** GB-aware size string — `lib/format.ts#bytes` stops at MB, models are ~1.7 GB. */
export function formatModelSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const MB = 1024 * 1024;
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

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

// ─────────────────────────── STUB ↓  (delete at T1-a merge) ──────────────────

const CACHE_IDS_KEY = "airlock.localModel.stub.cachedIds";

function readCachedIds(): LocalModelId[] {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_IDS_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr.filter((x): x is LocalModelId =>
          LOCAL_MODELS.some((m) => m.id === x)
        )
      : [];
  } catch {
    return [];
  }
}

function writeCachedIds(ids: LocalModelId[]): void {
  try {
    globalThis.localStorage?.setItem(CACHE_IDS_KEY, JSON.stringify(ids));
  } catch {
    /* private window / storage disabled — the stub just won't remember */
  }
}

interface AdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

function describeAdapter(info: AdapterInfoLike | undefined): string {
  if (!info) return "GPU (details withheld by the browser)";
  const parts = [info.vendor, info.architecture].filter(
    (p): p is string => !!p && p.length > 0
  );
  if (parts.length) return parts.join(" - ");
  return info.description || info.device || "GPU (details withheld by the browser)";
}

function rankSpeed(text: string, maxBindingBytes: number): LocalHardwareReport["speed"] {
  if (/swiftshader|llvmpipe|basic render|software/i.test(text)) return "slow";
  const MiB = 1024 * 1024;
  if (maxBindingBytes >= 1024 * MiB) return "fast";
  if (maxBindingBytes >= 256 * MiB) return "usable";
  if (maxBindingBytes > 0) return "slow";
  return "unknown";
}

/**
 * Real WebGPU feature-detection — condensed from T1-a's `detectWebGpu`. Never
 * throws and never logs (a throw becomes an `available:false` report), which is
 * what keeps a WebGPU-less browser free of console errors. The weight-mirror
 * probe that T1-a's store also runs is deliberately NOT done here: a 404 against
 * a dev server with no `/models/` mirror would show up as a console network
 * error, and the stub's job is to make the happy path demoable, not to test the
 * deploy.
 */
async function probeHardware(): Promise<{
  hw: LocalHardwareReport;
  blocker: LocalModelBlocker;
}> {
  try {
    const nav = globalThis.navigator as unknown as {
      gpu?: {
        requestAdapter(o?: unknown): Promise<{
          features?: { has(n: string): boolean };
          limits?: { maxStorageBufferBindingSize?: number };
          info?: AdapterInfoLike;
          requestAdapterInfo?: () => Promise<AdapterInfoLike>;
        } | null>;
      };
    };
    if (!nav?.gpu?.requestAdapter) {
      return {
        blocker: "no-webgpu",
        hw: {
          available: false,
          adapter: "",
          speed: "unknown",
          reason:
            "This browser does not expose WebGPU. Running a model on your device needs Chrome or Edge 113+, or Safari 18+, with hardware acceleration enabled.",
        },
      };
    }
    const adapter = await nav.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      return {
        blocker: "no-webgpu",
        hw: {
          available: false,
          adapter: "",
          speed: "unknown",
          reason:
            "WebGPU is present but no GPU adapter was granted — usually a headless session, a blocklisted driver, or hardware acceleration turned off.",
        },
      };
    }
    let info = adapter.info;
    if (!info && typeof adapter.requestAdapterInfo === "function") {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        info = undefined;
      }
    }
    const name = describeAdapter(info);
    const f16 = adapter.features?.has("shader-f16") ?? false;
    const maxBinding = adapter.limits?.maxStorageBufferBindingSize ?? 0;
    if (!f16) {
      return {
        blocker: "no-webgpu",
        hw: {
          available: false,
          adapter: name,
          speed: "unknown",
          reason:
            "Your GPU reports no support for 16-bit shaders (shader-f16), which every model in the local catalog needs.",
        },
      };
    }
    const text = [info?.vendor, info?.architecture, info?.device, info?.description]
      .filter(Boolean)
      .join(" ");
    return {
      blocker: "none",
      hw: {
        available: true,
        adapter: name,
        speed: rankSpeed(text, maxBinding),
        reason: "",
      },
    };
  } catch (err) {
    return {
      blocker: "no-webgpu",
      hw: {
        available: false,
        adapter: "",
        speed: "unknown",
        reason: `The WebGPU check did not complete: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }
}

function cachedBytes(ids: LocalModelId[]): number {
  return ids.reduce((sum, id) => sum + getModel(id).downloadBytes, 0);
}

function createStubLocalModelStore(): LocalModelStore {
  const cached = readCachedIds();
  const selected = DEFAULT_MODEL_ID;

  let state: LocalModelState = {
    status: cached.includes(selected) ? "ready" : "not-downloaded",
    selectedModelId: selected,
    activeModelId: null,
    progress: null,
    partialBytes: 0,
    error: null,
    unavailableReason: null,
    blocker: "none",
    hardware: null,
    cache: { bytesOnDisk: cachedBytes(cached), cachedModelIds: cached },
  };

  const listeners = new Set<() => void>();
  let snapshot = state;
  const emit = () => {
    snapshot = state;
    for (const l of listeners) l();
  };
  const set = (patch: Partial<LocalModelState>) => {
    state = { ...state, ...patch };
    emit();
  };

  let ticker: ReturnType<typeof setInterval> | null = null;
  let warmup: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  const FULL_DOWNLOAD_MS = 9000;

  const stop = () => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (warmup) {
      clearTimeout(warmup);
      warmup = null;
    }
  };

  const complete = () => {
    stop();
    const id = state.selectedModelId;
    const next = state.cache.cachedModelIds.includes(id)
      ? state.cache.cachedModelIds
      : [...state.cache.cachedModelIds, id];
    writeCachedIds(next);
    set({
      status: "ready",
      progress: null,
      partialBytes: 0,
      cache: { cachedModelIds: next, bytesOnDisk: cachedBytes(next) },
    });
  };

  const runDownload = () => {
    const total = getModel(state.selectedModelId).downloadBytes;
    startedAt = Date.now() - (state.partialBytes / total) * FULL_DOWNLOAD_MS;
    ticker = setInterval(() => {
      const prev = state.progress?.loadedBytes ?? state.partialBytes;
      const loaded = Math.min(total, prev + total * (0.02 + Math.random() * 0.03));
      if (loaded >= total) {
        if (ticker) {
          clearInterval(ticker);
          ticker = null;
        }
        // Weights are all here — now WebLLM warms the GPU (no bytes, indeterminate).
        set({
          progress: {
            fraction: 1,
            loadedBytes: total,
            totalBytes: total,
            label: "Loading the model onto your GPU…",
            fetching: false,
            elapsedMs: Date.now() - startedAt,
          },
        });
        warmup = setTimeout(complete, 1100);
        return;
      }
      set({
        progress: {
          fraction: loaded / total,
          loadedBytes: loaded,
          totalBytes: total,
          label: "Downloading model weights from this site…",
          fetching: true,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }, 260);
  };

  return {
    getState: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    async refresh() {
      const { hw, blocker } = await probeHardware();
      const isCached = state.cache.cachedModelIds.includes(state.selectedModelId);
      let status = state.status;
      let unavailableReason = state.unavailableReason;
      if (status === "downloading" || status === "paused" || status === "running") {
        // don't yank the rug out from under an in-flight operation
      } else if (!hw.available) {
        status = "unavailable";
        unavailableReason = hw.reason;
      } else if (status === "unavailable") {
        status = isCached ? "ready" : "not-downloaded";
        unavailableReason = null;
      }
      set({ hardware: hw, blocker, status, unavailableReason });
    },

    selectModel(id) {
      if (state.status === "downloading" || state.status === "running") return;
      const isCached = state.cache.cachedModelIds.includes(id);
      const noGpu = state.hardware != null && !state.hardware.available;
      set({
        selectedModelId: id,
        partialBytes: 0,
        progress: null,
        error: null,
        status: noGpu ? "unavailable" : isCached ? "ready" : "not-downloaded",
      });
    },

    async download() {
      if (state.status === "downloading") return;
      if (state.hardware != null && !state.hardware.available) return;
      if (state.cache.cachedModelIds.includes(state.selectedModelId)) {
        set({ status: "ready" });
        return;
      }
      const total = getModel(state.selectedModelId).downloadBytes;
      set({
        status: "downloading",
        error: null,
        progress: {
          fraction: state.partialBytes / total,
          loadedBytes: state.partialBytes,
          totalBytes: total,
          label: "Starting the download…",
          fetching: true,
          elapsedMs: 0,
        },
      });
      runDownload();
    },

    cancelDownload() {
      if (state.status !== "downloading") return;
      stop();
      set({
        status: "paused",
        partialBytes: state.progress?.loadedBytes ?? state.partialBytes,
      });
    },

    async load() {
      if (state.status !== "ready") return;
      // Real store emits LoadProgress here while WebLLM warms the GPU; the stub
      // flips straight through.
      set({
        status: "running",
        activeModelId: state.selectedModelId,
        progress: null,
        error: null,
      });
    },

    async unload() {
      if (state.status !== "running") return;
      set({ status: "ready", activeModelId: null });
    },

    async deleteWeights(id) {
      stop();
      const isFull = state.cache.cachedModelIds.includes(id);
      const reclaimed = isFull ? getModel(id).downloadBytes : state.partialBytes;
      const next = state.cache.cachedModelIds.filter((x) => x !== id);
      writeCachedIds(next);
      const hitSelection = state.selectedModelId === id;
      const noGpu = state.hardware != null && !state.hardware.available;
      set({
        cache: { cachedModelIds: next, bytesOnDisk: cachedBytes(next) },
        partialBytes: hitSelection ? 0 : state.partialBytes,
        progress: hitSelection ? null : state.progress,
        activeModelId: state.activeModelId === id ? null : state.activeModelId,
        status: hitSelection
          ? noGpu
            ? "unavailable"
            : "not-downloaded"
          : state.status,
      });
      return reclaimed;
    },

    clearError() {
      const isCached = state.cache.cachedModelIds.includes(state.selectedModelId);
      set({
        error: null,
        status: isCached
          ? "ready"
          : state.partialBytes > 0
            ? "paused"
            : "not-downloaded",
      });
    },
  };
}

// ─────────────────────────── STUB ↑ ─────────────────────────────────────────

export const localModelStore: LocalModelStore = createStubLocalModelStore();

export function useLocalModelStore(): LocalModelState {
  return React.useSyncExternalStore(
    localModelStore.subscribe,
    localModelStore.getState,
    localModelStore.getState
  );
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
        className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs hover:bg-ink-800"
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
            The model is downloaded once, from this site — the same origin as the
            app itself, counted as an asset load, not external traffic. After
            that it lives in this browser and runs on your GPU.
          </p>
        </div>
      )}
    </div>
  );
}
