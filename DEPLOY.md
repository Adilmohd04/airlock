# Deployment Guide: Airlock on Netlify

**Airlock** is an agent-native data workspace where agents analyze private tabular data that never leaves your browser (DuckDB-WASM). This guide covers deploying Airlock to Netlify with proper WASM support and security headers.

## Verification status (read this first)

This section exists because the product's whole claim is "we can prove it" —
an unverified claim here is worse than an admitted gap. Last verified:
**2026-09-02**, on branch `chore/deploy-verify`, against a clean
`npm run build` (Node v22.23.2, npm 12.0.2).

**Verified, with evidence, on this machine:**

- `npm run build` from a clean `dist/` (and a clean `packages/webmcp-staged/dist`)
  succeeds. Output sizes below.
- All three gates green: `npm run build`, `npm run typecheck --workspace
  apps/airlock` (zero errors), `npm test` (webmcp-staged 5/5 + airlock 243/243 =
  **248/248**).
- **Static egress audit of the actual `dist/` output** (not just the source):
  grepped every emitted `.js`/`.css`/`.html` for `https?://` literals pointing
  off-origin. Findings and why each is inert are in
  [`## Egress audit findings`](#egress-audit-findings) below. No app code path
  reaches any of them.
- **Header/MIME behavior**, by replaying `apps/airlock/public/_headers`'
  path-matching rules against the real emitted filenames in a small local
  script (not a real Netlify edge node — see caveat below): `.wasm` assets get
  `Content-Type: application/wasm`; both worker scripts get
  `Cross-Origin-Resource-Policy: cross-origin`; every path (including an
  extensionless SPA deep link) gets `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`; hashed assets get
  1-year immutable caching and HTML does not.
- `npm run preview` (Vite's own static server, no Netlify processing) serves
  `index.html` at 200 and infers `Content-Type: application/wasm` for the
  `.wasm` files correctly on its own — confirmed with `curl -I`.
- `vite.config.ts` has no `base` override, so it defaults to `/`, which is
  correct for a root-domain deploy: `dist/index.html` references
  `/assets/...` as absolute root paths, not relative ones.

**NOT verified — needs a human with a real browser, or a live deploy:**

- **No real browser was driven.** This environment has no Playwright,
  Puppeteer, or other browser automation installed, and installing one was out
  of scope (it's a `package.json`/tooling change outside this stream's owned
  files, and would itself be a network fetch of a browser binary). Everything
  above is curl + static analysis + a hand-rolled Node script that replays the
  `_headers` matching rules — it is not the same as a browser actually
  fetching a Worker, instantiating WASM, and reporting zero console errors.
  **A human must open the built app in an actual browser** (locally via
  `npm run preview`, or on the live Netlify URL) and confirm: the DuckDB
  worker boots, the app renders past `EmptyState`, the demo CSV loads, and the
  DevTools Network tab shows only same-origin requests.
- **Nothing has been deployed to Netlify.** `netlify.toml` and `_headers` are
  the actual Netlify configuration mechanism; a local script that "replays"
  their rules is a reasonable proxy but is not Netlify's real edge processing
  (redirect precedence, header-merge order across `netlify.toml` and
  `_headers`, TLS termination, CDN caching behavior). The live-deploy steps
  and post-deploy checklist below tell you exactly what to run once a site
  exists — none of those checklist items have been checked off yet.
- **`document.modelContext` presence** and actual WebMCP tool invocation from
  a host (ChatGPT desktop, Chrome with the WebMCP flag) — these require a real
  browser/host, not curl.

## Overview

Airlock is built as an npm monorepo with two key parts:
- `packages/webmcp-staged/` — Reusable WebMCP staged action primitive
- `apps/airlock/` — React + Vite application with DuckDB-WASM

The build output is static (no server required). All computation runs
client-side; DuckDB-WASM, its worker scripts, and the demo CSVs are all
self-hosted in the bundle (see the egress audit below) — nothing is fetched
from a CDN.

## Prerequisites

- Node.js >= 20 (Netlify build pinned to Node 20 via `netlify.toml`
  `[build.environment]`; verified locally on Node v22.23.2, not yet on
  Netlify's own Node 20 build image)
- npm >= 10
- Netlify account and [Netlify CLI](https://cli.netlify.com/) (optional, for local testing)
- Git repository synced with Netlify

## Build Process

The monorepo uses a two-stage build:

```bash
npm install              # Install all workspace dependencies
npm run build            # Builds webmcp-staged, then airlock
                         # Output: apps/airlock/dist/
npm run preview          # Local preview of production build (Vite's static
                         # server — does NOT apply Netlify's _headers/
                         # netlify.toml header rules; see the header-check
                         # command in "Local pre-deploy checklist" below for
                         # that instead)
```

Build artifacts (sizes from the 2026-09-02 verification build):
- `apps/airlock/dist/index.html` — SPA entry point, ~0.9 kB
- `apps/airlock/dist/assets/` — hashed JS, CSS, WASM bundles (immutable)
- `apps/airlock/dist/demo/` — bundled demo CSVs (immutable)

DuckDB-WASM assets are the bulk of the payload:
- `duckdb-eh-[hash].wasm` — ~34 MB (SIMD/exception-handling variant)
- `duckdb-mvp-[hash].wasm` — ~39 MB (baseline variant for older browsers)
- `duckdb-browser-eh.worker-[hash].js` / `duckdb-browser-mvp.worker-[hash].js`
  — ~770–845 kB each, the Web Worker entrypoints
- `duckdb-browser-[hash].js` — ~200 kB, the DuckDB-WASM glue, lazy-loaded via
  `await import("@duckdb/duckdb-wasm")` in `engine/duckdb.ts` so it never
  blocks the initial app chunk

**Important, and specific to this repo's naming:** the worker filenames Vite
emits are `duckdb-browser-eh.worker-hQa-dcAV.js` — the hash lands *inside* the
name, not appended after a `.worker.js` suffix. A header rule written as
`/assets/*.worker.js` matches **zero** real files. This was found and fixed in
this pass; see [`## Fixes made in this pass`](#fixes-made-in-this-pass).

## Egress audit findings

Searched the entire built `dist/` (every `.js`, `.css`, `.html`) for
`https?://` literals pointing off-origin:

```bash
grep -rEo "https?://[a-zA-Z0-9./_%?=&-]+" apps/airlock/dist \
  --include="*.js" --include="*.css" --include="*.html" | sort -u
```

Everything found, and why none of it is a live network path:

| Match | File | What it actually is |
| --- | --- | --- |
| `https://cdn.jsdelivr.net/npm/` | `assets/duckdb-browser-*.js` | `@duckdb/duckdb-wasm`'s own exported `getJsDelivrBundles()` helper. Airlock's `engine/duckdb.ts` never imports or calls it — it builds its own `bundles` object from `?url` imports (self-hosted, same-origin) and passes that straight to `selectBundle()`. Read `selectBundle`'s actual source in `node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs`: it only branches on `getPlatformFeatures()` against the `bundles` argument it's given — it never calls the jsdelivr helper internally. The string ships in the bundle (Vite didn't tree-shake an unused named export out of this chunk) but is dead code: nothing in Airlock's call graph reaches it. |
| `https://github.com/emn178/js-sha256`, `https://github.com/cfworker`, `https://github.com/markedjs/marked.`, `https://github.com/webmachinelearning/webmcp/pull/184.` | various vendor chunks | License/attribution comments or plain strings inside console warning messages (e.g. the WebMCP polyfill's "see this PR" deprecation notice). Not fetched. |
| `http://www.w3.org/1998/Math/MathML`, `.../1999/xhtml`, `.../2000/svg`, `.../XML/1998/namespace` | React/marked/dompurify chunks | XML namespace URIs, required string constants for `createElementNS`/SVG/MathML — never dereferenced as URLs. |
| `https://reactjs.org/docs/error-decoder.html?invariant=` | `vendor-react` | Part of React's minified-error message template (a human-facing link if you paste the error code into your own browser), not something React fetches. |
| `http://fb.me/use-check-prop-types` | `vendor-recharts` | Same pattern — a legacy React/PropTypes deprecation-warning link, string only. |

**None found in `index.html` or the CSS.** `index.html` has no external
`<link>` (no Google Fonts, no CDN script tag, no favicon reference at all);
the CSS has no `@import` or external `url(...)`.

**Conclusion: zero external-origin references are reachable at runtime.** The
one that looks alarming at first grep (`jsdelivr`) is a well-known false
positive for anyone auditing `@duckdb/duckdb-wasm` bundles — it's part of the
package's public API surface for people who *do* want CDN-hosted WASM, and
Airlock deliberately doesn't use that code path. This is exactly the kind of
claim that's worth re-checking after every `@duckdb/duckdb-wasm` version bump,
since a future version's tree-shaking behavior or default bundle-selection
code path could change.

## WebMCP origin trial (Chrome-stable without the flag)

ChatGPT's browser and `chrome://flags/#enable-webmcp-testing` need nothing.
Plain Chrome-stable only exposes `document.modelContext` under the WebMCP
origin trial (Chrome 149+), so a public deploy should enroll:

1. Register the trial for the deploy origin at
   `developer.chrome.com/origintrials` (trial 4163014905550602241).
2. Set the token as a build-time env var — never in git:
   `VITE_WEBMCP_ORIGIN_TRIAL_TOKEN=<token> npm run build`
3. `main.tsx` injects it as an `origin-trial` meta tag at boot. The token is
   origin-bound and public by design; it grants no capability beyond the API
   surface, and without it the app falls back to the polyfill + Agent console.

## Local model weights (Tier 1 — the fully-local agent)

Local mode runs an in-browser LLM (WebLLM + WebGPU) that drives Airlock's tools
with **zero data egress**. The weights are large and are **not in git**; they
are served same-origin from `/models/` and mirrored there by
`scripts/fetch-models.mjs` (the one place any third-party weight URL exists, run
by hand or in CI, never in a browser).

### Which model the public deploy ships

Two defaults, on purpose (see `agent/localModel/models.ts`):

| Constant | Model | Size | Role |
| --- | --- | --- | --- |
| `DEFAULT_MODEL_ID` | Qwen2.5-3B-Instruct q4f16_1 | ~1.75 GB | Best tool-caller; the pick on real hardware. Selected by default in the UI. |
| `DEPLOY_DEFAULT_MODEL_ID` | Qwen2.5-1.5B-Instruct q4f16_1 | ~0.88 GB | What the hosted demo mirrors — small enough for a static host, still a Qwen2.5 so tool-call JSON stays reliable. |

The 3B stays a **one-click opt-up** for anyone who mirrors it themselves or
self-hosts. The size trade-off never touches the guarantee: whichever model
ships, its weights are served from Airlock's own origin, so the Seal stays at
0 external and `models.ts#assertSameOrigin` fails the build closed if a URL
ever points off-origin.

### Mirroring for a deploy

```bash
# What the live demo needs — the smaller deploy default:
node scripts/fetch-models.mjs --deploy      # ~0.88 GB into apps/airlock/public/models/

# Opt-up / self-host the 3B as well:
node scripts/fetch-models.mjs               # the UI default (3B)

# Everything, or a check without downloading:
node scripts/fetch-models.mjs --all
node scripts/fetch-models.mjs --check --deploy
```

Run this **before** `npm run build` (or in the build image), and make sure the
resulting `apps/airlock/public/models/` ships with the site. `netlify.toml` and
`_headers` already:
- **exclude `/models/*` from the SPA catch-all** so a missing weight returns a
  real 404 instead of `index.html` (a `200 text/html` fallback makes WebLLM
  "download" the app shell and fail deep in a tensor parse);
- serve `/models/lib/*` as `application/wasm` (required — the site-wide
  `nosniff` means a wrong MIME is rejected, not sniffed);
- cache `/models/*` immutable (a model id is content-addressed).

If the deploy does **not** mirror any weights, Local mode degrades honestly: the
runtime's `probeHosted()` reports "this deployment does not host <model>" and
Cloud mode still works. Nothing breaks; the local demo just isn't available on
that URL.

## Deployment Configuration

### netlify.toml

The root `netlify.toml` file configures:

1. **Build command**: `npm install && npm run build`
2. **Publish directory**: `apps/airlock/dist`
3. **Node version**: pinned to `20` via `[build.environment] NODE_VERSION`
   (this repo's `package.json` declares `engines.node: >=20`)
4. **SPA routing**: All requests to `/*` redirect to `/index.html` (status 200)
   — Netlify only applies this when no real file matches the request path, so
   it does not shadow `/assets/*`, `/demo/*`, or `index.html` itself.
5. **Cache headers**: hashed assets (`/assets/*`, `/demo/*`) get
   `max-age=31536000, immutable`; `/` and `/*.html` get
   `max-age=0, must-revalidate`.
6. **Cross-origin isolation headers** on `/assets/*`, `/`, and `/*.html`:
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`.

### apps/airlock/public/_headers

Ships into `dist/_headers` unmodified (confirmed byte-identical after build).
Netlify processes this file in addition to `netlify.toml`'s `[[headers]]`
blocks — both apply, and a header set by more than one matching rule is
something this file is now written to avoid, not rely on undocumented
precedence for. Current rules, verified against the real emitted filenames:

- `/assets/*` — 1-year immutable cache + COOP/COEP.
- `/assets/*.wasm` — same, plus `Content-Type: application/wasm` explicitly
  (Netlify infers this correctly by extension already; explicit is
  belt-and-suspenders).
- `/assets/*worker*.js` — same, plus `Cross-Origin-Resource-Policy:
  cross-origin`. **Fixed in this pass** — was `/assets/*.worker.js`, which
  never matched Vite's actual `*.worker-[hash].js` naming (see
  [`## Fixes made in this pass`](#fixes-made-in-this-pass)).
- `/demo/*` — 1-year immutable cache (no COOP/COEP needed; these are
  same-origin CSV data files, not documents or cross-origin subresources).
- `/*` (catch-all) — COOP/COEP + `X-Content-Type-Options: nosniff` +
  `X-Frame-Options: SAMEORIGIN` + `Referrer-Policy:
  strict-origin-when-cross-origin`, on **every** path including extensionless
  SPA deep links (`/workspace/report`) that `netlify.toml`'s `/` and
  `/*.html` rules don't match. Deliberately carries **no** `Cache-Control` —
  see the fix note below for why.

A note on `X-Frame-Options: SAMEORIGIN`: this blocks Airlock from being
embedded in an `<iframe>` from another origin. That's intentional and
consistent with how WebMCP works here — `document.modelContext` is read by
code running on Airlock's own page (a host browser feature or extension), not
by a remote origin iframing the page. If a future integration needs
cross-origin framing, this header is the first thing to revisit, not
something to drop by default.

### Why COOP/COEP, given today's bundle selection

`engine/duckdb.ts` calls `duckdb.selectBundle({ mvp: {...}, eh: {...} })` —
it never offers the `coi` (cross-origin-isolated, pthread/SharedArrayBuffer)
bundle variant. Reading `selectBundle`'s source confirms `crossOriginIsolated`
is only checked on the `coi` branch, which Airlock's bundle map doesn't
include; the `mvp`/`eh` variants it actually uses are single-threaded and do
not require cross-origin isolation to instantiate. In other words: **today,
DuckDB boots fine without COOP/COEP.** The headers are still the right call —
they're required if a future change opts into the threaded `coi` bundle for
large-dataset performance, they cost nothing for the current bundles, and the
task that specified this deploy path called for them explicitly. Just don't
let anyone conclude from a working local demo *without* these headers that
they're unnecessary; the difference only shows up on the threaded code path,
which isn't wired up.

## Fixes made in this pass

Two real bugs found by testing the actual header behavior against the actual
build output, not by reading the config in isolation:

1. **Worker header rule never matched anything.** `/assets/*.worker.js` in
   `_headers` assumes the hash is appended after a `.worker.js` suffix. Vite's
   real output is `duckdb-browser-eh.worker-hQa-dcAV.js` — the hash is
   inserted before `.js`, not after `.worker`. Confirmed by listing
   `dist/assets/*worker*` after a real build and replaying the old pattern
   against it: zero matches, so the worker scripts got no
   `Cross-Origin-Resource-Policy` header at all. Fixed to
   `/assets/*worker*.js`, re-verified to match both `-eh-` and `-mvp-` worker
   filenames.
2. **The catch-all `/*` block silently clobbered asset caching.** It
   previously set `Cache-Control: public, max-age=0, must-revalidate`. Because
   `/*` matches everything — including `/assets/*` and `/demo/*` — and
   because a small script that replays `_headers` in file order (last
   matching rule wins per header key, which is Netlify's documented behavior)
   showed every hashed asset losing its `immutable` 1-year cache header to
   this rule's `max-age=0` before the fix. Fixed by removing `Cache-Control`
   from the catch-all entirely; HTML cache-control is `netlify.toml`'s job
   (`/` and `/*.html`), and it doesn't overlap `/assets/*` or `/demo/*`.
   Whether or not Netlify's actual precedence algorithm matches the "last
   rule wins" model this was tested against, removing the duplicate,
   conflicting declaration removes the ambiguity either way.

Also added: `NODE_VERSION = "20"` pin in `netlify.toml` (`[build.environment]`)
— previously unset, meaning the build would silently track whatever Node
version was Netlify's account-wide default at build time.

`vite.config.ts`: no change needed. `base` is unset (defaults to `/`), which
is correct for a root-domain deploy — confirmed `dist/index.html` emits
absolute `/assets/...` paths.

## Deployment Steps

### Option 1: Connect GitHub to Netlify (Recommended)

1. Go to [Netlify Dashboard](https://app.netlify.com)
2. Click **"New site from Git"**
3. Connect your GitHub repository, select this repo
4. Netlify auto-detects `netlify.toml` and uses:
   - Build command: `npm install && npm run build`
   - Publish directory: `apps/airlock/dist`
   - Node version: `20` (from `[build.environment]`)
5. Click **Deploy site**. Each push to `main` (or PR) triggers a new
   deployment automatically.

### Option 2: Local Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Authenticate
netlify login

# Link this repo to a Netlify site (first time only)
netlify init

# Build locally first, to fail fast before uploading
npm run build

# Deploy a preview (get a URL to sanity-check before going live)
netlify deploy

# Promote to production once the preview checks out
netlify deploy --prod
```

### Option 3: Manual Build + Upload

```bash
npm install
npm run build
# Upload the contents of apps/airlock/dist to Netlify via the dashboard's
# manual-deploy drag-and-drop, or any other CI/CD that can push a static
# folder to Netlify.
```

## Local pre-deploy checklist

Run this before pushing, to catch config regressions without waiting on a
Netlify build:

```bash
npm run build
npm run typecheck --workspace apps/airlock
npm test

# Confirm the build actually produced the files the header rules target —
# hashes change every build, so re-check the real filenames each time:
find apps/airlock/dist/assets -iname "*.wasm" -o -iname "*worker*"

# Re-audit for external origins after any dependency bump (especially
# @duckdb/duckdb-wasm, marked, dompurify, recharts):
grep -rEo "https?://[a-zA-Z0-9./_%?=&-]+" apps/airlock/dist \
  --include="*.js" --include="*.css" --include="*.html" | sort -u
```

`npm run preview` will boot the app locally and is worth a manual look, but it
does **not** exercise Netlify's `_headers`/`netlify.toml` header rules — Vite's
preview server ignores both files. To check the actual header/MIME behavior
locally without a Netlify account, serve `dist/` with something that applies
`_headers`' rules (the Netlify CLI's `netlify dev` does this correctly; a
plain static server does not, unless you replicate the rules yourself).

## Post-deploy verification checklist

None of the following has been run against a real, live Netlify URL as part
of this pass — do this after the human deploys:

- [ ] Live URL loads (no blank page, no build-time error page).
- [ ] `EmptyState` renders on first load (no dataset loaded yet).
- [ ] Loading the bundled demo CSV works end-to-end (grid populates).
- [ ] DuckDB worker boots with zero console errors — open DevTools before
      loading data, confirm no red errors during or after the worker starts.
- [ ] DevTools Network tab, filtered to the full session (load + demo CSV +
      a couple of agent tool calls if a WebMCP host is available): every
      request's Origin column matches the deploy's own origin. No
      `cdn.jsdelivr.net`, no analytics/telemetry host, nothing else.
- [ ] `document.modelContext` is present in the console
      (`typeof document.modelContext !== "undefined"`) — confirms the WebMCP
      surface registered.
- [ ] `curl -I https://<site>/assets/duckdb-eh-*.wasm` shows
      `Content-Type: application/wasm`.
- [ ] `curl -I https://<site>/` shows `Cross-Origin-Opener-Policy: same-origin`
      and `Cross-Origin-Embedder-Policy: require-corp`.
- [ ] `curl -I https://<site>/assets/duckdb-browser-eh.worker-*.js` (get the
      real hash from the deployed site's HTML/network tab first) shows
      `Cross-Origin-Resource-Policy: cross-origin`.
- [ ] Visiting a deep link directly (e.g. `https://<site>/anything`) loads the
      app instead of a 404.
- [ ] If a WebMCP host is available (ChatGPT desktop, or Chrome with
      `chrome://flags/#enable-webmcp-testing` + the WebMCP Inspector
      extension): the agent can list and call Airlock's tools against the live
      URL.

## Caching Strategy

| Path | Cache | Reason |
|------|-------|--------|
| `/assets/*` | 1 year, immutable | Vite hashes filenames; safe to cache forever |
| `/demo/*` | 1 year, immutable | Demo data is bundled with the build |
| `/*.html`, `/` | no cache | Enables rolling deployments + routing fallback |

**Important**: never cache HTML files. This ensures new versions deploy
immediately when pushed.

## Troubleshooting

### WASM fails to load (MIME type error)

**Symptom**: Browser console shows `Content-Type: text/plain` (or similar) for
`.wasm` files.

**Fix**: Confirm `apps/airlock/public/_headers` (which ships to
`dist/_headers`) still contains an `/assets/*.wasm` block with
`Content-Type: application/wasm`, and that the pattern actually matches — list
`dist/assets/*.wasm` after a build and eyeball it against the pattern.

### SharedArrayBuffer unavailable / COEP errors

Airlock's current bundle selection (`mvp`/`eh`, no `coi`) doesn't require
cross-origin isolation to function (see rationale above). If you see COEP
errors, the more likely cause is a *third-party* subresource that lacks a CORP
header being loaded while COEP is `require-corp` — check the Network tab for
what's actually failing, since Airlock shouldn't be loading any cross-origin
subresource at all.

### SPA routing broken (404 on deep links)

**Fix**: confirm `netlify.toml` still has:
```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### Large WASM files causing slow initial load

Airlock's WASM bundles are ~34–39 MB combined (both `mvp` and `eh` ship; the
browser only fetches whichever `selectBundle()` picks, not both). On slow
networks, initial load can take tens of seconds. Subsequent loads are fast due
to the 1-year immutable cache. `LoadingIndicator.tsx` covers the UX for this.

## Security Considerations

### Zero Egress

All data stays in the browser: DuckDB runs in WASM client-side, the DuckDB
worker/WASM/glue are all self-hosted (see the egress audit above — nothing
resolves to jsdelivr or any other CDN at runtime), and demo data is bundled,
not fetched. `lib/egress.ts` wraps `fetch`/`XMLHttpRequest`/`sendBeacon`/
`WebSocket` and is installed first in `main.tsx`; the Seal in the UI shows its
live count. That monitor only classifies programmatic network calls as
"external" (cross-origin or body-bearing) — it does not intercept the
browser's own resource loading (e.g. `<script>`, `<link>`, `new Worker(url)`
for same-origin URLs), so "Seal reads 0" and "no cross-origin request in the
Network tab" are two different, both-necessary checks; do both from the
post-deploy checklist.

### CSP (Content Security Policy)

Not currently configured. If added, it needs `worker-src 'self' blob:'`
(DuckDB may use `blob:` worker URLs internally) and `script-src 'self'`.

## Domain & HTTPS

- Netlify provides free HTTPS on `*.netlify.app` subdomains.
- For a custom domain, add it in the Netlify dashboard; it auto-provisions a
  Let's Encrypt cert.
- HTTPS is required for `document.modelContext` in most WebMCP host
  implementations (secure-context requirement) — not independently verified
  here, since that requires a live deploy and a real host.

## Environment Variables

None used at runtime. All configuration is compile-time. `netlify.toml` sets
`NODE_ENV=production` per context and pins `NODE_VERSION=20` for the build
environment only — neither is read by the app at runtime.

## Rollback & Versioning

Netlify keeps deployment history automatically. Dashboard → **Deploys** →
select a previous deploy → **Publish deploy**.

---

**Last verified**: 2026-09-02 (this pass, branch `chore/deploy-verify`) —
build + typecheck + tests green, `dist/` egress-audited, header/MIME rules
replayed locally against real emitted filenames. **Not yet verified**: a real
browser session, and any live Netlify deploy.
**Deployment platform**: Netlify
**Build system**: npm workspaces (Node.js >= 20, pinned to 20 for Netlify builds)
**Output**: Static SPA (~34–39 MB with DuckDB-WASM)
