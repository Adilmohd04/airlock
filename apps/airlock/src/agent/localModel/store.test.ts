/**
 * `LocalModelStore` state-machine tests, driven through a fake
 * `LocalRuntimeAdapter` — no GPU, no network, no WebLLM import.
 *
 * The walk BUILD_PROMPT names is asserted end to end
 * (`unavailable → not-downloaded → downloading → ready/running`), together with
 * T1-c's two extra states (`paused`, `error`) and the branches that decide
 * whether the product is honest: a machine with no WebGPU never reaches for the
 * network, and a browser that already holds the weights never depends on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalModelStore, toAgentModeStatus, type LocalModelStatus } from "./store";
import {
  DEFAULT_MODEL_ID,
  DEPLOY_DEFAULT_MODEL_ID,
  LOCAL_MODELS,
  type LocalModelId,
} from "./models";
import {
  LoadAbortedError,
  type GpuReport,
  type HostingReport,
  type LoadedEngine,
  type LoadOptions,
  type LocalRuntimeAdapter,
} from "./runtime";

const OTHER_ID = LOCAL_MODELS.find((m) => m.id !== DEFAULT_MODEL_ID)!.id;

const GOOD_GPU: GpuReport = {
  available: true,
  adapter: "nvidia - ampere",
  speed: "fast",
  shaderF16: true,
  maxStorageBufferBindingBytes: 2 ** 31,
  maxBufferBytes: 2 ** 31,
  reason: "",
};

const NO_GPU: GpuReport = {
  available: false,
  adapter: "",
  speed: "unknown",
  shaderF16: false,
  maxStorageBufferBindingBytes: 0,
  maxBufferBytes: 0,
  reason: "This browser does not support WebGPU.",
};

const MANIFEST_TOTAL = 1_000_000 + 2_000;

const HOSTED: HostingReport = {
  hosted: true,
  reason: "",
  manifest: {
    modelId: DEFAULT_MODEL_ID,
    weightsBytes: 1_000_000,
    libBytes: 2_000,
    files: [],
    mirroredFrom: "mirror",
    mirroredAt: "2026-09-02T00:00:00.000Z",
  },
};

const NOT_HOSTED: HostingReport = {
  hosted: false,
  reason: "This deployment does not host it. Run fetch-models.mjs.",
  manifest: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAdapter implements LocalRuntimeAdapter {
  gpu: GpuReport = GOOD_GPU;
  hosting: HostingReport = HOSTED;
  cachedIds = new Set<LocalModelId>();
  bytes: number | null = 0;
  /** Hold `load()` open so a cancel can be observed mid-flight. */
  gate: { promise: Promise<void>; reject: (e: unknown) => void } | null = null;
  loadError: unknown = null;
  lastLoad: LoadOptions | null = null;

  detectGpu = vi.fn(async () => this.gpu);
  probeHosted = vi.fn(async (_id: LocalModelId) => this.hosting);
  isCached = vi.fn(async (id: LocalModelId) => this.cachedIds.has(id));
  deleteWeights = vi.fn(async (id: LocalModelId) => {
    this.cachedIds.delete(id);
    this.bytes = 0;
  });
  cacheBytes = vi.fn(async () => this.bytes);

  engineUnload = vi.fn(async () => {});
  chat = vi.fn(async () => ({
    text: "hello",
    finishReason: "stop" as const,
    elapsedMs: 1,
  }));

  load = vi.fn(async (options: LoadOptions): Promise<LoadedEngine> => {
    this.lastLoad = options;
    options.onProgress?.({
      progress: 0.5,
      text: "Fetching param cache[1/2]",
      timeElapsed: 1,
      fetching: true,
    });
    if (this.gate) {
      const gate = this.gate;
      options.signal?.addEventListener("abort", () =>
        gate.reject(new LoadAbortedError())
      );
      await gate.promise;
    }
    if (this.loadError) throw this.loadError;
    this.cachedIds.add(options.modelId);
    this.bytes = MANIFEST_TOTAL;
    return {
      modelId: options.modelId,
      chat: this.chat,
      interrupt: async () => {},
      unload: this.engineUnload,
    };
  });
}

function makeStore(configure?: (a: FakeAdapter) => void) {
  const adapter = new FakeAdapter();
  configure?.(adapter);
  return { adapter, store: new LocalModelStore(adapter) };
}

/** Let the floating `void refreshCacheOnly()` calls settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial state", () => {
  it("claims nothing until the hardware has been probed", () => {
    const { store } = makeStore();
    const s = store.getState();
    expect(s.hardware).toBeNull();
    expect(s.activeModelId).toBeNull();
    expect(s.progress).toBeNull();
    expect(s.blocker).toBe("none");
    expect(s.error).toBeNull();
    expect(s.unavailableReason).toBeNull();
    expect(s.selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.cache).toEqual({ bytesOnDisk: null, cachedModelIds: [] });
    expect(s.generating).toBe(false);
  });

  it("hands out a stable snapshot until something changes", () => {
    const { store } = makeStore();
    expect(store.getState()).toBe(store.getState());
  });

  it("exposes the catalog so a component needs one import", () => {
    const { store } = makeStore();
    expect(store.catalog).toBe(LOCAL_MODELS);
  });
});

describe("refresh", () => {
  it("stops at unavailable without touching the network when WebGPU is absent", async () => {
    const { adapter, store } = makeStore((a) => {
      a.gpu = NO_GPU;
    });
    await store.refresh();
    const s = store.getState();
    expect(s.status).toBe("unavailable");
    expect(s.blocker).toBe("no-webgpu");
    expect(s.unavailableReason).toBe(NO_GPU.reason);
    expect(adapter.probeHosted).not.toHaveBeenCalled();
    expect(adapter.isCached).not.toHaveBeenCalled();
  });

  it("lands on not-downloaded when the mirror is hosted", async () => {
    const { store } = makeStore();
    await store.refresh();
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.blocker).toBe("none");
    expect(s.hardware?.available).toBe(true);
    expect(s.cache.cachedModelIds).toEqual([]);
  });

  it("lands on ready, and skips the mirror probe, when the weights are cached", async () => {
    const { adapter, store } = makeStore((a) => {
      a.cachedIds.add(DEFAULT_MODEL_ID);
      a.bytes = MANIFEST_TOTAL;
    });
    await store.refresh();
    // This is the offline case: a cached browser must not need the network.
    expect(adapter.probeHosted).not.toHaveBeenCalled();
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.cache.cachedModelIds).toEqual([DEFAULT_MODEL_ID]);
    expect(s.cache.bytesOnDisk).toBe(MANIFEST_TOTAL);
  });

  it("blames the deployment, not the machine, when the mirror is missing", async () => {
    const { store } = makeStore((a) => {
      a.hosting = NOT_HOSTED;
    });
    await store.refresh();
    const s = store.getState();
    expect(s.status).toBe("unavailable");
    expect(s.blocker).toBe("no-weights-hosted");
    expect(s.unavailableReason).toMatch(/does not host/);
    // The GPU is fine — the UI must be able to say so.
    expect(s.hardware?.available).toBe(true);
  });

  it("reports the DEFAULT_MODEL_ID reason, not the fallback candidate's, when neither is hosted", async () => {
    const { adapter, store } = makeStore();
    const defaultNotHosted: HostingReport = {
      hosted: false,
      reason: `does not host ${DEFAULT_MODEL_ID}`,
      manifest: null,
    };
    const deployNotHosted: HostingReport = {
      hosted: false,
      reason: `does not host ${DEPLOY_DEFAULT_MODEL_ID}`,
      manifest: null,
    };
    adapter.probeHosted = vi.fn(async (id: LocalModelId) =>
      id === DEPLOY_DEFAULT_MODEL_ID ? deployNotHosted : defaultNotHosted
    );
    await store.refresh();
    const s = store.getState();
    // selectedModelId stays DEFAULT_MODEL_ID (the fallback never took), so
    // the reason shown must match — not silently swap to the model that was
    // only scouted, never selected.
    expect(s.selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.unavailableReason).toBe(defaultNotHosted.reason);
  });

  it("falls back to the deploy-default model when the UI default isn't hosted, and persists it", async () => {
    const { adapter, store } = makeStore();
    adapter.probeHosted = vi.fn(async (id: LocalModelId) =>
      id === DEPLOY_DEFAULT_MODEL_ID ? HOSTED : NOT_HOSTED
    );
    await store.refresh();
    const s = store.getState();
    // A size-constrained deploy only mirrors the small model — the store
    // must land there instead of reporting "unavailable" over a model
    // nobody asked for and this origin never claimed to host.
    expect(s.selectedModelId).toBe(DEPLOY_DEFAULT_MODEL_ID);
    expect(s.status).toBe("not-downloaded");
    expect(s.blocker).toBe("none");
    expect(localStorage.getItem("airlock.localModel.v1")).toBe(
      DEPLOY_DEFAULT_MODEL_ID
    );
  });

  it("does NOT fall back once the user has explicitly chosen a model", async () => {
    localStorage.setItem("airlock.localModel.v1", DEFAULT_MODEL_ID);
    const { adapter, store } = makeStore();
    adapter.probeHosted = vi.fn(async (id: LocalModelId) =>
      id === DEPLOY_DEFAULT_MODEL_ID ? HOSTED : NOT_HOSTED
    );
    await store.refresh();
    const s = store.getState();
    // The user asked for this model by name (even if it happens to equal the
    // default) — respect the choice and report honestly, don't silently swap.
    expect(s.selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.status).toBe("unavailable");
    expect(s.blocker).toBe("no-weights-hosted");
  });

  it("shares one probe between concurrent callers", async () => {
    const { adapter, store } = makeStore();
    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(adapter.detectGpu).toHaveBeenCalledTimes(1);
  });

  it("a selectModel() during an in-flight probe is not reverted, and the new selection still gets probed", async () => {
    const gate = deferred<HostingReport>();
    const { store } = makeStore((a) => {
      // DEFAULT_MODEL_ID's probe hangs on the gate; OTHER_ID resolves
      // immediately as genuinely unhosted — so a stale optimistic
      // "not-downloaded" left over from selectModel()'s own synchronous
      // guess is distinguishable from a real, completed probe.
      a.probeHosted = vi.fn(async (id: LocalModelId) =>
        id === DEFAULT_MODEL_ID ? gate.promise : NOT_HOSTED
      );
    });
    const run = store.refresh(); // starts probing DEFAULT_MODEL_ID, hangs on the gate
    await Promise.resolve();

    store.selectModel(OTHER_ID); // lands while the DEFAULT_MODEL_ID probe is still open
    expect(store.getState().selectedModelId).toBe(OTHER_ID);
    expect(store.getState().status).toBe("not-downloaded"); // selectModel's optimistic guess

    gate.resolve(HOSTED); // the stale DEFAULT_MODEL_ID probe finally resolves
    await run;
    await store.refresh(); // waits out the chained follow-up probe for OTHER_ID

    const s = store.getState();
    // The user's later choice must win — not get silently reverted back to
    // whatever the abandoned probe was investigating — AND must actually get
    // probed itself, not left stuck on the optimistic guess.
    expect(s.selectedModelId).toBe(OTHER_ID);
    expect(s.status).toBe("unavailable");
    expect(s.blocker).toBe("no-weights-hosted");
  });

  it("notifies subscribers and replaces the snapshot", async () => {
    const { store } = makeStore();
    const before = store.getState();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    await store.refresh();
    expect(seen).toHaveBeenCalled();
    expect(store.getState()).not.toBe(before);
    off();
    const calls = seen.mock.calls.length;
    await store.refreshCacheOnly();
    expect(seen.mock.calls.length).toBe(calls);
  });

  it("does not disturb a download already in flight", async () => {
    const gate = deferred<void>();
    const { store } = makeStore((a) => {
      a.gate = { promise: gate.promise, reject: gate.reject };
    });
    await store.refresh();
    const run = store.download();
    await Promise.resolve();
    expect(store.getState().status).toBe("downloading");
    await store.refresh();
    expect(store.getState().status).toBe("downloading");
    store.cancelDownload();
    await run;
  });
});

describe("download", () => {
  it("walks not-downloaded → downloading → running and reports progress", async () => {
    const { store } = makeStore();
    await store.refresh();
    const seen: LocalModelStatus[] = [];
    store.subscribe(() => seen.push(store.getState().status));

    const run = store.download();
    expect(store.getState().status).toBe("downloading");
    await run;

    expect(seen).toContain("downloading");
    const s = store.getState();
    expect(s.status).toBe("running");
    expect(s.activeModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.progress).toBeNull();
    expect(s.error).toBeNull();
    expect(store.getEngine()).not.toBeNull();
  });

  it("derives loaded bytes from the runtime fraction and the mirror total", async () => {
    const { store } = makeStore();
    await store.refresh();
    const seen: (number | null)[] = [];
    store.subscribe(() => seen.push(store.getState().progress?.loadedBytes ?? null));
    await store.download();
    // The fake reports fraction 0.5 once; the mirror manifest said 1_002_000.
    expect(seen).toContain(Math.round(0.5 * MANIFEST_TOTAL));
  });

  it("mirrors the fetching flag so the UI can say download vs. warm-up", async () => {
    const { store } = makeStore();
    await store.refresh();
    const flags: (boolean | null)[] = [];
    store.subscribe(() => flags.push(store.getState().progress?.fetching ?? null));
    await store.download();
    expect(flags).toContain(true);
  });

  it("probes the hardware itself if called before refresh", async () => {
    const { store } = makeStore();
    await store.download();
    expect(store.getState().status).toBe("running");
  });

  it("goes to error, not silence, when local mode is unavailable", async () => {
    const { adapter, store } = makeStore((a) => {
      a.gpu = NO_GPU;
    });
    await store.refresh();
    await store.download();
    expect(adapter.load).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe(NO_GPU.reason);
  });

  it("surfaces a load failure as the error state", async () => {
    const { store } = makeStore((a) => {
      a.loadError = new Error("GPU out of memory");
    });
    await store.refresh();
    await store.download();
    const s = store.getState();
    expect(s.status).toBe("error");
    expect(s.error).toBe("GPU out of memory");
    expect(s.activeModelId).toBeNull();
    expect(store.getEngine()).toBeNull();
  });

  it("is a no-op once the model is running", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    await store.download();
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });
});

describe("cancel and resume", () => {
  it("cancels into paused, keeping what already landed", async () => {
    const gate = deferred<void>();
    const { adapter, store } = makeStore((a) => {
      a.gate = { promise: gate.promise, reject: gate.reject };
    });
    await store.refresh();
    const run = store.download();
    await Promise.resolve();
    expect(store.getState().status).toBe("downloading");
    store.cancelDownload();
    await run;
    const s = store.getState();
    expect(s.status).toBe("paused");
    expect(s.error).toBeNull();
    expect(s.partialBytes).toBe(Math.round(0.5 * MANIFEST_TOTAL));
    expect(adapter.lastLoad?.signal?.aborted).toBe(true);
  });

  it("resumes from paused straight back into a download", async () => {
    const gate = deferred<void>();
    const { adapter, store } = makeStore((a) => {
      a.gate = { promise: gate.promise, reject: gate.reject };
    });
    await store.refresh();
    const first = store.download();
    await Promise.resolve();
    store.cancelDownload();
    await first;
    expect(store.getState().status).toBe("paused");

    adapter.gate = null;
    await store.download();
    expect(store.getState().status).toBe("running");
    expect(store.getState().partialBytes).toBe(0);
  });

  it("ignores a late progress callback from a cancelled load", async () => {
    const gate = deferred<void>();
    const { adapter, store } = makeStore((a) => {
      a.gate = { promise: gate.promise, reject: gate.reject };
    });
    await store.refresh();
    const run = store.download();
    await Promise.resolve();
    store.cancelDownload();
    await run;
    adapter.lastLoad?.onProgress?.({
      progress: 0.9,
      text: "late",
      timeElapsed: 9,
      fetching: true,
    });
    expect(store.getState().progress).toBeNull();
  });

  it("does nothing when there is no download to cancel", async () => {
    const { store } = makeStore();
    await store.refresh();
    store.cancelDownload();
    expect(store.getState().status).toBe("not-downloaded");
  });
});

describe("load / unload", () => {
  it("brings cached weights onto the GPU: ready → running", async () => {
    const { store } = makeStore((a) => {
      a.cachedIds.add(DEFAULT_MODEL_ID);
    });
    await store.refresh();
    expect(store.getState().status).toBe("ready");
    await store.load();
    expect(store.getState().status).toBe("running");
    expect(store.getState().activeModelId).toBe(DEFAULT_MODEL_ID);
  });

  it("refuses to load from a state that has no weights", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.load();
    expect(adapter.load).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("not-downloaded");
  });

  it("frees the GPU but keeps the weights: running → ready", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    await store.unload();
    expect(adapter.engineUnload).toHaveBeenCalled();
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.activeModelId).toBeNull();
    expect(store.getEngine()).toBeNull();
  });
});

describe("deleteWeights", () => {
  it("reports the bytes actually reclaimed, measured not assumed", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    await settle();
    const reclaimed = await store.deleteWeights(DEFAULT_MODEL_ID);
    expect(adapter.deleteWeights).toHaveBeenCalledWith(DEFAULT_MODEL_ID);
    expect(reclaimed).toBe(MANIFEST_TOTAL);
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.cache.cachedModelIds).not.toContain(DEFAULT_MODEL_ID);
    expect(s.cache.bytesOnDisk).toBe(0);
  });

  it("unloads a model that is on the GPU before deleting it", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    await store.deleteWeights(DEFAULT_MODEL_ID);
    expect(adapter.engineUnload).toHaveBeenCalled();
    expect(store.getState().activeModelId).toBeNull();
  });

  it("reports a delete that fails instead of pretending it worked", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    adapter.deleteWeights.mockRejectedValueOnce(new Error("cache locked"));
    const reclaimed = await store.deleteWeights(DEFAULT_MODEL_ID);
    expect(reclaimed).toBe(0);
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("cache locked");
  });

  it("leaves the current selection alone when another model is deleted", async () => {
    const { store } = makeStore((a) => {
      a.cachedIds.add(DEFAULT_MODEL_ID);
      a.cachedIds.add(OTHER_ID);
    });
    await store.refresh();
    expect(store.getState().status).toBe("ready");
    await store.deleteWeights(OTHER_ID);
    expect(store.getState().status).toBe("ready");
    expect(store.getState().selectedModelId).toBe(DEFAULT_MODEL_ID);
  });
});

describe("clearError", () => {
  it("returns to not-downloaded when nothing was fetched", async () => {
    const { store } = makeStore((a) => {
      a.loadError = new Error("boom");
    });
    await store.refresh();
    await store.download();
    expect(store.getState().status).toBe("error");
    store.clearError();
    expect(store.getState().status).toBe("not-downloaded");
    expect(store.getState().error).toBeNull();
  });

  it("returns to ready when the weights survived the failure", async () => {
    const { adapter, store } = makeStore((a) => {
      a.cachedIds.add(DEFAULT_MODEL_ID);
      a.loadError = new Error("shader compile failed");
    });
    await store.refresh();
    await store.load();
    expect(store.getState().status).toBe("error");
    adapter.loadError = null;
    store.clearError();
    expect(store.getState().status).toBe("ready");
  });
});

describe("selectModel", () => {
  it("switches synchronously and remembers the choice", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    store.selectModel(OTHER_ID);
    expect(store.getState().selectedModelId).toBe(OTHER_ID);
    expect(store.getState().status).toBe("not-downloaded");
    // A new store in the same browser picks the remembered model back up.
    expect(new LocalModelStore(adapter).getState().selectedModelId).toBe(OTHER_ID);
  });

  it("goes straight to ready for a model already on disk", async () => {
    const { store } = makeStore((a) => {
      a.cachedIds.add(OTHER_ID);
    });
    await store.refresh();
    store.selectModel(OTHER_ID);
    expect(store.getState().status).toBe("ready");
  });

  it("an explicit reselect of DEFAULT_MODEL_ID is not overridden by the deploy-default fallback", async () => {
    // Switch away, then explicitly back to DEFAULT_MODEL_ID, on a deploy that
    // only hosts DEPLOY_DEFAULT_MODEL_ID — the fallback that exists for a
    // never-touched default must not also fire for a real user choice.
    const { adapter, store } = makeStore();
    adapter.probeHosted = vi.fn(async (id: LocalModelId) =>
      id === DEPLOY_DEFAULT_MODEL_ID ? HOSTED : NOT_HOSTED
    );
    await store.refresh();
    expect(store.getState().selectedModelId).toBe(DEPLOY_DEFAULT_MODEL_ID); // the fallback fired once

    store.selectModel(DEFAULT_MODEL_ID);
    await store.refresh();

    const s = store.getState();
    expect(s.selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.status).toBe("unavailable");
    expect(s.blocker).toBe("no-weights-hosted");
  });

  it("refuses mid-download rather than corrupting the load", async () => {
    const gate = deferred<void>();
    const { store } = makeStore((a) => {
      a.gate = { promise: gate.promise, reject: gate.reject };
    });
    await store.refresh();
    const run = store.download();
    await Promise.resolve();
    store.selectModel(OTHER_ID);
    expect(store.getState().selectedModelId).toBe(DEFAULT_MODEL_ID);
    store.cancelDownload();
    await run;
  });
});

describe("chat", () => {
  it("refuses when no model is on the GPU", async () => {
    const { store } = makeStore();
    await store.refresh();
    await expect(store.chat({ messages: [] })).rejects.toThrow(/not loaded/);
  });

  it("flips `generating` for the duration and stays `running`", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    await settle();
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getState().generating));
    const result = await store.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello");
    expect(seen).toEqual([true, false]);
    expect(store.getState().status).toBe("running");
    expect(adapter.chat).toHaveBeenCalledTimes(1);
  });

  it("records a generation failure without unloading the model", async () => {
    const { adapter, store } = makeStore();
    await store.refresh();
    await store.download();
    adapter.chat.mockRejectedValueOnce(new Error("shader compile failed"));
    await expect(store.chat({ messages: [] })).rejects.toThrow(/shader compile/);
    expect(store.getState().status).toBe("running");
    expect(store.getState().generating).toBe(false);
    expect(store.getState().error).toBe("shader compile failed");
  });
});

describe("toAgentModeStatus", () => {
  it.each([
    ["unavailable", "unavailable"],
    ["not-downloaded", "not-downloaded"],
    ["downloading", "downloading"],
    ["ready", "ready"],
    ["running", "running"],
    // The two states agentMode.ts does not model collapse onto the honest
    // "capable machine, no model to talk to yet".
    ["paused", "not-downloaded"],
    ["error", "not-downloaded"],
  ] as [LocalModelStatus, string][])("maps %s to %s", (from, to) => {
    expect(toAgentModeStatus(from)).toBe(to);
  });
});
