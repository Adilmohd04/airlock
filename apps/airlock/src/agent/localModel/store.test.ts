/**
 * `LocalModelStore` state-machine tests, driven through a fake
 * `LocalRuntimeAdapter` — no GPU, no network, no WebLLM import.
 *
 * The walk the acceptance criterion names is asserted end to end:
 *   unavailable -> not-downloaded -> downloading -> ready
 * plus the branches that decide whether the product is honest: a machine with
 * no WebGPU never reaches for the network, and a browser that already holds the
 * weights never depends on the network either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalModelStore } from "./store";
import { DEFAULT_MODEL_ID, getModel, LOCAL_MODELS } from "./models";
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
  cached = false;
  bytes: number | null = 0;
  /** Set to hold `load()` open so a cancel can be observed mid-flight. */
  gate: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } | null =
    null;
  loadError: unknown = null;
  lastLoad: LoadOptions | null = null;

  detectGpu = vi.fn(async () => this.gpu);
  probeHosted = vi.fn(async () => this.hosting);
  isCached = vi.fn(async () => this.cached);
  deleteWeights = vi.fn(async () => {
    this.cached = false;
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
      options.signal?.addEventListener("abort", () =>
        this.gate?.reject(new LoadAbortedError())
      );
      await this.gate.promise;
    }
    if (this.loadError) throw this.loadError;
    this.cached = true;
    this.bytes = 1_002_000;
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

/** Let the floating `void refreshCacheSize()` calls settle. */
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
  it("starts unavailable and un-probed", () => {
    const { store } = makeStore();
    const s = store.getState();
    expect(s.status).toBe("unavailable");
    expect(s.initialized).toBe(false);
    expect(s.gpu).toBeNull();
    expect(s.activeModel).toBeNull();
    expect(s.selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(s.selected.id).toBe(DEFAULT_MODEL_ID);
    expect(s.downloadBytes).toBe(getModel(DEFAULT_MODEL_ID).downloadBytes);
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

describe("init", () => {
  it("stops at unavailable without touching the network when WebGPU is absent", async () => {
    const { adapter, store } = makeStore((a) => {
      a.gpu = NO_GPU;
    });
    await store.init();
    const s = store.getState();
    expect(s.status).toBe("unavailable");
    expect(s.initialized).toBe(true);
    expect(s.unavailableReason).toBe(NO_GPU.reason);
    expect(adapter.probeHosted).not.toHaveBeenCalled();
    expect(adapter.isCached).not.toHaveBeenCalled();
  });

  it("walks to not-downloaded when the mirror is hosted", async () => {
    const { store } = makeStore();
    await store.init();
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.weightsCached).toBe(false);
    expect(s.weightsHosted).toBe(true);
    // The manifest is more accurate than the catalog estimate; prefer it.
    expect(s.downloadBytes).toBe(1_002_000);
  });

  it("skips the mirror probe entirely when the weights are already cached", async () => {
    const { adapter, store } = makeStore((a) => {
      a.cached = true;
    });
    await store.init();
    // This is the offline case: a cached browser must not need the network.
    expect(adapter.probeHosted).not.toHaveBeenCalled();
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.weightsCached).toBe(true);
    expect(s.downloadBytes).toBe(0);
  });

  it("goes unavailable, with the operator's fix, when the mirror is missing", async () => {
    const { store } = makeStore((a) => {
      a.hosting = NOT_HOSTED;
    });
    await store.init();
    const s = store.getState();
    expect(s.status).toBe("unavailable");
    expect(s.weightsHosted).toBe(false);
    expect(s.unavailableReason).toMatch(/does not host/);
    // The GPU is fine — the UI should be able to say so.
    expect(s.gpu?.available).toBe(true);
  });

  it("shares one probe between concurrent callers", async () => {
    const { adapter, store } = makeStore();
    await Promise.all([store.init(), store.init(), store.init()]);
    expect(adapter.detectGpu).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers and replaces the snapshot", async () => {
    const { store } = makeStore();
    const before = store.getState();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    await store.init();
    expect(seen).toHaveBeenCalled();
    expect(store.getState()).not.toBe(before);
    off();
    const calls = seen.mock.calls.length;
    await store.refreshCacheSize();
    expect(seen.mock.calls.length).toBe(calls);
  });
});

describe("download", () => {
  it("completes the walk to ready and reports progress on the way", async () => {
    const { store } = makeStore();
    await store.init();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().status));

    const run = store.download();
    expect(store.getState().status).toBe("downloading");
    await run;

    expect(seen).toContain("downloading");
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.activeModel).toBe(DEFAULT_MODEL_ID);
    expect(s.progress).toBe(1);
    expect(s.weightsCached).toBe(true);
    expect(s.downloadBytes).toBe(0);
    expect(s.error).toBeNull();
    expect(store.getEngine()).not.toBeNull();
  });

  it("mirrors WebLLM's fetching flag so the UI can say download vs. warm-up", async () => {
    const { store } = makeStore();
    await store.init();
    const flags: boolean[] = [];
    store.subscribe(() => flags.push(store.getState().fetching));
    await store.download();
    expect(flags).toContain(true);
    expect(store.getState().fetching).toBe(false);
  });

  it("initializes itself if called before init", async () => {
    const { store } = makeStore();
    await store.download();
    expect(store.getState().status).toBe("ready");
  });

  it("refuses and explains when local mode is unavailable", async () => {
    const { adapter, store } = makeStore((a) => {
      a.gpu = NO_GPU;
    });
    await store.init();
    await store.download();
    expect(adapter.load).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("unavailable");
    expect(store.getState().error).toBe(NO_GPU.reason);
  });

  it("falls back to not-downloaded and surfaces the failure", async () => {
    const { adapter, store } = makeStore((a) => {
      a.loadError = new Error("GPU out of memory");
    });
    await store.init();
    await store.download();
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.error).toBe("GPU out of memory");
    expect(s.activeModel).toBeNull();
    expect(store.getEngine()).toBeNull();
    expect(adapter.isCached).toHaveBeenCalledTimes(2); // re-probed after failure
  });

  it("treats a cancel as a choice, not an error", async () => {
    const gate = deferred<void>();
    const { adapter, store } = makeStore((a) => {
      a.gate = { promise: gate.promise, resolve: gate.resolve, reject: gate.reject };
    });
    await store.init();
    const run = store.download();
    await Promise.resolve();
    expect(store.getState().status).toBe("downloading");
    expect(store.getState().cancellable).toBe(true);
    store.cancel();
    await run;
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.error).toBeNull();
    expect(s.cancellable).toBe(false);
    expect(adapter.lastLoad?.signal?.aborted).toBe(true);
  });

  it("is a no-op once ready", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    await store.download();
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });

  it("ignores a late progress callback from a cancelled load", async () => {
    const gate = deferred<void>();
    const { adapter, store } = makeStore((a) => {
      a.gate = { promise: gate.promise, resolve: gate.resolve, reject: gate.reject };
    });
    await store.init();
    const run = store.download();
    await Promise.resolve();
    store.cancel();
    await run;
    adapter.lastLoad?.onProgress?.({
      progress: 0.9,
      text: "late",
      timeElapsed: 9,
      fetching: true,
    });
    expect(store.getState().progressText).toBe("");
    expect(store.getState().progress).toBe(0);
  });
});

describe("unload / deleteWeights", () => {
  it("frees the GPU but keeps the weights on disk", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    await store.unload();
    expect(adapter.engineUnload).toHaveBeenCalled();
    const s = store.getState();
    expect(s.status).toBe("not-downloaded");
    expect(s.activeModel).toBeNull();
    expect(s.weightsCached).toBe(true);
    expect(store.getEngine()).toBeNull();
  });

  it("deletes the weights and re-measures what is left", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    await store.deleteWeights();
    await settle();
    expect(adapter.deleteWeights).toHaveBeenCalledWith(DEFAULT_MODEL_ID);
    expect(store.getState().weightsCached).toBe(false);
    expect(store.getState().cachedBytes).toBe(0);
  });

  it("reports a delete that fails instead of pretending it worked", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    adapter.deleteWeights.mockRejectedValueOnce(new Error("cache locked"));
    await store.deleteWeights();
    expect(store.getState().error).toBe("cache locked");
  });
});

describe("select", () => {
  it("switches model, re-probes, and remembers the choice", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    adapter.hosting = { ...HOSTED, manifest: null };
    await store.select(OTHER_ID);
    expect(store.getState().selectedModelId).toBe(OTHER_ID);
    expect(store.getState().selected.id).toBe(OTHER_ID);
    expect(store.getState().downloadBytes).toBe(getModel(OTHER_ID).downloadBytes);

    // A new store in the same browser picks the remembered model back up.
    expect(new LocalModelStore(adapter).getState().selectedModelId).toBe(OTHER_ID);
  });

  it("unloads the current model before switching", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    await store.select(OTHER_ID);
    expect(adapter.engineUnload).toHaveBeenCalled();
    expect(store.getState().activeModel).toBeNull();
  });

  it("refuses mid-download rather than corrupting the load", async () => {
    const gate = deferred<void>();
    const { store } = makeStore((a) => {
      a.gate = { promise: gate.promise, resolve: gate.resolve, reject: gate.reject };
    });
    await store.init();
    const run = store.download();
    await Promise.resolve();
    await store.select(OTHER_ID);
    expect(store.getState().selectedModelId).toBe(DEFAULT_MODEL_ID);
    expect(store.getState().error).toMatch(/Finish or cancel/);
    store.cancel();
    await run;
  });
});

describe("chat", () => {
  it("refuses when no model is loaded", async () => {
    const { store } = makeStore();
    await store.init();
    await expect(store.chat({ messages: [] })).rejects.toThrow(/not loaded/);
  });

  it("flips to running for the duration and back to ready", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    await settle(); // let download's trailing cache measurement land first
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().status));
    const result = await store.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello");
    expect(seen).toEqual(["running", "ready"]);
    expect(adapter.chat).toHaveBeenCalledTimes(1);
  });

  it("records the failure and still returns to ready", async () => {
    const { adapter, store } = makeStore();
    await store.init();
    await store.download();
    adapter.chat.mockRejectedValueOnce(new Error("shader compile failed"));
    await expect(store.chat({ messages: [] })).rejects.toThrow(/shader compile/);
    expect(store.getState().status).toBe("ready");
    expect(store.getState().error).toBe("shader compile failed");
  });
});
