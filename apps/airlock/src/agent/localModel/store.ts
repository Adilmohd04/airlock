/**
 * `LocalModelStore` — the one piece of state the download UI, the mode
 * indicator and the local agent loop all read.
 *
 * Same idiom as `activityLog` / `reportStore`: a class with `getState()` +
 * `subscribe()` returning a referentially-stable snapshot, so a component binds
 * with `useSyncExternalStore(store.subscribe, store.getState)` and nothing else
 * in the app needs to know how models load.
 *
 * ── Whose shape this is ────────────────────────────────────────────────────
 * The state and method names are T1-c's, per claude-main's ruling in COLLAB
 * (2026-09-02): seven states, `blocker`, `partialBytes`, `activeModelId`,
 * `deleteWeights(id) -> bytes reclaimed`. T1-c's `LocalModelPanel` stub was
 * written against exactly this interface, so swapping the stub for this store
 * is a delete plus two imports. Three things are additive on top, because the
 * agent loop needs them and no UI field covers them: `generating`,
 * `getEngine()` / `chat()` / `interrupt()`, and `toAgentModeStatus()` for
 * T1-d's five-state consumer.
 *
 * ── The state machine ──────────────────────────────────────────────────────
 *
 *                     ┌──────────── clearError ────────────┐
 *                     ▼                                    │
 *   unavailable   not-downloaded ──download()──▶ downloading ──▶ error
 *        ▲             ▲     ▲                    │      │
 *        │             │     └─ cancelDownload ─▶ paused ┘
 *        │        deleteWeights                   │ (download() resumes)
 *        │             │                          ▼
 *        └── no WebGPU │                        running ◀── load() ── ready
 *            no mirror └──────────────────────────┴── unload() ──────┘
 *
 *  - `ready`   — weights are on this device; the GPU is free.
 *  - `running` — the model is resident on the GPU and can answer. `generating`
 *                says whether it is mid-answer right now.
 *
 * `hardware === null` means "not probed yet"; the UI should show a spinner
 * rather than any claim until `refresh()` resolves.
 *
 * ── Egress ─────────────────────────────────────────────────────────────────
 * Every request this store can cause is a GET to `/models/...` on the page's
 * own origin: one small manifest probe, then WebLLM's shard fetches. There is
 * no third-party origin in the catalog and `buildAppConfig()` throws if one
 * ever appears, so the Seal's external counter stays at 0 across a model
 * download. Nothing about the user's data is involved in any of it.
 */

import {
  DEFAULT_MODEL_ID,
  getModel,
  isLocalModelId,
  LOCAL_MODELS,
  type LocalModelId,
} from "./models";
import {
  LoadAbortedError,
  webllmAdapter,
  type GpuReport,
  type LoadedEngine,
  type LocalChatRequest,
  type LocalChatResult,
  type LocalRuntimeAdapter,
} from "./runtime";

export type LocalModelStatus =
  | "unavailable"
  | "not-downloaded"
  | "downloading"
  | "paused"
  | "ready"
  | "running"
  | "error";

/** Why local mode is unavailable — the two causes need different copy. */
export type LocalModelBlocker = "none" | "no-webgpu" | "no-weights-hosted";

/**
 * The hardware report the UI renders. A superset of the four fields T1-c's
 * panel reads, so it is assignable wherever that narrower type is expected.
 */
export type LocalHardwareReport = GpuReport;

export interface LocalModelProgress {
  /** 0..1, straight from the runtime. */
  fraction: number;
  /** Derived from `fraction × totalBytes` — WebLLM reports a fraction, not bytes. */
  loadedBytes: number;
  totalBytes: number;
  /** The runtime's own status line, safe to show verbatim. */
  label: string;
  /** True = pulling weights over the (same-origin) network; false = warming the GPU. */
  fetching: boolean;
  elapsedMs: number;
}

export interface LocalModelCache {
  /** Bytes in the browser's model cache, or null when it cannot be measured. */
  bytesOnDisk: number | null;
  cachedModelIds: LocalModelId[];
}

export interface LocalModelState {
  status: LocalModelStatus;
  selectedModelId: LocalModelId;
  /** The model resident on the GPU (status `running`), else null. */
  activeModelId: LocalModelId | null;
  progress: LocalModelProgress | null;
  /** Bytes kept from a cancelled download, so the UI can offer "resume". */
  partialBytes: number;
  /** Set iff `status === "error"`. */
  error: string | null;
  /** Set iff `status === "unavailable"`. */
  unavailableReason: string | null;
  blocker: LocalModelBlocker;
  /** Null until the first hardware probe resolves. */
  hardware: LocalHardwareReport | null;
  cache: LocalModelCache;
  /**
   * Additive (T1-b): true while a completion is in flight. `status` stays
   * `running` — the model is loaded either way; this is about the turn.
   */
  generating: boolean;
}

type Listener = () => void;

/** Remembers the user's model choice. localStorage only, never the network. */
const SELECTION_KEY = "airlock.localModel.v1";

function readSelection(): LocalModelId {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw && isLocalModelId(raw)) return raw;
  } catch {
    /* private window / storage blocked — the default is fine */
  }
  return DEFAULT_MODEL_ID;
}

function writeSelection(id: LocalModelId): void {
  try {
    localStorage.setItem(SELECTION_KEY, id);
  } catch {
    /* the choice just will not survive a reload; not worth failing over */
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Collapse the seven states onto the five `agent/agentMode.ts` accepts.
 * `paused` and `error` are both "there is no model to talk to yet, but the
 * machine is capable" — which is exactly `not-downloaded` from the mode
 * indicator's point of view. Exported so the integration does not have to
 * invent this mapping twice.
 */
export function toAgentModeStatus(
  status: LocalModelStatus
): "unavailable" | "not-downloaded" | "downloading" | "ready" | "running" {
  switch (status) {
    case "paused":
    case "error":
      return "not-downloaded";
    default:
      return status;
  }
}

export class LocalModelStore {
  private state: LocalModelState;
  private snapshot: LocalModelState;
  private listeners = new Set<Listener>();

  private engine: LoadedEngine | null = null;
  private abort: AbortController | null = null;
  private refreshPromise: Promise<void> | null = null;
  /** Exact download size from the mirror manifest, when it published one. */
  private mirrorBytes = new Map<LocalModelId, number>();

  constructor(private adapter: LocalRuntimeAdapter = webllmAdapter) {
    this.state = {
      status: "not-downloaded",
      selectedModelId: readSelection(),
      activeModelId: null,
      progress: null,
      partialBytes: 0,
      error: null,
      unavailableReason: null,
      blocker: "none",
      hardware: null,
      cache: { bytesOnDisk: null, cachedModelIds: [] },
      generating: false,
    };
    this.snapshot = { ...this.state };
  }

  getState = (): LocalModelState => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.snapshot = { ...this.state };
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<LocalModelState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** The full catalog, so a component needs one import rather than two. */
  readonly catalog = LOCAL_MODELS;

  /** The engine T1-b drives. Null unless `status === "running"`. */
  getEngine(): LoadedEngine | null {
    return this.engine;
  }

  /** True while an operation would be disrupted by a state change underneath it. */
  private get busy(): boolean {
    const s = this.state.status;
    return s === "downloading" || s === "paused" || s === "running";
  }

  private expectedBytes(id: LocalModelId): number {
    return this.mirrorBytes.get(id) ?? getModel(id).downloadBytes;
  }

  /**
   * Probe the GPU, the browser cache and — only when the selection is not
   * already cached — this origin's weight mirror. Idempotent; concurrent
   * callers share one probe.
   */
  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.runRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async runRefresh(): Promise<void> {
    const hardware = await this.adapter.detectGpu();
    if (!hardware.available) {
      // Terminal for this session: no WebLLM import, no fetch, no console noise.
      this.set({
        hardware,
        blocker: "no-webgpu",
        // Never yank the rug from under an operation already in flight.
        status: this.busy ? this.state.status : "unavailable",
        unavailableReason: hardware.reason,
      });
      return;
    }

    const cachedModelIds = await this.listCached();
    const bytesOnDisk = await this.measureCache();
    const id = this.state.selectedModelId;
    const cached = cachedModelIds.includes(id);

    let blocker: LocalModelBlocker = "none";
    let unavailableReason: string | null = null;
    if (!cached) {
      // Only ask the network when we have to. A browser that already holds the
      // weights must stay usable with the network off.
      const hosting = await this.adapter.probeHosted(id);
      if (hosting.manifest) {
        this.mirrorBytes.set(
          id,
          hosting.manifest.weightsBytes + hosting.manifest.libBytes
        );
      }
      if (!hosting.hosted) {
        blocker = "no-weights-hosted";
        unavailableReason = hosting.reason;
      }
    }

    const status: LocalModelStatus = this.busy
      ? this.state.status
      : this.state.status === "error"
        ? "error"
        : cached
          ? "ready"
          : blocker === "none"
            ? "not-downloaded"
            : "unavailable";

    this.set({
      hardware,
      blocker,
      unavailableReason,
      status,
      cache: { bytesOnDisk, cachedModelIds },
    });
  }

  private async listCached(): Promise<LocalModelId[]> {
    const found: LocalModelId[] = [];
    for (const m of LOCAL_MODELS) {
      try {
        if (await this.adapter.isCached(m.id)) found.push(m.id);
      } catch {
        /* an unreadable cache is the same as an empty one */
      }
    }
    return found;
  }

  private async measureCache(): Promise<number | null> {
    try {
      return await this.adapter.cacheBytes();
    } catch {
      return null;
    }
  }

  /**
   * Switch models. Synchronous, so the UI responds on the click; the mirror
   * re-probe for the new selection runs behind it.
   */
  selectModel(id: LocalModelId): void {
    if (this.state.status === "downloading" || this.state.status === "running") {
      return;
    }
    if (id === this.state.selectedModelId) return;
    const cached = this.state.cache.cachedModelIds.includes(id);
    const noGpu = this.state.hardware !== null && !this.state.hardware.available;
    writeSelection(id);
    this.set({
      selectedModelId: id,
      partialBytes: 0,
      progress: null,
      error: null,
      status: noGpu ? "unavailable" : cached ? "ready" : "not-downloaded",
    });
    void this.refresh();
  }

  /**
   * Fetch the weights if they are not here yet, then bring the model onto the
   * GPU. Ends at `running`.
   *
   * WebLLM has no download-without-loading primitive — `reload()` fetches and
   * warms in one pass — so "download" and "load" are the same call with
   * different copy. A resume after `cancelDownload()` costs nothing extra:
   * shards already written to the Cache API are skipped.
   */
  download(): Promise<void> {
    return this.warm("download");
  }

  /** Bring already-cached weights onto the GPU: `ready` → `running`. */
  load(): Promise<void> {
    return this.warm("load");
  }

  private async warm(intent: "download" | "load"): Promise<void> {
    if (this.state.hardware === null) await this.refresh();
    const s = this.state.status;
    if (s === "downloading" || s === "running") return;
    if (s === "unavailable") {
      this.set({
        status: "error",
        error:
          this.state.unavailableReason || "Local mode is not available here.",
      });
      return;
    }
    if (intent === "load" && s !== "ready") return;

    const id = this.state.selectedModelId;
    const cached = this.state.cache.cachedModelIds.includes(id);
    const totalBytes = this.expectedBytes(id);
    const startedAt = Date.now();
    const controller = new AbortController();
    this.abort = controller;

    this.set({
      status: "downloading",
      error: null,
      progress: {
        fraction: totalBytes > 0 ? this.state.partialBytes / totalBytes : 0,
        loadedBytes: this.state.partialBytes,
        totalBytes,
        label: cached
          ? "Loading the model onto your GPU…"
          : "Starting the download…",
        fetching: !cached,
        elapsedMs: 0,
      },
    });

    try {
      const engine = await this.adapter.load({
        modelId: id,
        signal: controller.signal,
        onProgress: (p) => {
          // A late callback from a cancelled load must not repaint the UI.
          if (this.abort !== controller) return;
          const fraction = Number.isFinite(p.progress) ? p.progress : 0;
          this.set({
            progress: {
              fraction,
              loadedBytes: Math.round(fraction * totalBytes),
              totalBytes,
              label: p.text,
              fetching: p.fetching,
              elapsedMs: Date.now() - startedAt,
            },
          });
        },
      });
      this.engine = engine;
      this.set({
        status: "running",
        activeModelId: id,
        progress: null,
        partialBytes: 0,
        error: null,
      });
      void this.refreshCacheOnly();
    } catch (err) {
      this.engine = null;
      const aborted = err instanceof LoadAbortedError || controller.signal.aborted;
      if (aborted) {
        // Cancelling is a choice, not a failure. Keep what landed so the UI can
        // offer "resume" and the resumed download skips those shards.
        this.set({
          status: cached ? "ready" : "paused",
          activeModelId: null,
          partialBytes: cached ? 0 : (this.state.progress?.loadedBytes ?? 0),
          progress: null,
        });
      } else {
        this.set({
          status: "error",
          activeModelId: null,
          progress: null,
          error: messageOf(err),
        });
      }
      void this.refreshCacheOnly();
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  /** Cancel an in-flight download. Cached shards survive → `paused`. */
  cancelDownload(): void {
    if (this.state.status !== "downloading") return;
    this.abort?.abort();
  }

  /** Free the GPU, keep the weights on disk: `running` → `ready`. */
  async unload(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) {
      try {
        await engine.unload();
      } catch {
        /* the GPU context is gone either way */
      }
    }
    const noGpu = this.state.hardware !== null && !this.state.hardware.available;
    this.set({
      status: noGpu ? "unavailable" : "ready",
      activeModelId: null,
      generating: false,
      progress: null,
    });
  }

  /**
   * Delete one model's cached weights. Resolves with the bytes actually
   * reclaimed, measured before and after rather than assumed from the catalog —
   * a partial download would otherwise be reported as a full one.
   */
  async deleteWeights(id: LocalModelId): Promise<number> {
    if (this.state.status === "downloading") this.cancelDownload();
    if (this.state.activeModelId === id) await this.unload();

    const before = await this.measureCache();
    try {
      await this.adapter.deleteWeights(id);
      this.set({ error: null });
    } catch (err) {
      this.set({ status: "error", error: messageOf(err) });
      return 0;
    }
    const after = await this.measureCache();

    const cachedModelIds = this.state.cache.cachedModelIds.filter((x) => x !== id);
    const hitSelection = this.state.selectedModelId === id;
    const noGpu = this.state.hardware !== null && !this.state.hardware.available;
    this.set({
      cache: { bytesOnDisk: after, cachedModelIds },
      partialBytes: hitSelection ? 0 : this.state.partialBytes,
      progress: hitSelection ? null : this.state.progress,
      activeModelId: this.state.activeModelId === id ? null : this.state.activeModelId,
      status: hitSelection
        ? noGpu
          ? "unavailable"
          : "not-downloaded"
        : this.state.status,
    });

    if (before !== null && after !== null && before > after) return before - after;
    // Cache size was unmeasurable; fall back to what we believed was there.
    return this.state.cache.cachedModelIds.includes(id)
      ? getModel(id).downloadBytes
      : this.state.partialBytes;
  }

  /** Leave the `error` state without retrying. */
  clearError(): void {
    if (this.state.status !== "error") {
      this.set({ error: null });
      return;
    }
    const cached = this.state.cache.cachedModelIds.includes(
      this.state.selectedModelId
    );
    const noGpu = this.state.hardware !== null && !this.state.hardware.available;
    this.set({
      error: null,
      status: noGpu
        ? "unavailable"
        : cached
          ? "ready"
          : this.state.partialBytes > 0
            ? "paused"
            : "not-downloaded",
    });
  }

  /** Re-measure the cache without re-probing the GPU or the mirror. */
  async refreshCacheOnly(): Promise<void> {
    const cachedModelIds = await this.listCached();
    const bytesOnDisk = await this.measureCache();
    this.set({ cache: { bytesOnDisk, cachedModelIds } });
  }

  /**
   * Generate. The only path that should reach the engine, because it is what
   * keeps `generating` honest — the mode indicator and the ledger both rely on
   * the store knowing whether the model is mid-turn.
   */
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    const engine = this.engine;
    if (!engine || this.state.status !== "running") {
      throw new Error("The local model is not loaded.");
    }
    this.set({ generating: true, error: null });
    try {
      return await engine.chat(request);
    } catch (err) {
      this.set({ error: messageOf(err) });
      throw err;
    } finally {
      this.set({ generating: false });
    }
  }

  /** Stop the current generation without unloading the model. */
  async interrupt(): Promise<void> {
    await this.engine?.interrupt();
  }
}

export const localModelStore = new LocalModelStore();
