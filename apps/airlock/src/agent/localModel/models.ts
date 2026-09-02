/**
 * Curated local-model catalog.
 *
 * ── The one thing to check when reviewing this file ────────────────────────
 * There is **no third-party URL in it.** Every URL this feature can fetch at
 * runtime is built from `location.origin` by `buildAppConfig()`, and
 * `assertSameOrigin()` fails the config closed if that ever stops being true.
 * WebLLM's own `prebuiltAppConfig` is deliberately never used: it carries 160+
 * models whose weight URLs point at huggingface.co, which would make the set of
 * hosts Airlock can contact a property of a dependency instead of a property of
 * this file.
 *
 * Weights are served from this origin under `/models/`. They are large, so they
 * are **not** in git — `scripts/fetch-models.mjs` mirrors them into
 * `apps/airlock/public/models/` once, by hand, for dev and for deploy. That
 * script is the only place upstream (HuggingFace / GitHub) URLs appear, it is
 * never invoked by `npm run build`, and nothing it fetches happens in a user's
 * browser.
 *
 * ── Why these four models ──────────────────────────────────────────────────
 * Airlock's tools have tight JSON schemas and the loop is short, which is the
 * regime small models do best in. The trade is size vs. how often the model
 * emits a tool call that survives schema-constrained decoding:
 *
 *  - **Qwen2.5-3B-Instruct q4f16_1 (default).** Best structured-output
 *    reliability per byte in the 3B class, and Qwen2.5 was explicitly trained
 *    for tool use. 1.63 GiB of weights, ~2.5 GB VRAM. On a discrete GPU it
 *    loads from cache in well under a minute and generates fast enough that the
 *    approval gate, not the model, is the slow part of the demo.
 *  - **Llama-3.2-3B-Instruct q4f16_1 (alternative).** Same class, different
 *    vendor, slightly larger download, slightly lower VRAM. Here so the demo is
 *    not hostage to one license.
 *  - **Qwen2.5-1.5B-Instruct q4f16_1 (small).** Half the download, still a
 *    Qwen2.5. The honest recommendation for a laptop with an integrated GPU — a
 *    smaller Qwen beats a similarly-sized Llama at emitting valid JSON.
 *  - **Llama-3.2-1B-Instruct q4f16_1 (low-end).** 0.66 GiB, ~0.9 GB VRAM. The
 *    "it at least runs" option. It *will* emit malformed tool calls; T1-b's
 *    retry-with-correction path is what makes it usable at all.
 *
 * Larger models were rejected: 7-8B q4f16 wants ~5 GB of VRAM and a ~4 GB
 * download, which is outside "a normal work laptop" — and a download that size
 * makes self-hosting the weights impractical for the deploy.
 *
 * ── Provenance of the numbers ──────────────────────────────────────────────
 * Measured 2026-09-02, not estimated:
 *  - `vramRequiredMB`, `contextWindow`, `libFile` — copied from WebLLM 0.2.84's
 *    own `prebuiltAppConfig.model_list` (`modelVersion = "v0_2_84/base"`).
 *  - `weightsBytes` — sum of exactly the artifacts WebLLM 0.2.84 requests from
 *    the model directory (`mlc-chat-config.json` + `tensor-cache.json` +
 *    `tokenizer.json` + every `params_shard_*.bin`), read off the upstream repo
 *    tree. Excludes `README.md`, `.gitattributes`, `tokenizer_config.json` and
 *    the legacy `ndarray-cache.json`, none of which this version fetches.
 *  - `libBytes` — `Content-Length` of the compiled WebGPU kernel library.
 *
 * These are what the mirror will hold and therefore what the browser downloads
 * from this origin. `scripts/fetch-models.mjs` also writes the exact byte counts
 * it actually mirrored into `/models/<id>/airlock-manifest.json`; the store
 * prefers that number when it is present.
 */

import type { AppConfig, ModelRecord } from "@mlc-ai/web-llm";

/** Path under this origin where mirrored weights live. */
export const MODELS_ROOT = "/models";

/**
 * Filename the mirror script writes next to each model. Its presence is how the
 * store tells "this deployment does not host the weights" apart from "this
 * browser has not downloaded them yet" — two very different messages.
 */
export const MANIFEST_FILE = "airlock-manifest.json";

export type LocalModelId =
  | "Qwen2.5-3B-Instruct-q4f16_1-MLC"
  | "Llama-3.2-3B-Instruct-q4f16_1-MLC"
  | "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
  | "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/** Where a model sits in the curated list. Exactly one model is `"default"`. */
export type LocalModelTier = "default" | "alternate" | "small" | "low-end";

export interface LocalModelInfo {
  id: LocalModelId;
  /** Short label for the UI. */
  label: string;
  tier: LocalModelTier;
  /** Parameter count as a human string, e.g. `"3B"`. */
  params: string;
  /** MLC quantization scheme, e.g. `"q4f16_1"` (4-bit weights, fp16 compute). */
  quantization: string;
  /** One line the download-consent panel can show verbatim. */
  blurb: string;
  /** Bytes of weights + tokenizer + config served from `/models/<id>/`. */
  weightsBytes: number;
  /** Bytes of the compiled WebGPU kernel library served from `/models/lib/`. */
  libBytes: number;
  /** One-time download total: `weightsBytes + libBytes`. */
  downloadBytes: number;
  /** GPU memory WebLLM reports this model needs, in MB. */
  vramRequiredMB: number;
  /** Tokens of context we override the model config to. */
  contextWindow: number;
  /** Compiled kernel library filename, mirrored into `/models/lib/`. */
  libFile: string;
  /**
   * WebLLM's native `tools` / function-calling path only works for the Hermes
   * models listed in its `functionCallingModelIds`; none of ours are on it.
   * T1-b must drive tool calls with constrained JSON (`response_format`
   * `json_object` + schema), not `request.tools`.
   */
  supportsNativeToolCalls: false;
  /**
   * Grammar-constrained decoding (xgrammar) lives in the engine, not the model,
   * so JSON-schema-constrained output works for every model here. This is the
   * mechanism that makes a 1B model a usable tool caller at all.
   */
  supportsJsonSchema: true;
  license: string;
}

export const LOCAL_MODELS: readonly LocalModelInfo[] = [
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 3B Instruct",
    tier: "default",
    params: "3B",
    quantization: "q4f16_1",
    blurb:
      "Best tool-calling accuracy of the four. Needs a GPU with about 2.5 GB free.",
    weightsBytes: 1_743_386_559,
    libBytes: 5_438_957,
    downloadBytes: 1_743_386_559 + 5_438_957,
    vramRequiredMB: 2504.76,
    contextWindow: 4096,
    libFile: "Qwen2.5-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    supportsNativeToolCalls: false,
    supportsJsonSchema: true,
    license: "Qwen Research License",
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B Instruct",
    tier: "alternate",
    params: "3B",
    quantization: "q4f16_1",
    blurb:
      "Alternative 3B. Slightly larger download, slightly lower GPU requirement.",
    weightsBytes: 1_816_632_516,
    libBytes: 5_957_281,
    downloadBytes: 1_816_632_516 + 5_957_281,
    vramRequiredMB: 2263.69,
    contextWindow: 4096,
    libFile: "Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    supportsNativeToolCalls: false,
    supportsJsonSchema: true,
    license: "Llama 3.2 Community License",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 1.5B Instruct",
    tier: "small",
    params: "1.5B",
    quantization: "q4f16_1",
    blurb:
      "Half the download. The pick for an integrated GPU that still needs valid tool calls.",
    weightsBytes: 875_705_761,
    libBytes: 5_225_782,
    downloadBytes: 875_705_761 + 5_225_782,
    vramRequiredMB: 1629.75,
    contextWindow: 4096,
    // Upstream ships the Qwen2 kernel library for this model. Not a typo.
    libFile: "Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    supportsNativeToolCalls: false,
    supportsJsonSchema: true,
    license: "Apache-2.0",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B Instruct",
    tier: "low-end",
    params: "1B",
    quantization: "q4f16_1",
    blurb:
      "For weak or integrated GPUs: about 0.9 GB of VRAM. Expect more malformed tool calls.",
    weightsBytes: 704_397_819,
    libBytes: 5_320_982,
    downloadBytes: 704_397_819 + 5_320_982,
    vramRequiredMB: 879.04,
    contextWindow: 4096,
    libFile: "Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    supportsNativeToolCalls: false,
    supportsJsonSchema: true,
    license: "Llama 3.2 Community License",
  },
];

export const DEFAULT_MODEL_ID: LocalModelId = "Qwen2.5-3B-Instruct-q4f16_1-MLC";

export function getModel(id: LocalModelId): LocalModelInfo {
  const m = LOCAL_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown local model: ${id}`);
  return m;
}

export function isLocalModelId(id: string): id is LocalModelId {
  return LOCAL_MODELS.some((m) => m.id === id);
}

/** GB-aware size string. `lib/format.ts#bytes` stops at MB; models are ~1.7 GB. */
export function formatModelSize(n: number): string {
  const MB = 1024 * 1024;
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * The origin weights are served from — always this page's origin, which is the
 * whole point. Returns `""` outside a browser so callers fail loudly instead of
 * silently building a relative URL.
 */
export function currentOrigin(): string {
  if (typeof location === "undefined") return "";
  const o = location.origin;
  return !o || o === "null" ? "" : o;
}

function requireOrigin(origin: string | undefined): string {
  const o = origin ?? currentOrigin();
  if (!o) {
    throw new Error(
      "Local models need a page origin to load weights from; none is available here."
    );
  }
  return o.replace(/\/+$/, "");
}

/**
 * Directory a model's artifacts are served from.
 *
 * The `resolve/main/` segment is not decoration: WebLLM's `cleanModelUrl()`
 * appends exactly that to any `model` URL that does not already contain it, so
 * the mirror on disk has to match. Keeping the upstream path shape also makes
 * `scripts/fetch-models.mjs` a literal 1:1 path mirror — same path, our host —
 * which is the easiest possible thing to audit.
 */
export function modelDirUrl(id: LocalModelId, origin?: string): string {
  return `${requireOrigin(origin)}${MODELS_ROOT}/${id}/resolve/main/`;
}

/** Compiled WebGPU kernel library for a model, on this origin. */
export function modelLibUrl(id: LocalModelId, origin?: string): string {
  return `${requireOrigin(origin)}${MODELS_ROOT}/lib/${getModel(id).libFile}`;
}

/** Mirror manifest for a model, on this origin. */
export function manifestUrl(id: LocalModelId, origin?: string): string {
  return `${requireOrigin(origin)}${MODELS_ROOT}/${id}/${MANIFEST_FILE}`;
}

/** What `scripts/fetch-models.mjs` writes next to each mirrored model. */
export interface MirrorManifest {
  modelId: string;
  /** Exact bytes mirrored under `/models/<id>/resolve/main/`. */
  weightsBytes: number;
  /** Exact bytes of the mirrored kernel library. */
  libBytes: number;
  files: { path: string; bytes: number; sha256: string }[];
  /** Upstream the mirror was taken from. Provenance only; never fetched. */
  mirroredFrom: string;
  mirroredAt: string;
}

/** Narrow an unknown JSON body to a manifest. Returns null if it is not one. */
export function parseManifest(value: unknown): MirrorManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Partial<MirrorManifest>;
  if (typeof m.modelId !== "string") return null;
  if (typeof m.weightsBytes !== "number" || typeof m.libBytes !== "number") {
    return null;
  }
  return {
    modelId: m.modelId,
    weightsBytes: m.weightsBytes,
    libBytes: m.libBytes,
    files: Array.isArray(m.files) ? m.files : [],
    mirroredFrom: typeof m.mirroredFrom === "string" ? m.mirroredFrom : "",
    mirroredAt: typeof m.mirroredAt === "string" ? m.mirroredAt : "",
  };
}

/**
 * Fails a config closed if any URL in it leaves this origin. Called by
 * `buildAppConfig` on every build, so a mis-edit here cannot become a silent
 * third-party fetch in a user's browser.
 */
export function assertSameOrigin(config: AppConfig, origin: string): void {
  const expected = new URL(origin).origin;
  for (const r of config.model_list) {
    for (const url of [r.model, r.model_lib]) {
      let actual: string;
      try {
        actual = new URL(url).origin;
      } catch {
        throw new Error(`local model ${r.model_id}: unparseable URL ${url}`);
      }
      if (actual !== expected) {
        throw new Error(
          `local model ${r.model_id} would fetch from ${actual}, not ${expected}. ` +
            "Weights must be served same-origin; refusing to load."
        );
      }
    }
  }
}

/**
 * The `AppConfig` handed to WebLLM. An explicit `model_list` only — WebLLM never
 * gets a chance to resolve a URL we did not write down.
 *
 * `cacheBackend: "cache"` is WebLLM's best-tested backend (Cache API). Weights
 * land in the buckets listed in `WEBLLM_CACHE_SCOPES`, on this origin, which is
 * what makes every session after the first one work with the network off.
 */
export function buildAppConfig(
  origin?: string,
  models: readonly LocalModelInfo[] = LOCAL_MODELS
): AppConfig {
  const o = requireOrigin(origin);
  const model_list: ModelRecord[] = models.map((m) => ({
    model: modelDirUrl(m.id, o),
    model_id: m.id,
    model_lib: modelLibUrl(m.id, o),
    vram_required_MB: m.vramRequiredMB,
    low_resource_required: true,
    overrides: { context_window_size: m.contextWindow },
  }));
  const config: AppConfig = { model_list, cacheBackend: "cache" };
  assertSameOrigin(config, o);
  return config;
}

/** Cache Storage buckets WebLLM writes into, for size + delete reporting. */
export const WEBLLM_CACHE_SCOPES = [
  "webllm/model",
  "webllm/wasm",
  "webllm/config",
] as const;
