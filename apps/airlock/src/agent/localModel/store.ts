/**
 * `LocalModelStore` — the one piece of state the UI and the local agent loop
 * both read.
 *
 * Same shape as `activityLog` / `reportStore`: a class with
 * `getState()` + `subscribe()` returning a referentially-stable snapshot, so a
 * component can bind with `useSyncExternalStore(store.subscribe, store.getState)`
 * and nothing else in the app needs to know how models load.
 *
 * ── The state machine ──────────────────────────────────────────────────────
 *
 *   unavailable ──init()──▶ not-downloaded ──download()──▶ downloading ──▶ ready
 *        ▲                       ▲   ▲                          │           │ ▲
 *        │                       │   └────── cancel / fail ─────┘   chat()  │ │
 *        └── no WebGPU, or       └── unload() / deleteWeights()          ▼   │
 *            no mirror on                                            running ┘
 *            this origin
 *
 * The store starts at `unavailable` with `initialized: false` — "we have not
 * looked yet" rather than a sixth status, so the union stays exactly the five
 * states the spec names. The UI should show a spinner while `!initialized`.
 *
 * `not-downloaded` means "not loaded onto the GPU". Whether that costs a
 * download or just a few seconds of cache-to-GPU loading is `weightsCached`,
 * and the copy the user sees should differ: "Download 1.63 GB" versus
 * "Load (already on this device)".
 *
 * ── Egress ─────────────────────────────────────────────────────────────────
 * Every request this store can cause is a GET to `/models/...` on the page's
 * own origin: `runtime.probeHostedWeights` fetches one small manifest, and
 * WebLLM fetches the shards. There is no third-party origin in the catalog and
 * `buildAppConfig()` throws if one ever appears, so the Seal's external counter
 * stays at 0 through a model download. Nothing about the user's data is
 * involved in any of it.
 */

import {
  DEFAULT_MODEL_ID,
  getModel,
  isLocalModelId,
  LOCAL_MODELS,
  type LocalModelId,
  type LocalModelInfo,
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
  | "ready"
  | "running";

export interface LocalModelState {
  status: LocalModelStatus;
  /** False until `init()` has finished its first probe. */
  initialized: boolean;
  /** The model the user has chosen. Always a valid catalog id. */
  selectedModelId: LocalModelId;
  /** Catalog entry for `selectedModelId`, for convenience. */
  selected: LocalModelInfo;
  /** The model currently resident on the GPU, or null. */
  activeModel: LocalModelId | null;
  /** 0..1 while `downloading`; 1 once `ready`. */
  progress: number;
  /** WebLLM's status line, e.g. `"Fetching param cache[12/68]: ..."`. */
  progressText: string;
  /** True while bytes are moving; false while cached shards load onto the GPU. */
  fetching: boolean;
  /** True when the selected model's weights are already in this browser. */
  weightsCached: boolean;
  /** Whether this origin serves the weights. Null until probed. */
  weightsHosted: boolean | null;
  /** Plain-language reason for `unavailable`. Empty otherwise. */
  unavailableReason: string;
  /** Last failure. Cleared by the next successful transition. */
  error: string | null;
  /** GPU probe result. Null until `init()` runs. */
  gpu: GpuReport | null;
  /** Bytes WebLLM currently holds in the browser cache, or null if unknown. */
  cachedBytes: number | null;
  /**
   * Bytes the selected model still needs to download: 0 when it is cached,
   * otherwise the mirror's exact figure if the manifest gave us one, else the
   * catalog estimate.
   */
  downloadBytes: number;
  /** True while a download can be cancelled. */
  cancellable: boolean;
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

export class LocalModelStore {
  private state: LocalModelState;
  private snapshot: LocalModelState;
  private listeners = new Set<Listener>();

  private engine: LoadedEngine | null = null;
  private abort: AbortController | null = null;
  private initPromise: Promise<void> | null = null;
  /** Exact download size from the mirror manifest, when it published one. */
  private mirrorBytes = new Map<LocalModelId, number>();

  constructor(private adapter: LocalRuntimeAdapter = webllmAdapter) {
    const selectedModelId = readSelection();
    this.state = {
      status: "unavailable",
      initialized: false,
      selectedModelId,
      selected: getModel(selectedModelId),
      activeModel: null,
      progress: 0,
      progressText: "",
      fetching: false,
      weightsCached: false,
      weightsHosted: null,
      unavailableReason: "",
      error: null,
      gpu: null,
      cachedBytes: null,
      downloadBytes: getModel(selectedModelId).downloadBytes,
      cancellable: false,
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
    if (patch.selectedModelId) {
      this.state.selected = getModel(patch.selectedModelId);
    }
    this.emit();
  }

  /** The full catalog, so a component does not have to import two modules. */
  readonly catalog = LOCAL_MODELS;

  /** The engine T1-b drives. Null unless `status` is `ready` or `running`. */
  getEngine(): LoadedEngine | null {
    return this.engine;
  }

  /**
   * Probe the machine and this origin. Idempotent and safe to call from several
   * components — concurrent callers share one probe.
   */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.runInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async runInit(): Promise<void> {
    const gpu = await this.adapter.detectGpu();
    if (!gpu.available) {
      // Terminal for this session. No WebLLM import, no fetch, no console noise.
      this.set({
        gpu,
        status: "unavailable",
        unavailableReason: gpu.reason,
        initialized: true,
      });
      return;
    }
    this.set({ gpu });
    await this.refreshAvailability();
    this.set({ initialized: true });
    void this.refreshCacheSize();
  }

  /**
   * Re-answer "can we run the selected model, and what will it cost". The cache
   * check comes first on purpose: a browser that already holds the weights must
   * not be blocked by a manifest probe that fails because the network is off.
   */
  private async refreshAvailability(): Promise<void> {
    const id = this.state.selectedModelId;
    const cached = await this.adapter.isCached(id);
    if (cached) {
      this.set({
        weightsCached: true,
        weightsHosted: true,
        status: this.engine ? this.state.status : "not-downloaded",
        unavailableReason: "",
        downloadBytes: 0,
      });
      return;
    }

    const hosting = await this.adapter.probeHosted(id);
    if (hosting.manifest) {
      this.mirrorBytes.set(
        id,
        hosting.manifest.weightsBytes + hosting.manifest.libBytes
      );
    }
    if (!hosting.hosted) {
      this.set({
        weightsCached: false,
        weightsHosted: false,
        status: "unavailable",
        unavailableReason: hosting.reason,
        downloadBytes: this.expectedBytes(id),
      });
      return;
    }
    this.set({
      weightsCached: false,
      weightsHosted: true,
      // Never demote a model that is already resident on the GPU.
      status: this.engine ? this.state.status : "not-downloaded",
      unavailableReason: "",
      downloadBytes: this.expectedBytes(id),
    });
  }

  private expectedBytes(id: LocalModelId): number {
    return this.mirrorBytes.get(id) ?? getModel(id).downloadBytes;
  }

  /** Switch models. Refused while a download or a generation is in flight. */
  async select(id: LocalModelId): Promise<void> {
    if (this.state.status === "downloading" || this.state.status === "running") {
      this.set({ error: "Finish or cancel the current model first." });
      return;
    }
    if (id === this.state.selectedModelId && this.state.initialized) return;
    if (this.engine) await this.unload();
    writeSelection(id);
    this.set({
      selectedModelId: id,
      error: null,
      progress: 0,
      progressText: "",
      downloadBytes: this.expectedBytes(id),
    });
    if (this.state.gpu?.available) await this.refreshAvailability();
  }

  /**
   * Download the weights if they are not cached, then load them onto the GPU.
   * Ends at `ready`. Cancelling is not an error — already-fetched shards stay
   * in the cache, so calling `download()` again resumes.
   */
  async download(): Promise<void> {
    if (!this.state.initialized) await this.init();
    if (this.state.status === "ready" || this.state.status === "running") return;
    if (this.state.status === "downloading") return;
    if (this.state.status === "unavailable") {
      this.set({
        error: this.state.unavailableReason || "Local mode is not available here.",
      });
      return;
    }

    const id = this.state.selectedModelId;
    const controller = new AbortController();
    this.abort = controller;
    this.set({
      status: "downloading",
      progress: 0,
      progressText: this.state.weightsCached
        ? "Loading model onto the GPU…"
        : "Starting download…",
      fetching: !this.state.weightsCached,
      error: null,
      cancellable: true,
    });

    try {
      const engine = await this.adapter.load({
        modelId: id,
        signal: controller.signal,
        onProgress: (p) => {
          // A late callback from a cancelled load must not repaint the UI.
          if (this.abort !== controller) return;
          this.set({
            progress: Number.isFinite(p.progress) ? p.progress : 0,
            progressText: p.text,
            fetching: p.fetching,
          });
        },
      });
      this.engine = engine;
      this.set({
        status: "ready",
        activeModel: id,
        progress: 1,
        progressText: "",
        fetching: false,
        weightsCached: true,
        downloadBytes: 0,
        error: null,
        cancellable: false,
      });
      void this.refreshCacheSize();
    } catch (err) {
      this.engine = null;
      const aborted = err instanceof LoadAbortedError || controller.signal.aborted;
      this.set({
        status: "not-downloaded",
        activeModel: null,
        progress: 0,
        progressText: "",
        fetching: false,
        cancellable: false,
        // A cancel is a choice, not a failure. Anything else is reported.
        error: aborted ? null : messageOf(err),
      });
      // Partial shards may have landed; re-derive what is actually on disk.
      if (this.state.gpu?.available) await this.refreshAvailability();
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  /** Cancel an in-flight download. No-op when nothing is downloading. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Free the GPU. Weights stay cached, so reloading is fast and offline. */
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
    this.set({
      status: this.state.gpu?.available ? "not-downloaded" : "unavailable",
      activeModel: null,
      progress: 0,
      progressText: "",
      fetching: false,
      cancellable: false,
    });
  }

  /** Delete the cached weights and report the reclaimed space. */
  async deleteWeights(): Promise<void> {
    if (this.state.status === "downloading") this.cancel();
    await this.unload();
    try {
      await this.adapter.deleteWeights(this.state.selectedModelId);
      this.set({ weightsCached: false, error: null });
    } catch (err) {
      this.set({ error: messageOf(err) });
    }
    await this.refreshCacheSize();
    if (this.state.gpu?.available) await this.refreshAvailability();
  }

  /** Re-measure the browser cache. Cheap; safe to call after any transition. */
  async refreshCacheSize(): Promise<void> {
    try {
      this.set({ cachedBytes: await this.adapter.cacheBytes() });
    } catch {
      this.set({ cachedBytes: null });
    }
  }

  /**
   * Generate. This is the only path that should reach the engine, because it is
   * what makes `running` true — the ledger and the Seal both rely on the status
   * being honest about whether the model is thinking.
   */
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    const engine = this.engine;
    if (!engine || this.state.status !== "ready") {
      throw new Error("The local model is not loaded.");
    }
    this.set({ status: "running", error: null });
    try {
      return await engine.chat(request);
    } catch (err) {
      this.set({ error: messageOf(err) });
      throw err;
    } finally {
      // Unload may have raced us; do not resurrect a dead engine's status.
      this.set({ status: this.engine ? "ready" : "not-downloaded" });
    }
  }

  /** Stop the current generation without unloading the model. */
  async interrupt(): Promise<void> {
    await this.engine?.interrupt();
  }
}

export const localModelStore = new LocalModelStore();
