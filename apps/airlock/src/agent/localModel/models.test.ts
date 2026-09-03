/**
 * Catalog tests. The important ones are not the bookkeeping — they are the two
 * that back the product claim:
 *
 *  - every URL WebLLM is ever handed resolves to this page's own origin;
 *  - `assertSameOrigin` refuses a config that would leave it.
 *
 * The `resolve/main/` assertion looks cosmetic and is not: WebLLM's
 * `cleanModelUrl()` appends that segment to any model URL without it, so if the
 * catalog stopped emitting it, the browser would request a directory the mirror
 * script never wrote.
 */
import { describe, it, expect } from "vitest";
import type { AppConfig } from "@mlc-ai/web-llm";
import {
  assertSameOrigin,
  buildAppConfig,
  buildCustomAppConfig,
  currentOrigin,
  customModelId,
  DEFAULT_MODEL_ID,
  formatModelSize,
  getModel,
  isLocalModelId,
  LOCAL_MODELS,
  MANIFEST_FILE,
  manifestUrl,
  modelDirUrl,
  modelLibUrl,
  parseManifest,
  validateCustomModel,
} from "./models";

const ORIGIN = "https://airlock.example";

/** The exact regex WebLLM 0.2.84 uses to decide whether to append a segment. */
const WEBLLM_RESOLVE_RE = /.+\/resolve\/.+\//;

describe("catalog shape", () => {
  it("has unique ids", () => {
    const ids = LOCAL_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names exactly one default, and DEFAULT_MODEL_ID is it", () => {
    const defaults = LOCAL_MODELS.filter((m) => m.tier === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(DEFAULT_MODEL_ID);
  });

  it("offers a sub-1GB option for weak GPUs", () => {
    const small = LOCAL_MODELS.filter((m) => m.downloadBytes < 1024 ** 3);
    expect(small.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...LOCAL_MODELS.map((m) => m.vramRequiredMB))).toBeLessThan(
      1000
    );
  });

  it("keeps downloadBytes equal to weights + lib for every model", () => {
    for (const m of LOCAL_MODELS) {
      expect(m.downloadBytes).toBe(m.weightsBytes + m.libBytes);
    }
  });

  it("declares that no model supports WebLLM's native tool API", () => {
    // T1-b relies on this: it must use constrained JSON, not `request.tools`.
    for (const m of LOCAL_MODELS) {
      expect(m.supportsNativeToolCalls).toBe(false);
      expect(m.supportsJsonSchema).toBe(true);
    }
  });

  it("resolves and rejects ids", () => {
    expect(getModel(DEFAULT_MODEL_ID).id).toBe(DEFAULT_MODEL_ID);
    expect(() => getModel("nope" as never)).toThrow(/unknown local model/);
    expect(isLocalModelId(DEFAULT_MODEL_ID)).toBe(true);
    expect(isLocalModelId("gpt-4")).toBe(false);
  });
});

describe("same-origin weight URLs", () => {
  it("builds every model and lib URL on the given origin", () => {
    const config = buildAppConfig(ORIGIN);
    expect(config.model_list).toHaveLength(LOCAL_MODELS.length);
    for (const r of config.model_list) {
      expect(new URL(r.model).origin).toBe(ORIGIN);
      expect(new URL(r.model_lib).origin).toBe(ORIGIN);
    }
  });

  it("never mentions a third-party weight host anywhere in the built config", () => {
    const serialized = JSON.stringify(buildAppConfig(ORIGIN));
    expect(serialized).not.toMatch(/huggingface|githubusercontent|hf\.co|cdn/i);
  });

  it("follows the origin it is given, whatever that origin is", () => {
    for (const origin of ["http://127.0.0.1:5173", "https://airlock.netlify.app"]) {
      for (const r of buildAppConfig(origin).model_list) {
        expect(r.model.startsWith(`${origin}/models/`)).toBe(true);
        expect(r.model_lib.startsWith(`${origin}/models/lib/`)).toBe(true);
      }
    }
  });

  it("emits the resolve/main segment WebLLM would otherwise append", () => {
    for (const m of LOCAL_MODELS) {
      const url = modelDirUrl(m.id, ORIGIN);
      expect(url.endsWith("/resolve/main/")).toBe(true);
      expect(WEBLLM_RESOLVE_RE.test(url)).toBe(true);
    }
  });

  it("points the lib URL at the shared /models/lib directory", () => {
    const m = LOCAL_MODELS[0];
    expect(modelLibUrl(m.id, ORIGIN)).toBe(`${ORIGIN}/models/lib/${m.libFile}`);
  });

  it("puts the mirror manifest beside the model, not inside resolve/main", () => {
    expect(manifestUrl(DEFAULT_MODEL_ID, ORIGIN)).toBe(
      `${ORIGIN}/models/${DEFAULT_MODEL_ID}/${MANIFEST_FILE}`
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(modelDirUrl(DEFAULT_MODEL_ID, `${ORIGIN}/`)).toBe(
      modelDirUrl(DEFAULT_MODEL_ID, ORIGIN)
    );
  });

  it("refuses to build URLs when there is no origin at all", () => {
    // Node test environment: `location` is undefined, so this is the real path
    // a non-browser caller would hit.
    expect(currentOrigin()).toBe("");
    expect(() => modelDirUrl(DEFAULT_MODEL_ID)).toThrow(/page origin/);
  });
});

describe("assertSameOrigin", () => {
  const cfg = (model: string, lib: string): AppConfig => ({
    model_list: [{ model, model_id: "test", model_lib: lib }],
  });

  it("passes a config entirely on the expected origin", () => {
    expect(() =>
      assertSameOrigin(
        cfg(`${ORIGIN}/models/x/resolve/main/`, `${ORIGIN}/models/lib/x.wasm`),
        ORIGIN
      )
    ).not.toThrow();
  });

  it("rejects weights on HuggingFace", () => {
    expect(() =>
      assertSameOrigin(
        cfg(
          "https://huggingface.co/mlc-ai/x/resolve/main/",
          `${ORIGIN}/models/lib/x.wasm`
        ),
        ORIGIN
      )
    ).toThrow(/huggingface\.co, not https:\/\/airlock\.example/);
  });

  it("rejects a kernel library on a CDN even when the weights are local", () => {
    expect(() =>
      assertSameOrigin(
        cfg(
          `${ORIGIN}/models/x/resolve/main/`,
          "https://raw.githubusercontent.com/mlc-ai/libs/x.wasm"
        ),
        ORIGIN
      )
    ).toThrow(/Weights must be served same-origin/);
  });

  it("rejects a relative URL rather than guessing an origin for it", () => {
    expect(() =>
      assertSameOrigin(cfg("/models/x/resolve/main/", "/models/lib/x.wasm"), ORIGIN)
    ).toThrow(/unparseable URL/);
  });

  it("rejects a different port on the same host", () => {
    expect(() =>
      assertSameOrigin(
        cfg("https://airlock.example:8443/models/x/", `${ORIGIN}/models/lib/x.wasm`),
        ORIGIN
      )
    ).toThrow(/not https:\/\/airlock\.example/);
  });
});

describe("mirror manifest parsing", () => {
  const good = {
    modelId: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    weightsBytes: 100,
    libBytes: 10,
    files: [{ path: "resolve/main/a.bin", bytes: 100, sha256: "ab" }],
    mirroredFrom: "somewhere",
    mirroredAt: "2026-09-02T00:00:00.000Z",
  };

  it("accepts what the mirror script writes", () => {
    expect(parseManifest(good)).toEqual(good);
  });

  it("fills in optional fields it can live without", () => {
    const m = parseManifest({ modelId: "x", weightsBytes: 1, libBytes: 2 });
    expect(m).toEqual({
      modelId: "x",
      weightsBytes: 1,
      libBytes: 2,
      files: [],
      mirroredFrom: "",
      mirroredAt: "",
    });
  });

  it.each([
    ["null", null],
    ["a string", "not json"],
    ["an array", []],
    ["a manifest without sizes", { modelId: "x" }],
    ["a manifest with a string size", { modelId: "x", weightsBytes: "1", libBytes: 2 }],
    ["an index.html body parsed as a number", 404],
  ])("rejects %s", (_label, value) => {
    expect(parseManifest(value)).toBeNull();
  });
});

describe("formatModelSize", () => {
  it.each([
    [1_748_825_496, "1.63 GB"],
    [880_931_543, "840 MB"],
    [5_438_957, "5 MB"],
    [4096, "4 KB"],
    [512, "512 B"],
    [0, "0 B"],
  ])("formats %i as %s", (n, expected) => {
    expect(formatModelSize(n)).toBe(expected);
  });

  it("degrades to an em dash rather than NaN for an unmeasurable cache", () => {
    // `cache.bytesOnDisk` is nullable; the panel pipes it straight in here.
    expect(formatModelSize(Number.NaN)).toBe("—");
    expect(formatModelSize(-1)).toBe("—");
  });
});

describe("custom models", () => {
  const GOOD = {
    label: "My 7B",
    modelUrl: "https://hf.example/org/model/resolve/main",
    libUrl: "https://hf.example/org/model/model-webgpu.wasm",
  };

  it("validates input with UI-safe errors", () => {
    expect(() => validateCustomModel({ ...GOOD, label: "" })).toThrow(/1–40/);
    expect(() =>
      validateCustomModel({ ...GOOD, modelUrl: "http://a/b/" })
    ).toThrow(/https/);
    expect(() =>
      validateCustomModel({ ...GOOD, libUrl: "https://a/b.bin" })
    ).toThrow(/wasm/);
    const e = validateCustomModel(GOOD);
    expect(e.modelUrl.endsWith("/")).toBe(true);
    expect(customModelId(e.label)).toBe("custom/My 7B");
  });

  it("builds an https-only external config that assertSameOrigin refuses", () => {
    const config = buildCustomAppConfig(validateCustomModel(GOOD));
    expect(config.model_list).toHaveLength(1);
    expect(config.model_list[0].model_id).toBe("custom/My 7B");
    // Documents the bargain: custom configs are external by design, so the
    // same-origin gate that guards every catalog config rejects them — the
    // honesty lives in the consent copy + the egress count, not the gate.
    expect(() => assertSameOrigin(config, ORIGIN)).toThrow();
  });
});
