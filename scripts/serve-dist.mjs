/**
 * serve-dist.mjs — static server for apps/airlock/dist with the PRODUCTION
 * header set applied (COOP/COEP, WASM MIME, nosniff), because `vite preview`
 * does not process _headers / netlify.toml. Used for the 127.0.0.1 god-mode
 * demo run (WebLLM refuses to cache model_lib URLs containing "localhost" —
 * bind 127.0.0.1, never localhost).
 *
 *   node scripts/serve-dist.mjs [port]   # default 4173
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/airlock/dist", import.meta.url));
const port = Number(process.argv[2] ?? 4173);

const MIME = {
  ".html": "text/html; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".gz": "application/gzip",
  ".csv": "text/csv",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = normalize(join(root, rel));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      // /models/* and /tessdata/* must 404 like production: the runtimes
      // distinguish a real mirror from the SPA shell by content type — an
      // HTML fallback here reads as a broken mirror (see runtime.ts
      // probeHostedWeights and lib/ocr.ts tessdata probe).
      if (
        rel === "/models" ||
        rel.startsWith("/models/") ||
        rel === "/tessdata" ||
        rel.startsWith("/tessdata/")
      ) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      // SPA fallback — mirrors the /* -> /index.html 200 rewrite.
      body = await readFile(join(root, "index.html"));
      file = join(root, "index.html");
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      // Match production: WebMCP hosts gate tool discovery on origin
      // isolation, so local runs must send what Netlify sends.
      "Origin-Agent-Cluster": "?1",
      "Permissions-Policy": "tools=(self)",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`airlock dist on http://127.0.0.1:${port} (COOP/COEP on)`);
});
