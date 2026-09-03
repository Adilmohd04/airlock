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
  DEPLOY_DEFAULT_MODEL_ID,
  customModelId,
  getModel,
  isLocalModelId,
  LOCAL_MODELS,
  readCustomModels,
  removeCustomModel as persistRemoveCustom,
  saveCustomModel as persistSaveCustom,
  validateCustomModel,
  type CustomModelEntry,
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
  /** User-supplied models (localStorage). Driven via downloadCustom*, never the catalog path. */
  customModels: CustomModelEntry[];
  /** Label of the custom model on the GPU (status `running`), else null. */
  customActiveLabel: string | null;
}

type Listener = () => void;

/** Remembers the user's model choice. localStorage only, never the network. */
const SELECTION_KEY = "airlock.localModel.v1";

/**
 * The stored model id, and whether that entry was actually there (as
 * opposed to `id` being `DEFAULT_MODEL_ID` only because nothing is stored
 * yet — one localStorage read, one validation rule, used by both readers
 * below so they cannot silently disagree).
 */
function readSelectionState(): { id: LocalModelId; wasStored: boolean } {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw && isLocalModelId(raw)) return { id: raw, wasStored: true };
  } catch {
    /* private window / storage blocked — the default is fine */
  }
  return { id: DEFAULT_MODEL_ID, wasStored: false };
}

function readSelection(): LocalModelId {
  return readSelectionState().id;
}

/** True only if the user (or a prior fallback) actually chose a model. */
function hasStoredSelection(): boolean {
  return readSelectionState().wasStored;
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
  /** Which selection `refreshPromise` is (eventually) probing — see `refresh()`. */
  private refreshingForId: LocalModelId | null = null;
  /** Bumped on every new (non-shared) `refresh()` call — see `refresh()`. */
  private epoch = 0;
  /** Exact download size from the mirror manifest, when it published one. */
  private mirrorBytes = new Map<LocalModelId, number>();
  /**
   * False on a fresh browser (no localStorage entry yet) — meaning
   * `selectedModelId` is only `DEFAULT_MODEL_ID` by fallback, not by an
   * actual choice, so `runRefresh` is free to swap it for
   * `DEPLOY_DEFAULT_MODEL_ID` if this origin only mirrors that one.
   * Flips true forever once the user (or that swap) picks a model.
   */
  private hadStoredSelection = hasStoredSelection();

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
      customModels: readCustomModels(),
      customActiveLabel: null,
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
   * already cached — this origin's weight mirror. Idempotent for the same
   * selection: concurrent callers share one probe. If `selectModel()` picks
   * a different model while a probe is in flight, that probe's result is
   * stale for the new selection (`runRefresh` detects and discards it —
   * see the epoch check there) and starts a fresh, independent probe for the
   * new selection right away rather than leaving it unprobed.
   */
  refresh(): Promise<void> {
    const currentId = this.state.selectedModelId;
    if (this.refreshPromise && this.refreshingForId === currentId) {
      return this.refreshPromise;
    }
    // A new generation: whichever runRefresh() calls are mid-flight for an
    // older generation must not apply their (now possibly stale) result —
    // each checks `myEpoch === this.epoch` right before writing state, so
    // only the most recent refresh() ever wins, however many overlap.
    const myEpoch = ++this.epoch;
    this.refreshingForId = currentId;
    const p = this.runRefresh(myEpoch).finally(() => {
      // Only clear the shared "in flight" bookkeeping if nothing newer has
      // already claimed it — an old generation's finally must not erase a
      // newer generation's still-running probe.
      if (this.epoch === myEpoch) {
        this.refreshPromise = null;
        this.refreshingForId = null;
      }
    });
    this.refreshPromise = p;
    return p;
  }

  private async runRefresh(myEpoch: number): Promise<void> {
    const superseded = () => myEpoch !== this.epoch;

    const hardware = await this.adapter.detectGpu();
    if (superseded()) return;
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
    if (superseded()) return;
    let id = this.state.selectedModelId;
    let cached = cachedModelIds.includes(id);

    let blocker: LocalModelBlocker = "none";
    let unavailableReason: string | null = null;
    if (!cached) {
      // Only ask the network when we have to. A browser that already holds the
      // weights must stay usable with the network off.
      const hosting = await this.adapter.probeHosted(id);
      if (superseded()) return;
      if (hosting.manifest) {
        this.mirrorBytes.set(
          id,
          hosting.manifest.weightsBytes + hosting.manifest.libBytes
        );
      }
      if (!hosting.hosted) {
        // The untouched default (DEFAULT_MODEL_ID, the 3B) is what real
        // hardware should run, but a size-constrained public deploy may only
        // mirror DEPLOY_DEFAULT_MODEL_ID (the 1.5B) — see models.ts. Only a
        // fallback that was never an explicit user choice may be swapped;
        // once the user (or this swap) has picked a model, respect it and
        // report honestly if it is not hosted.
        if (
          !this.hadStoredSelection &&
          id === DEFAULT_MODEL_ID &&
          DEPLOY_DEFAULT_MODEL_ID !== DEFAULT_MODEL_ID
        ) {
          const deployHosting = await this.adapter.probeHosted(
            DEPLOY_DEFAULT_MODEL_ID
          );
          // Re-check after the second await: a selectModel() during this
          // probe must not have its localStorage entry clobbered by a
          // fallback decision that started before the user's real choice.
          if (superseded()) return;
          if (deployHosting.hosted) {
            id = DEPLOY_DEFAULT_MODEL_ID;
            cached = cachedModelIds.includes(id);
            writeSelection(id);
            this.hadStoredSelection = true;
            if (deployHosting.manifest) {
              this.mirrorBytes.set(
                id,
                deployHosting.manifest.weightsBytes +
                  deployHosting.manifest.libBytes
              );
            }
          } else {
            // Neither model is hosted — `id` stays DEFAULT_MODEL_ID (the
            // fallback never took), so the reason shown must be about that
            // one, not the fallback candidate that was only being scouted.
            blocker = "no-weights-hosted";
            unavailableReason = hosting.reason;
          }
        } else {
          blocker = "no-weights-hosted";
          unavailableReason = hosting.reason;
        }
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
      selectedModelId: id,
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
    // An explicit pick — even of DEFAULT_MODEL_ID itself — must stick. Without
    // this, switching back to the 3B on a deploy that only mirrors the 1.5B
    // would get silently overridden by the deploy-default fallback on the
    // next refresh(), the same class of bug that fallback exists to avoid.
    this.hadStoredSelection = true;
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

    // Ask the browser to make this origin's storage durable before writing
    // ~1 GB of weights into the Cache API. Without a persisted bucket the
    // browser can evict them under storage pressure and the model appears to
    // re-download every few days. Fire-and-forget; the boot path asks too, but
    // a click is the moment a UA is most likely to grant it.
    if (intent === "download") {
      void navigator.storage
        ?.persisted?.()
        .then((ok) => (ok ? undefined : navigator.storage?.persist?.()))
        .catch(() => undefined);
    }

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
      customActiveLabel: null,
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

  // ── User-supplied models ────────────────────────────────────────────────
  // Parallel to the catalog path, deliberately separate: custom weights are
  // external-by-definition (consented, egress-counted, then cached offline),
  // so they never flow through the mirror probe or `assertSameOrigin`.

  /** Validate + persist a user-supplied model. Throws UI-safe copy. */
  addCustomModel(input: { label: string; modelUrl: string; libUrl: string }): void {
    const entry = validateCustomModel(input);
    this.set({ customModels: persistSaveCustom(entry), error: null });
  }

  /** Forget a custom model and delete its cached weights. */
  async removeCustomModel(label: string): Promise<void> {
    const entry = this.state.customModels.find((e) => e.label === label);
    if (this.state.customActiveLabel === label) await this.unload();
    if (entry) {
      try {
        await this.adapter.deleteCustomWeights?.(entry.modelUrl, entry.libUrl);
      } catch {
        /* a half-present cache deletes best-effort */
      }
    }
    this.set({
      customModels: persistRemoveCustom(label),
      customActiveLabel:
        this.state.customActiveLabel === label ? null : this.state.customActiveLabel,
    });
    void this.refreshCacheOnly();
  }

  /**
   * Fetch a custom model's weights (one external, consented download — the
   * egress monitor counts it, so the Seal shows it) and bring it onto the
   * GPU. Ends at `running` with `customActiveLabel` set. Cached shards are
   * skipped, so re-load after the first download is offline.
   */
  async downloadCustom(label: string): Promise<void> {
    const entry = this.state.customModels.find((e) => e.label === label);
    if (!entry) {
      this.set({ status: "error", error: `Unknown custom model "${label}".` });
      return;
    }
    if (this.state.hardware === null) await this.refresh();
    if (!this.state.hardware?.available) {
      this.set({
        status: "error",
        error: "Local mode needs WebGPU — try a recent Chrome or Edge on desktop.",
      });
      return;
    }
    const s = this.state.status;
    if (s === "downloading" || s === "running") return;

    const id = customModelId(entry.label) as unknown as LocalModelId;
    const startedAt = Date.now();
    const controller = new AbortController();
    this.abort = controller;
    this.set({
      status: "downloading",
      error: null,
      customActiveLabel: null,
      progress: {
        fraction: 0,
        loadedBytes: 0,
        totalBytes: 0,
        label: `Fetching ${entry.label} (external, one-time)…`,
        fetching: true,
        elapsedMs: 0,
      },
    });

    try {
      const engine = await this.adapter.load({
        modelId: id,
        signal: controller.signal,
        custom: { modelUrl: entry.modelUrl, libUrl: entry.libUrl, contextWindow: 4096 },
        onProgress: (p) => {
          if (this.abort !== controller) return;
          const fraction = Number.isFinite(p.progress) ? p.progress : 0;
          this.set({
            progress: {
              fraction,
              loadedBytes: 0,
              totalBytes: 0,
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
        customActiveLabel: entry.label,
        progress: null,
        partialBytes: 0,
        error: null,
      });
      void this.refreshCacheOnly();
    } catch (err) {
      this.engine = null;
      const aborted = err instanceof LoadAbortedError || controller.signal.aborted;
      if (aborted) {
        this.set({ status: "not-downloaded", activeModelId: null, customActiveLabel: null, progress: null });
      } else {
        this.set({
          status: "error",
          activeModelId: null,
          customActiveLabel: null,
          progress: null,
          error: messageOf(err),
        });
      }
      void this.refreshCacheOnly();
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  /**
   * Generate. The only path that should reach the engine, because it is what
   * keeps `generating` honest — the mode indicator and the ledger both rely on
   * the store knowing whether the model is mid-turn.
   */
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    if (!this.engine || this.state.status !== "running") {
      // The store thinks it's loaded but the engine is gone, or the weights are
      // cached and just not on the GPU yet. Bring it back rather than failing.
      if (this.state.cache.cachedModelIds.includes(this.state.selectedModelId)) {
        // `download` is the universal "get to running" call — instant when the
        // weights are already cached, and it works from ready/paused/error,
        // unlike `load` which only resumes from `ready`.
        await this.warm("download");
      }
      if (!this.engine || this.state.status !== "running") {
        throw new Error(
          "The local model is not loaded. Open the model panel and click Load."
        );
      }
    }
    this.set({ generating: true, error: null });
    try {
      return await this.engine.chat(request);
    } catch (err) {
      const m = messageOf(err);
      // WebLLM lost the model (GPU context loss, or its own internal unload):
      // "Model not loaded before trying to complete ChatCompletionRequest".
      // Reload once and retry before surfacing the failure to the loop.
      if (
        /model not loaded|not been loaded|reload\(|CreateMLCEngine/i.test(m) &&
        this.state.cache.cachedModelIds.includes(this.state.selectedModelId)
      ) {
        this.engine = null;
        this.set({ status: "ready" });
        await this.warm("download");
        // `warm` reassigns `this.engine`; read it through a fresh access so
        // TS drops the `null` narrowing from the assignment above (a plain
        // const initializer would inherit it and narrow to `never`).
        const revived = this.getEngine();
        if (revived && this.state.status === "running") {
          return await revived.chat(request);
        }
      }
      this.set({ error: m });
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
