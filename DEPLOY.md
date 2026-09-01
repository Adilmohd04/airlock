# Deployment Guide: Airlock on Netlify

**Airlock** is an agent-native data workspace where agents analyze private tabular data that never leaves your browser (DuckDB-WASM). This guide covers deploying Airlock to Netlify with proper WASM support and security headers.

## Overview

Airlock is built as an npm monorepo with two key parts:
- `packages/webmcp-staged/` — Reusable WebMCP staged action primitive
- `apps/airlock/` — React + Vite application with DuckDB-WASM

The build output is static (no server required). All computation runs client-side with zero egress.

## Prerequisites

- Node.js >= 20
- npm >= 10
- Netlify account and [Netlify CLI](https://cli.netlify.com/) (optional, for local testing)
- Git repository synced with Netlify

## Build Process

The monorepo uses a two-stage build:

```bash
npm install              # Install all workspace dependencies
npm run build            # Builds webmcp-staged, then airlock
                         # Output: apps/airlock/dist/
npm run preview          # Local preview of production build
```

Build artifacts:
- `apps/airlock/dist/index.html` — SPA entry point (never cached)
- `apps/airlock/dist/assets/` — Hashed JS, CSS, WASM bundles (immutable)
- `apps/airlock/dist/demo/` — Bundled demo data (immutable)

DuckDB-WASM assets are large (~34–39 MB total):
- `duckdb-eh-[hash].wasm` (~33 MB, with SIMD)
- `duckdb-mvp-[hash].wasm` (~38 MB, for older browsers)
- `duckdb-[hash].worker.js` (~800 KB each, web worker entrypoints)

## Deployment Configuration

### netlify.toml

The root `netlify.toml` file configures:

1. **Build command**: `npm install && npm run build`
2. **Publish directory**: `apps/airlock/dist`
3. **SPA routing**: All requests to `/*` redirect to `/index.html` (status 200)
4. **Cache headers**:
   - Hashed assets (`/assets/*`, `/demo/*`): `max-age=31536000, immutable` (1 year)
   - Root HTML files: `max-age=0, must-revalidate` (no cache)
5. **WASM security headers**:
   - `Cross-Origin-Opener-Policy: same-origin` (enable SharedArrayBuffer)
   - `Cross-Origin-Embedder-Policy: require-corp` (require explicit cross-origin opt-in)

### apps/airlock/public/_headers

Netlify processes `_headers` file to set per-path HTTP headers. This file:

- **Assets** (`/assets/*`): Immutable cache + COOP/COEP headers + explicit `application/wasm` MIME type
- **Workers** (`/assets/*.worker.js`): `Cross-Origin-Resource-Policy: cross-origin` (required for workers)
- **Root** (`/*`): No-cache, COOP/COEP, security headers (nosniff, SAMEORIGIN, referrer policy)

## Deployment Steps

### Option 1: Connect GitHub to Netlify (Recommended)

1. Go to [Netlify Dashboard](https://app.netlify.com)
2. Click **"New site from Git"**
3. Connect your GitHub repository
4. Netlify auto-detects `netlify.toml` and deploys:
   - Build: `npm install && npm run build`
   - Publish: `apps/airlock/dist`
5. Each push to main (or PR) triggers automatic deployment

### Option 2: Local Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Authenticate
netlify login

# Test build locally
npm run build
npm run preview

# Deploy (from repo root)
netlify deploy --prod
```

### Option 3: Manual Build + Upload

```bash
# Build
npm install
npm run build

# Upload contents of apps/airlock/dist to Netlify
# (via dashboard or other CI/CD)
```

## Verification

After deployment, verify:

1. **WASM assets load correctly**:
   ```bash
   # Check WASM MIME type
   curl -I https://your-site.netlify.app/assets/duckdb-*.wasm | grep Content-Type
   # Expected: Content-Type: application/wasm
   ```

2. **Security headers present**:
   ```bash
   curl -I https://your-site.netlify.app/ | grep -i cross-origin
   # Expected:
   #   Cross-Origin-Opener-Policy: same-origin
   #   Cross-Origin-Embedder-Policy: require-corp
   ```

3. **SPA routing works**:
   - Visit `https://your-site.netlify.app/any/deep/path`
   - Should load Airlock (not 404)

4. **App loads in ChatGPT/WebMCP host** (if deployed):
   - Open ChatGPT with WebMCP enabled
   - Add your Airlock URL as a WebMCP source
   - Verify agent can call tools and analyze data

## Caching Strategy

| Path | Cache | Reason |
|------|-------|--------|
| `/assets/*` | 1 year, immutable | Vite hashes filenames; safe to cache forever |
| `/demo/*` | 1 year, immutable | Demo data is bundled with the build |
| `/*.html` | no cache | Enables rolling deployments + routing fallback |
| `/` | no cache | Forces fresh index.html on each visit |

**Important**: Never cache HTML files. This ensures new versions deploy immediately when pushed.

## Troubleshooting

### WASM fails to load (MIME type error)

**Symptom**: Browser console shows `Content-Type: text/plain` for `.wasm` files.

**Fix**: Ensure `apps/airlock/public/_headers` exists with:
```
/assets/*.wasm
  Content-Type: application/wasm
```

Netlify must process this file during build. If missing, add it and redeploy.

### SharedArrayBuffer unavailable (COEP errors)

**Symptom**: DuckDB-WASM fails with "failed to construct Worker" or security errors.

**Fix**: Verify COEP headers are set in both `netlify.toml` and `_headers`:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers enable SharedArrayBuffer (required for DuckDB worker threads).

### SPA routing broken (404 on deep links)

**Symptom**: Refreshing a deep link (e.g., `/my/dataset`) returns 404.

**Fix**: Ensure `netlify.toml` contains:
```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### Large WASM files causing slow initial load

**Note**: Airlock's WASM bundles are ~34–39 MB. On slower networks (3G), initial load may take 30+ seconds.

**Mitigation**:
- DuckDB supports both `eh` (SIMD) and `mvp` (older CPUs) variants; browser chooses based on support
- Vite bundles both; unused variant is ignored at runtime
- Initial load is slow; subsequent reloads are fast (due to 1-year caching)
- Consider adding a loading indicator in `App.tsx` for UX

## Security Considerations

### Zero Egress
Airlock has zero network traffic after page load (except WebMCP agent tool calls). All data stays in the browser:
- DuckDB runs in WASM (client-side)
- No CDN fetches, no analytics, no telemetry
- Demo data is bundled, not fetched

### COEP & COOP
These headers are **essential** for DuckDB-WASM SharedArrayBuffer support:
- `Cross-Origin-Opener-Policy: same-origin` — Isolates the origin (prevents certain attacks)
- `Cross-Origin-Embedder-Policy: require-corp` — Requires explicit opt-in for cross-origin resources

Both headers must be present for modern browsers to allocate SharedArrayBuffer to web workers.

### CSP (Content Security Policy)
Airlock does not require CSP. If you add CSP, ensure:
- `script-src 'self'` (or add `'unsafe-inline'` if needed for dynamic import polyfill)
- `worker-src 'self' blob:` (DuckDB workers use blob: URIs)

## Domain & HTTPS

- Netlify provides free HTTPS on `*.netlify.app` subdomains
- For a custom domain, add it in Netlify dashboard and auto-provision a Let's Encrypt cert
- HTTPS is **required** for `document.modelContext` (WebMCP host detection)

## Environment Variables

Airlock does not use environment variables at runtime. All configuration is compile-time.

If needed for future deployments:
1. Add to `netlify.toml`:
   ```toml
   [context.production]
     environment = { VAR_NAME = "value" }
   ```
2. Reference in code via `import.meta.env.VAR_NAME`

## Rollback & Versioning

Netlify automatically keeps a deployment history. To rollback:

1. Netlify Dashboard → **Deploys** → click a previous deploy
2. Click **"Publish deploy"** to make it live

No manual intervention needed for rollback.

## Performance Tips

1. **Use `npm run preview`** locally to test production build (includes hashing, minification)
2. **Monitor DuckDB startup** — DuckDB.js initializes on first mount; consider adding a loading spinner
3. **Lazy-load agents** — The WebMCP polyfill loads on first access; this is normal
4. **Check Network tab** — Verify WASM files load with `max-age=31536000`

## Next Steps

1. Ensure `netlify.toml` and `apps/airlock/public/_headers` are committed to git
2. Connect repo to Netlify (GitHub integration preferred)
3. Run `npm run build && npm run preview` locally to verify
4. Push to main → Netlify auto-deploys
5. Verify headers and WASM load with `curl -I`

## Support

For issues:
- Check Netlify deploy logs (Dashboard → **Deploys** → click build)
- Review browser console for WASM loading errors
- Verify `_headers` file is in `apps/airlock/public/` (case-sensitive)
- Confirm `netlify.toml` redirect rule is present (for SPA routing)

---

**Last updated**: 2026-09-01  
**Deployment platform**: Netlify  
**Build system**: npm workspaces (Node.js >= 20)  
**Output**: Static SPA (~34–39 MB with DuckDB-WASM)
