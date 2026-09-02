#!/usr/bin/env node
/**
 * Mirror local-model weights into `apps/airlock/public/models/` so Airlock can
 * serve them **same-origin**.
 *
 * ── Why this script exists ─────────────────────────────────────────────────
 * Airlock's whole claim is that nothing leaves the device. WebLLM's default
 * config pulls weights from huggingface.co and kernel libraries from
 * raw.githubusercontent.com — two third-party origins contacted from the user's
 * browser, which the egress monitor would (correctly) report as a breach of the
 * exact promise the local-model feature exists to make.
 *
 * So the browser never talks to them. **This script does, once, on your
 * machine or in CI**, and copies the artifacts into the app's own `public/`
 * directory. It is:
 *
 *   - run by hand, never by `npm run build`;
 *   - the only file in the repo that contains a third-party weight URL;
 *   - never bundled, never shipped, never executed in a browser.
 *
 * The output is git-ignored (`apps/airlock/public/models/`) because it is
 * hundreds of megabytes to gigabytes. A deploy must either run this script in
 * its build image or upload the directory alongside the app.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/fetch-models.mjs --list
 *   node scripts/fetch-models.mjs                       # the default model
 *   node scripts/fetch-models.mjs Llama-3.2-1B-Instruct-q4f16_1-MLC
 *   node scripts/fetch-models.mjs --all                 # every catalog model
 *   node scripts/fetch-models.mjs --check               # verify, download nothing
 *
 * Re-running is cheap: a file whose size already matches upstream is skipped,
 * so an interrupted mirror resumes.
 *
 * ── Layout it produces ─────────────────────────────────────────────────────
 *   public/models/<model-id>/resolve/main/mlc-chat-config.json
 *   public/models/<model-id>/resolve/main/tensor-cache.json
 *   public/models/<model-id>/resolve/main/tokenizer.json
 *   public/models/<model-id>/resolve/main/params_shard_*.bin
 *   public/models/<model-id>/airlock-manifest.json      <- written by us
 *   public/models/lib/<model-lib>.wasm
 *
 * The `resolve/main/` segment mirrors HuggingFace's own path shape, which is
 * not cosmetic: WebLLM's `cleanModelUrl()` appends exactly that to any model
 * URL lacking it. Keeping the shape makes this a literal 1:1 path mirror — same
 * path, our host — which is the easiest possible thing to audit.
 *
 * The model list is *parsed out of* `apps/airlock/src/agent/localModel/models.ts`
 * rather than duplicated here, so the two cannot drift.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CATALOG = join(REPO, "apps/airlock/src/agent/localModel/models.ts");
const WEBLLM_CONFIG_DTS = join(
  REPO,
  "node_modules/@mlc-ai/web-llm/lib/config.d.ts"
);
const OUT_ROOT = join(REPO, "apps/airlock/public/models");

/** The two upstreams. Deliberately the only place these strings exist. */
const HF_REPO_BASE = "https://huggingface.co/mlc-ai";
const HF_API_BASE = "https://huggingface.co/api/models/mlc-ai";
const LIB_BASE =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models";

const PARALLEL = 4;

// ── catalog ────────────────────────────────────────────────────────────────

/** Pull `{ id, libFile }` out of `models.ts` so there is one source of truth. */
async function readCatalog() {
  const src = await readFile(CATALOG, "utf8");
  const ids = [...src.matchAll(/^\s{4}id: "([^"]+)",$/gm)].map((m) => m[1]);
  const libs = [...src.matchAll(/^\s{4}libFile: "([^"]+)",$/gm)].map((m) => m[1]);
  if (ids.length === 0 || ids.length !== libs.length) {
    throw new Error(
      `Could not parse the model catalog (${ids.length} ids, ${libs.length} libFiles). ` +
        "Has the shape of LOCAL_MODELS in models.ts changed?"
    );
  }
  const defaultMatch = src.match(/DEFAULT_MODEL_ID: LocalModelId = "([^"]+)"/);
  return {
    models: ids.map((id, i) => ({ id, libFile: libs[i] })),
    defaultId: defaultMatch ? defaultMatch[1] : ids[0],
  };
}

/**
 * The kernel-library version tag must match the installed WebLLM exactly — a
 * mismatched `.wasm` fails at GPU load with an unhelpful error. Read it from
 * the package's own type declarations instead of hardcoding it here.
 */
async function readModelVersion() {
  const dts = await readFile(WEBLLM_CONFIG_DTS, "utf8");
  const m = dts.match(/modelVersion = "([^"]+)"/);
  if (!m) {
    throw new Error(
      "Could not read `modelVersion` from @mlc-ai/web-llm. Is the dependency installed?"
    );
  }
  return m[1];
}

// ── network ────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "airlock-mirror" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function headLength(url) {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { "user-agent": "airlock-mirror" },
  });
  if (!res.ok) throw new Error(`HEAD ${url} -> ${res.status}`);
  const len = res.headers.get("content-length");
  return len ? Number(len) : null;
}

/** Stream a URL to disk, hashing as it goes. Returns `{ bytes, sha256 }`. */
async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { "user-agent": "airlock-mirror" } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  const tmp = `${dest}.partial`;
  await pipeline(body, createWriteStream(tmp));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  return { bytes, sha256: hash.digest("hex") };
}

async function sizeOnDisk(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function hashOnDisk(path) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest("hex");
}

// ── mirroring one model ────────────────────────────────────────────────────

/**
 * Exactly the artifacts WebLLM 0.2.84 requests from a model directory. Anything
 * else in the upstream repo (`README.md`, `.gitattributes`,
 * `tokenizer_config.json`, the legacy `ndarray-cache.json`) is deliberately not
 * mirrored — mirroring only what is fetched keeps the manifest an honest
 * statement of what the browser will download.
 */
const ALWAYS = ["mlc-chat-config.json", "tensor-cache.json"];
const TOKENIZERS = ["tokenizer.json", "tokenizer.model"];

async function mirrorModel(model, modelVersion, { checkOnly }) {
  const { id, libFile } = model;
  const outDir = join(OUT_ROOT, id, "resolve", "main");
  const srcBase = `${HF_REPO_BASE}/${id}/resolve/main`;

  console.log(`\n=== ${id} ===`);
  const tree = await getJson(`${HF_API_BASE}/${id}/tree/main?recursive=1`);
  const upstream = new Map(
    tree.filter((f) => f.type === "file").map((f) => [f.path, f.size])
  );

  const wanted = [
    ...ALWAYS.filter((f) => upstream.has(f)),
    ...TOKENIZERS.filter((f) => upstream.has(f)),
    ...[...upstream.keys()]
      .filter((p) => /^params_shard_\d+\.bin$/.test(p))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])),
  ];
  for (const required of ALWAYS) {
    if (!upstream.has(required)) {
      throw new Error(`${id}: upstream is missing ${required}`);
    }
  }

  const files = [];
  let done = 0;
  const total = wanted.length;

  async function handle(rel) {
    const dest = join(outDir, rel);
    const want = upstream.get(rel);
    const have = await sizeOnDisk(dest);
    let bytes;
    let sha256;
    if (have === want) {
      bytes = have;
      sha256 = await hashOnDisk(dest);
      process.stdout.write(`  [${++done}/${total}] ${rel} (cached)\n`);
    } else if (checkOnly) {
      process.stdout.write(
        `  [${++done}/${total}] ${rel} MISSING (have ${have ?? "nothing"}, want ${want})\n`
      );
      return;
    } else {
      const r = await download(`${srcBase}/${rel}`, dest);
      bytes = r.bytes;
      sha256 = r.sha256;
      process.stdout.write(
        `  [${++done}/${total}] ${rel} ${(bytes / 1e6).toFixed(1)} MB\n`
      );
    }
    files.push({ path: `resolve/main/${rel}`, bytes, sha256 });
  }

  // Bounded parallelism: HF throttles hard above a handful of streams.
  const queue = [...wanted];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let rel = queue.shift(); rel; rel = queue.shift()) await handle(rel);
    })
  );

  // The kernel library lives in a shared directory — several models can point
  // at the same file, so it is keyed by filename, not by model id.
  const libDest = join(OUT_ROOT, "lib", libFile);
  const libUrl = `${LIB_BASE}/${modelVersion}/${libFile}`;
  const libWant = await headLength(libUrl);
  const libHave = await sizeOnDisk(libDest);
  let libBytes;
  let libSha;
  if (libHave !== null && (libWant === null || libHave === libWant)) {
    libBytes = libHave;
    libSha = await hashOnDisk(libDest);
    console.log(`  lib/${libFile} (cached)`);
  } else if (checkOnly) {
    console.log(`  lib/${libFile} MISSING`);
    libBytes = 0;
    libSha = "";
  } else {
    const r = await download(libUrl, libDest);
    libBytes = r.bytes;
    libSha = r.sha256;
    console.log(`  lib/${libFile} ${(libBytes / 1e6).toFixed(1)} MB`);
  }
  if (libSha) files.push({ path: `../lib/${libFile}`, bytes: libBytes, sha256: libSha });

  if (checkOnly) return;

  const weightsBytes = files
    .filter((f) => f.path.startsWith("resolve/main/"))
    .reduce((n, f) => n + f.bytes, 0);
  const manifest = {
    modelId: id,
    weightsBytes,
    libBytes,
    files,
    mirroredFrom: `${srcBase} + ${LIB_BASE}/${modelVersion}/${libFile}`,
    mirroredAt: new Date().toISOString(),
  };
  const manifestPath = join(OUT_ROOT, id, "airlock-manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(
    `  manifest written: ${((weightsBytes + libBytes) / 1e9).toFixed(2)} GB total`
  );
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const { models, defaultId } = await readCatalog();

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Mirror local-model weights into apps/airlock/public/models/ (same-origin hosting).",
        "",
        "  node scripts/fetch-models.mjs --list",
        "  node scripts/fetch-models.mjs [modelId...]",
        "  node scripts/fetch-models.mjs --all",
        "  node scripts/fetch-models.mjs --check [modelId...]",
        "",
        "Downloads from huggingface.co and raw.githubusercontent.com. This is the",
        "ONLY place Airlock ever touches those hosts, and it never runs in a browser.",
      ].join("\n")
    );
    return;
  }

  if (argv.includes("--list")) {
    for (const m of models) {
      console.log(`${m.id}${m.id === defaultId ? "  (default)" : ""}`);
    }
    return;
  }

  const checkOnly = argv.includes("--check");
  const named = argv.filter((a) => !a.startsWith("--"));
  const selected = argv.includes("--all")
    ? models
    : named.length > 0
      ? named.map((id) => {
          const m = models.find((x) => x.id === id);
          if (!m) throw new Error(`unknown model id: ${id}`);
          return m;
        })
      : models.filter((m) => m.id === defaultId);

  const modelVersion = await readModelVersion();
  console.log(
    `Mirroring ${selected.length} model(s) into ${OUT_ROOT}\n` +
      `WebLLM kernel-library version: ${modelVersion}`
  );

  for (const m of selected) await mirrorModel(m, modelVersion, { checkOnly });

  console.log(
    "\nDone. These files must be served from the same origin as the app, with" +
      "\n  Content-Type: application/wasm for .wasm" +
      "\n  and NOT captured by an SPA catch-all rewrite (exclude /models/*)."
  );
}

main().catch((err) => {
  console.error(`\nfetch-models failed: ${err.message}`);
  process.exitCode = 1;
});
