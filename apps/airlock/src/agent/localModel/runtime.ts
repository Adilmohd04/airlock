/**
 * Local model runtime — WebGPU detection plus a thin, injectable wrapper around
 * WebLLM.
 *
 * Three things this file is careful about.
 *
 * 1. **Nothing WebLLM-shaped is imported eagerly.** `@mlc-ai/web-llm` is several
 *    MB of JS; every reference to it is behind `await import(...)`, so a user
 *    who never opens Local mode never downloads it. Everything at the top of
 *    this file is `import type`, which the compiler erases.
 *
 * 2. **Every URL is same-origin.** The config comes from
 *    `models.ts#buildAppConfig`, which throws if a URL would leave this origin.
 *    The only network requests this file can cause are GETs to `/models/...`
 *    on the page's own host. There is no CDN fallback and no "try HuggingFace
 *    if the mirror is missing" path — a missing mirror is a clean, explained
 *    failure, because a privacy claim the ledger can contradict is worse than a
 *    missing feature.
 *
 * 3. **The runtime is an interface, not a global.** `LocalRuntimeAdapter` is the
 *    seam: production uses `webllmAdapter`, tests inject a fake. No test in this
 *    repo needs a GPU.
 *
 * Offline note. WebLLM stores weights in the Cache API (`webllm/model`,
 * `webllm/config`) via `Cache.add()`, which runs inside the browser and so is
 * invisible to the `fetch` wrapper in `lib/egress.ts` — that is fine here,
 * because these are same-origin asset GETs that would only ever have
 * incremented `assetRequests`. The kernel library is the exception worth
 * knowing about: WebLLM deliberately refuses to cache a `model_lib` whose URL
 * contains the substring `localhost` (so devs get fresh kernels on reload), so
 * a DevTools-offline test must be run against `127.0.0.1` or the deployed host,
 * not `localhost`.
 */

import type {
  ChatCompletionMessageParam,
  ChatCompletionRequestBase,
  MLCEngine,
  ResponseFormat,
} from "@mlc-ai/web-llm";
import {
  buildAppConfig,
  getModel,
  manifestUrl,
  parseManifest,
  WEBLLM_CACHE_SCOPES,
  type LocalModelId,
  type MirrorManifest,
} from "./models";

// ── WebGPU detection ────────────────────────────────────────────────────────

/**
 * A coarse, honest bucket. This is a heuristic over adapter limits and vendor
 * strings, not a benchmark — we do not run a warm-up kernel to measure
 * tokens/sec, and the UI must not present it as a measurement.
 */
export type GpuSpeed = "fast" | "usable" | "slow" | "unknown";

export interface GpuReport {
  /** True only when an adapter exists AND it can actually run our models. */
  available: boolean;
  /** e.g. `"nvidia - ampere"`, or `""` when unavailable. */
  adapter: string;
  speed: GpuSpeed;
  /** Every q4f16_1 model in the catalog requires `shader-f16`. */
  shaderF16: boolean;
  maxStorageBufferBindingBytes: number;
  maxBufferBytes: number;
  /** Plain-language reason. Empty when `available` is true. */
  reason: string;
}

// Minimal structural types for the slice of WebGPU we touch. The repo does not
// depend on `@webgpu/types`, and one adapter probe does not justify adding it.
interface AdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}
interface AdapterLike {
  features?: { has(name: string): boolean };
  limits?: Partial<
    Record<"maxStorageBufferBindingSize" | "maxBufferSize", number>
  >;
  info?: AdapterInfoLike;
  requestAdapterInfo?: () => Promise<AdapterInfoLike>;
}
interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: "high-performance" | "low-power";
  }): Promise<AdapterLike | null>;
}

const UNAVAILABLE = (reason: string): GpuReport => ({
  available: false,
  adapter: "",
  speed: "unknown",
  shaderF16: false,
  maxStorageBufferBindingBytes: 0,
  maxBufferBytes: 0,
  reason,
});

function describeAdapter(info: AdapterInfoLike | undefined): string {
  if (!info) return "GPU (details withheld by the browser)";
  const parts = [info.vendor, info.architecture].filter(
    (p): p is string => !!p && p.length > 0
  );
  if (parts.length > 0) return parts.join(" - ");
  return info.description || info.device || "GPU (details withheld by the browser)";
}

/**
 * Rank the adapter. Rationale, so nobody has to guess later:
 *  - `maxStorageBufferBindingSize` is the limit that decides whether a 3B model
 *    can bind its parameter buffers at all, and it tracks GPU tier closely
 *    enough to be a useful proxy (128 MiB on the weakest integrated parts,
 *    1-2 GiB on anything discrete).
 *  - A software adapter (SwiftShader / llvmpipe / "Microsoft Basic Render")
 *    passes feature detection and then runs at unusable speed, so it is named.
 */
function rankSpeed(
  info: AdapterInfoLike | undefined,
  maxStorageBufferBindingBytes: number
): GpuSpeed {
  const text = [info?.vendor, info?.architecture, info?.device, info?.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/swiftshader|llvmpipe|basic render|software/.test(text)) return "slow";
  const MiB = 1024 * 1024;
  if (maxStorageBufferBindingBytes >= 1024 * MiB) return "fast";
  if (maxStorageBufferBindingBytes >= 256 * MiB) return "usable";
  if (maxStorageBufferBindingBytes > 0) return "slow";
  return "unknown";
}

/**
 * Feature-detect WebGPU. Never throws and never logs: an exception anywhere in
 * here becomes an `available: false` report with a reason, because "the probe
 * blew up" and "there is no GPU" must look identical to the caller. This is
 * what keeps a WebGPU-less browser free of console errors.
 */
export async function detectWebGpu(): Promise<GpuReport> {
  try {
    if (typeof navigator === "undefined") {
      return UNAVAILABLE("No browser environment.");
    }
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") {
      return UNAVAILABLE(
        "This browser does not support WebGPU. Local mode needs Chrome/Edge 113+ or Safari 18+."
      );
    }
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      return UNAVAILABLE(
        "WebGPU is present but no GPU adapter was granted — usually a headless session, a blocklisted driver, or hardware acceleration turned off."
      );
    }

    let info: AdapterInfoLike | undefined = adapter.info;
    if (!info && typeof adapter.requestAdapterInfo === "function") {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {
        info = undefined;
      }
    }

    const shaderF16 = adapter.features?.has("shader-f16") ?? false;
    const maxStorageBufferBindingBytes =
      adapter.limits?.maxStorageBufferBindingSize ?? 0;
    const maxBufferBytes = adapter.limits?.maxBufferSize ?? 0;
    const name = describeAdapter(info);

    if (!shaderF16) {
      return {
        ...UNAVAILABLE(
          "Your GPU does not support 16-bit shaders (shader-f16), which every model in the local catalog needs."
        ),
        adapter: name,
        maxStorageBufferBindingBytes,
        maxBufferBytes,
      };
    }

    return {
      available: true,
      adapter: name,
      speed: rankSpeed(info, maxStorageBufferBindingBytes),
      shaderF16,
      maxStorageBufferBindingBytes,
      maxBufferBytes,
      reason: "",
    };
  } catch (err) {
    return UNAVAILABLE(
      `WebGPU probe failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Are the weights actually on this origin? ────────────────────────────────

/**
 * The answer to "can this deployment serve the weights at all", which is a
 * different question from "has this browser downloaded them". Getting these
 * confused is how a user ends up staring at a progress bar that 404s at 3%.
 */
export interface HostingReport {
  hosted: boolean;
  /** Plain-language reason when `hosted` is false. Empty otherwise. */
  reason: string;
  /** The mirror manifest, when the deployment publishes one. */
  manifest: MirrorManifest | null;
}

const MIRROR_HINT =
  "Run `node scripts/fetch-models.mjs <model-id>` to mirror it into apps/airlock/public/models/, then redeploy.";

/**
 * Probe the same-origin mirror by fetching its manifest.
 *
 * Two failure modes are called out separately because both are real:
 *  - 404: the deployment never mirrored the weights.
 *  - 200 with HTML: an SPA catch-all rewrite is swallowing `/models/*` and
 *    handing back `index.html`. WebLLM would then "download" the app shell 62
 *    times and fail deep inside a tensor parse, which is a miserable thing to
 *    debug from a progress bar.
 */
export async function probeHostedWeights(
  modelId: LocalModelId
): Promise<HostingReport> {
  const url = manifestUrl(modelId);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      return {
        hosted: false,
        reason: `This deployment does not host ${modelId}. ${MIRROR_HINT}`,
        manifest: null,
      };
    }
    if (!res.ok) {
      return {
        hosted: false,
        reason: `The weight mirror answered ${res.status} for ${url}.`,
        manifest: null,
      };
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        hosted: false,
        reason:
          "`/models/` returned HTML instead of the mirror manifest — an SPA catch-all rewrite is probably swallowing it. Exclude /models/* from the redirect.",
        manifest: null,
      };
    }
    const manifest = parseManifest(body);
    if (!manifest) {
      return {
        hosted: false,
        reason: `The mirror manifest at ${url} is malformed. ${MIRROR_HINT}`,
        manifest: null,
      };
    }
    return { hosted: true, reason: "", manifest };
  } catch (err) {
    return {
      hosted: false,
      reason: `Could not reach the weight mirror on this origin: ${
        err instanceof Error ? err.message : String(err)
      }`,
      manifest: null,
    };
  }
}

// ── The chat surface T1-b drives ────────────────────────────────────────────

/**
 * Roles the runtime accepts.
 *
 * There is deliberately no `"tool"` role. WebLLM only wires the tool role (and
 * `request.tools`) for the Hermes function-calling models in its
 * `functionCallingModelIds` list, and no model in our catalog is on it. T1-b
 * feeds tool results back as `user` messages and constrains the model's next
 * turn with `format: { type: "json_object", schema }`. That path works for
 * every model here; the native one does not.
 */
export interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Constrained decoding. `json_object` + `schema` is what makes a 1-3B model
 * usable as a tool caller: the grammar engine masks logits so the output cannot
 * leave the schema. `schema` is a JSON Schema serialized as a string (WebLLM's
 * own convention).
 */
export type LocalResponseFormat =
  | { type: "text" }
  | { type: "json_object"; schema?: string }
  | { type: "grammar"; grammar: string };

export interface LocalChatRequest {
  messages: LocalChatMessage[];
  /** Default 0.2 — low, because this drives tools, not prose. */
  temperature?: number;
  maxTokens?: number;
  /** Set it for reproducible demo runs. */
  seed?: number;
  stop?: string[];
  format?: LocalResponseFormat;
  /** Provide to stream; the full text is still returned when it resolves. */
  onToken?: (delta: string) => void;
  /** Aborting interrupts generation and resolves with `finishReason: "abort"`. */
  signal?: AbortSignal;
}

export interface LocalChatResult {
  text: string;
  finishReason: "stop" | "length" | "abort" | "unknown";
  usage?: { promptTokens: number; completionTokens: number };
  /** Wall-clock milliseconds for the whole call. */
  elapsedMs: number;
}

/** A model that is resident on the GPU. */
export interface LoadedEngine {
  readonly modelId: LocalModelId;
  chat(request: LocalChatRequest): Promise<LocalChatResult>;
  /** Stop the current generation. Safe to call when nothing is generating. */
  interrupt(): Promise<void>;
  /** Free GPU memory. The weights stay in the browser cache. */
  unload(): Promise<void>;
}

export interface LoadProgress {
  /** 0..1. */
  progress: number;
  /** WebLLM's own status line, e.g. `"Fetching param cache[12/68]: ..."`. */
  text: string;
  timeElapsed: number;
  /**
   * True while WebLLM is pulling artifacts over the network, false while it is
   * loading already-cached shards onto the GPU. Derived from `text`; the store
   * uses it to tell "downloading" apart from "warming up the GPU" in the UI.
   */
  fetching: boolean;
}

export interface LoadOptions {
  modelId: LocalModelId;
  onProgress?: (p: LoadProgress) => void;
  /** Abort mid-download. Already-cached shards survive, so a retry resumes. */
  signal?: AbortSignal;
}

/**
 * The injectable seam. Everything the store needs from the outside world is on
 * this interface, so `store.test.ts` drives the whole state machine with a fake
 * and no GPU.
 */
export interface LocalRuntimeAdapter {
  detectGpu(): Promise<GpuReport>;
  /** Does this origin serve the weights? See {@link probeHostedWeights}. */
  probeHosted(modelId: LocalModelId): Promise<HostingReport>;
  /** True when every weight shard for the model is already in the browser cache. */
  isCached(modelId: LocalModelId): Promise<boolean>;
  load(options: LoadOptions): Promise<LoadedEngine>;
  deleteWeights(modelId: LocalModelId): Promise<void>;
  /** Bytes held in the WebLLM caches, or null when it cannot be determined. */
  cacheBytes(): Promise<number | null>;
}

/** Thrown when a load is cancelled, so the store can report it as "not an error". */
export class LoadAbortedError extends Error {
  constructor() {
    super("Model load cancelled.");
    this.name = "LoadAbortedError";
  }
}

// ── The WebLLM implementation ───────────────────────────────────────────────

/** WebLLM says "Fetching param cache" while downloading, "Loading" from cache. */
function isFetchingText(text: string): boolean {
  return /fetch/i.test(text) && !/loading model from cache/i.test(text);
}

function toWebllmFormat(
  format: LocalResponseFormat | undefined
): ResponseFormat | undefined {
  if (!format) return undefined;
  switch (format.type) {
    case "text":
      return { type: "text" };
    case "json_object":
      return format.schema
        ? { type: "json_object", schema: format.schema }
        : { type: "json_object" };
    case "grammar":
      return { type: "grammar", grammar: format.grammar };
  }
}

function toWebllmMessages(
  messages: LocalChatMessage[]
): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "system") return { role: "system", content: m.content };
    if (m.role === "assistant") return { role: "assistant", content: m.content };
    return { role: "user", content: m.content };
  });
}

function normalizeFinish(
  reason: string | null | undefined
): LocalChatResult["finishReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "abort") return "abort";
  return "unknown";
}

function wrapEngine(engine: MLCEngine, modelId: LocalModelId): LoadedEngine {
  return {
    modelId,
    async chat(request: LocalChatRequest): Promise<LocalChatResult> {
      const started = Date.now();
      const base: ChatCompletionRequestBase = {
        messages: toWebllmMessages(request.messages),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 768,
        seed: request.seed,
        stop: request.stop,
        response_format: toWebllmFormat(request.format),
      };

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        void engine.interruptGenerate();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        if (request.onToken) {
          const stream = await engine.chat.completions.create({
            ...base,
            stream: true,
            stream_options: { include_usage: true },
          });
          let text = "";
          let finish: string | null | undefined;
          let usage: LocalChatResult["usage"];
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
              text += delta;
              request.onToken(delta);
            }
            const fr = chunk.choices[0]?.finish_reason;
            if (fr) finish = fr;
            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
              };
            }
          }
          return {
            text,
            finishReason: aborted ? "abort" : normalizeFinish(finish),
            usage,
            elapsedMs: Date.now() - started,
          };
        }

        const reply = await engine.chat.completions.create({
          ...base,
          stream: false,
        });
        const choice = reply.choices[0];
        return {
          text: choice?.message?.content ?? "",
          finishReason: aborted ? "abort" : normalizeFinish(choice?.finish_reason),
          usage: reply.usage
            ? {
                promptTokens: reply.usage.prompt_tokens,
                completionTokens: reply.usage.completion_tokens,
              }
            : undefined,
          elapsedMs: Date.now() - started,
        };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
    async interrupt(): Promise<void> {
      await engine.interruptGenerate();
    },
    async unload(): Promise<void> {
      await engine.unload();
    },
  };
}

/**
 * Sum the `Content-Length` of everything WebLLM has cached. Reading headers off
 * a cached `Response` does not consume its body, so this stays cheap even for a
 * 1.7 GB model. Falls back to `navigator.storage.estimate()` when a response
 * carries no length header, and to `null` when neither works.
 */
async function measureCacheBytes(): Promise<number | null> {
  if (typeof caches === "undefined") return null;
  try {
    let total = 0;
    let missingLength = false;
    for (const scope of WEBLLM_CACHE_SCOPES) {
      if (!(await caches.has(scope))) continue;
      const cache = await caches.open(scope);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const len = response?.headers.get("content-length");
        if (len) total += Number(len) || 0;
        else missingLength = true;
      }
    }
    if (total > 0) return total;
    if (!missingLength) return 0;
  } catch {
    /* fall through to the storage estimate */
  }
  try {
    const est = await navigator.storage?.estimate?.();
    return typeof est?.usage === "number" ? est.usage : null;
  } catch {
    return null;
  }
}

/**
 * The production adapter. Every WebLLM symbol is reached through a dynamic
 * `import()` so the library lands in its own async chunk, and every URL comes
 * from `buildAppConfig()`, which refuses to leave this origin.
 */
export const webllmAdapter: LocalRuntimeAdapter = {
  detectGpu: detectWebGpu,

  probeHosted: probeHostedWeights,

  async isCached(modelId: LocalModelId): Promise<boolean> {
    try {
      const webllm = await import("@mlc-ai/web-llm");
      return await webllm.hasModelInCache(modelId, buildAppConfig());
    } catch {
      // A cache probe that throws means "we cannot prove it is cached", which
      // for every caller is the same as "not cached".
      return false;
    }
  },

  async load({ modelId, onProgress, signal }: LoadOptions): Promise<LoadedEngine> {
    const model = getModel(modelId);
    // Throws before a single byte moves if the catalog was edited to point off
    // this origin.
    const appConfig = buildAppConfig();
    const webllm = await import("@mlc-ai/web-llm");
    const engine = new webllm.MLCEngine({
      appConfig,
      logLevel: "WARN",
      initProgressCallback: (report) => {
        onProgress?.({
          progress: report.progress,
          text: report.text,
          timeElapsed: report.timeElapsed,
          fetching: isFetchingText(report.text),
        });
      },
    });

    // `unload()` aborts the in-flight reload — it owns the AbortController
    // WebLLM passes to every artifact fetch. Shards already written to the
    // Cache API stay there, which is what makes a cancelled download resumable.
    const onAbort = () => {
      void engine.unload();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await engine.reload(modelId, { context_window_size: model.contextWindow });
    } catch (err) {
      if (signal?.aborted) throw new LoadAbortedError();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) {
      await engine.unload();
      throw new LoadAbortedError();
    }
    return wrapEngine(engine, modelId);
  },

  async deleteWeights(modelId: LocalModelId): Promise<void> {
    const webllm = await import("@mlc-ai/web-llm");
    await webllm.deleteModelAllInfoInCache(modelId, buildAppConfig());
  },

  cacheBytes: measureCacheBytes,
};
