#!/usr/bin/env node
/**
 * Mirror Tesseract OCR language data into `apps/airlock/public/tessdata/` so
 * image OCR runs **same-origin** with zero egress.
 *
 * ── Why this script exists ─────────────────────────────────────────────
 * `tesseract.js` defaults to `https://cdn.jsdelivr.net/...` for
 * `<lang>.traineddata.gz` — a third-party origin contacted from the user's
 * browser, which the egress monitor would (correctly) report as a breach of
 * the exact promise local-only OCR exists to keep.
 *
 * So the browser never talks to jsdelivr. **This script does, once, on your
 * machine or in CI**, and copies the artifact into the app's own `public/`
 * directory. It is run by hand, never by `npm run build`, and never bundled.
 * The output is git-ignored (`apps/airlock/public/tessdata/`).
 *
 * ── Usage ──────────────────────────────────────────────────────────────
 *   node scripts/fetch-tessdata.mjs          # eng only (~14 MB)
 *   node scripts/fetch-tessdata.mjs --check  # verify, download nothing
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "apps", "airlock", "public", "tessdata");
// NOTE: the only third-party OCR URL in the repo. Never imported by the app.
const ENG_URL =
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";

async function main() {
  const checkOnly = process.argv.includes("--check");
  await mkdir(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "eng.traineddata.gz");
  try {
    const s = await stat(out);
    console.log(`tessdata ready: eng.traineddata.gz (${(s.size / 1e6).toFixed(1)} MB)`);
    return;
  } catch {
    // missing — fetch below
  }
  if (checkOnly) {
    console.error("MISSING: apps/airlock/public/tessdata/eng.traineddata.gz");
    process.exit(1);
  }
  console.log(`fetching ${ENG_URL}`);
  const res = await fetch(ENG_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  console.log(`wrote tessdata/eng.traineddata.gz (${(buf.length / 1e6).toFixed(1)} MB)`);
}

await main();
