/**
 * Capability detection and the same-origin mirror probe.
 *
 * Both are the "fail cleanly" half of the feature: a machine without WebGPU and
 * a deployment without mirrored weights must each produce a sentence a human
 * can act on, **with no thrown exception and nothing on the console** — that is
 * a literal Tier-1 acceptance criterion, so it is asserted, not assumed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { detectWebGpu, probeHostedWeights } from "./runtime";
import { DEFAULT_MODEL_ID } from "./models";

const MiB = 1024 * 1024;

interface FakeAdapterOptions {
  features?: string[];
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
  info?: Record<string, string>;
}

function fakeGpu(adapter: FakeAdapterOptions | null) {
  return {
    requestAdapter: vi.fn(async () =>
      adapter === null
        ? null
        : {
            features: {
              has: (n: string) => (adapter.features ?? ["shader-f16"]).includes(n),
            },
            limits: {
              maxStorageBufferBindingSize:
                adapter.maxStorageBufferBindingSize ?? 2048 * MiB,
              maxBufferSize: adapter.maxBufferSize ?? 2048 * MiB,
            },
            info: adapter.info ?? { vendor: "nvidia", architecture: "ampere" },
          }
    ),
  };
}

let errorSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectSilentConsole() {
  expect(errorSpy).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
}

describe("detectWebGpu — unavailable paths", () => {
  it("reports a plain-language reason when the browser has no WebGPU", async () => {
    vi.stubGlobal("navigator", {});
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/does not support WebGPU/);
    expect(r.reason).toMatch(/Chrome\/Edge 113\+/);
    expectSilentConsole();
  });

  it("reports when WebGPU exists but no adapter is granted", async () => {
    vi.stubGlobal("navigator", { gpu: fakeGpu(null) });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no GPU adapter was granted/);
    expect(r.adapter).toBe("");
    expectSilentConsole();
  });

  it("reports missing shader-f16 and still names the adapter", async () => {
    vi.stubGlobal("navigator", { gpu: fakeGpu({ features: [] }) });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.shaderF16).toBe(false);
    expect(r.reason).toMatch(/16-bit shaders/);
    expect(r.adapter).toBe("nvidia - ampere");
    expectSilentConsole();
  });

  it("turns a throwing probe into a report, never an exception", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => {
          throw new Error("driver exploded");
        },
      },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/WebGPU probe failed: driver exploded/);
    expectSilentConsole();
  });

  it("survives having no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    const r = await detectWebGpu();
    expect(r.available).toBe(false);
    expectSilentConsole();
  });
});

describe("detectWebGpu — available paths", () => {
  it("accepts a discrete GPU and calls it fast", async () => {
    vi.stubGlobal("navigator", { gpu: fakeGpu({}) });
    const r = await detectWebGpu();
    expect(r.available).toBe(true);
    expect(r.shaderF16).toBe(true);
    expect(r.speed).toBe("fast");
    expect(r.adapter).toBe("nvidia - ampere");
    expect(r.reason).toBe("");
  });

  it.each([
    [2048 * MiB, "fast"],
    [1024 * MiB, "fast"],
    [512 * MiB, "usable"],
    [256 * MiB, "usable"],
    [128 * MiB, "slow"],
    [0, "unknown"],
  ])("ranks a %i-byte binding limit as %s", async (limit, speed) => {
    vi.stubGlobal("navigator", {
      gpu: fakeGpu({ maxStorageBufferBindingSize: limit }),
    });
    expect((await detectWebGpu()).speed).toBe(speed);
  });

  it("calls a software rasterizer slow no matter how generous its limits are", async () => {
    vi.stubGlobal("navigator", {
      gpu: fakeGpu({
        maxStorageBufferBindingSize: 4096 * MiB,
        info: { vendor: "google", architecture: "swiftshader" },
      }),
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(true);
    expect(r.speed).toBe("slow");
  });

  it("falls back to requestAdapterInfo when `info` is absent", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          features: { has: () => true },
          limits: { maxStorageBufferBindingSize: 2048 * MiB, maxBufferSize: 0 },
          requestAdapterInfo: async () => ({ vendor: "apple", architecture: "m3" }),
        }),
      },
    });
    expect((await detectWebGpu()).adapter).toBe("apple - m3");
  });

  it("does not leak a browser that withholds adapter details", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          features: { has: () => true },
          limits: { maxStorageBufferBindingSize: 2048 * MiB, maxBufferSize: 0 },
        }),
      },
    });
    const r = await detectWebGpu();
    expect(r.available).toBe(true);
    expect(r.adapter).toMatch(/details withheld/);
  });
});

describe("probeHostedWeights", () => {
  const ORIGIN = "https://airlock.test";
  const manifest = {
    modelId: DEFAULT_MODEL_ID,
    weightsBytes: 1_743_386_559,
    libBytes: 5_438_957,
    files: [],
    mirroredFrom: "upstream",
    mirroredAt: "2026-09-02T00:00:00.000Z",
  };

  function stubFetch(impl: (url: string) => Response | Promise<Response>) {
    const spy = vi.fn(async (url: string) => impl(url));
    vi.stubGlobal("location", { origin: ORIGIN, href: `${ORIGIN}/` });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  const res = (body: string, status = 200) =>
    new Response(body, { status }) as Response;

  it("asks this origin, and only this origin", async () => {
    const spy = stubFetch(() => res(JSON.stringify(manifest)));
    await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0][0] as string;
    expect(new URL(url).origin).toBe(ORIGIN);
    expect(url).toBe(
      `${ORIGIN}/models/${DEFAULT_MODEL_ID}/airlock-manifest.json`
    );
  });

  it("reports hosted with the exact mirrored sizes", async () => {
    stubFetch(() => res(JSON.stringify(manifest)));
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(true);
    expect(r.reason).toBe("");
    expect(r.manifest?.weightsBytes).toBe(manifest.weightsBytes);
  });

  it("tells the operator how to fix a 404", async () => {
    stubFetch(() => res("not found", 404));
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(false);
    expect(r.reason).toMatch(/does not host/);
    expect(r.reason).toMatch(/fetch-models\.mjs/);
  });

  it("names the SPA catch-all when /models/ answers with HTML", async () => {
    stubFetch(() => res("<!doctype html><html><body>app shell</body></html>"));
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(false);
    expect(r.reason).toMatch(/SPA catch-all/);
  });

  it("rejects a manifest that parses but is not one", async () => {
    stubFetch(() => res(JSON.stringify({ hello: "world" })));
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(false);
    expect(r.reason).toMatch(/malformed/);
  });

  it("surfaces a non-404 server error with its status", async () => {
    stubFetch(() => res("boom", 503));
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(false);
    expect(r.reason).toMatch(/answered 503/);
  });

  it("turns an offline browser into a reason, not a rejection", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const r = await probeHostedWeights(DEFAULT_MODEL_ID);
    expect(r.hosted).toBe(false);
    expect(r.reason).toMatch(/Could not reach the weight mirror/);
    expectSilentConsole();
  });
});
