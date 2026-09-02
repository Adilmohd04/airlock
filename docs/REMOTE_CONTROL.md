# Remote operation guide — Airlock

How to clone, build, verify, demo and deploy Airlock on a machine that is not
the original dev box (CI box, VM, or an AI-agent remote-control session). Every
step is scripted; nothing depends on local-only state.

## 1. Clone, install, verify (the clean-environment path)

```bash
git clone https://github.com/Adilmohd04/airlock.git
cd airlock
npm install               # workspaces: packages/webmcp-staged + apps/airlock
npm run build:pkg         # builds webmcp-staged/dist first (typecheck needs it)
npm run build             # apps/airlock -> apps/airlock/dist
npm run typecheck --workspace apps/airlock
npm test                  # webmcp-staged 29 + airlock 481+ = 510 passing
```

Requirements: Node >= 20 (pinned to 22 in `netlify.toml`; verified on v22),
npm >= 10. No other system dependencies. Windows, macOS and Linux all work
(the repo is developed on Windows/Git Bash; paths in scripts are POSIX-safe).

## 2. Run the app locally (production build, correct headers)

`vite preview` does NOT apply the Netlify header rules, and WebLLM refuses to
cache model URLs containing `localhost`. Use the shipped static server:

```bash
node scripts/serve-dist.mjs 4173      # binds 127.0.0.1, COOP/COEP + WASM MIME
# open http://127.0.0.1:4173/  (NOT localhost)
```

A missing weight file must return a plain 404 there — that is the behavior the
model-runtime probe depends on (the SPA fallback would read as a broken mirror).

## 3. Model weights (never committed, never fetched from a CDN at runtime)

```bash
node scripts/fetch-models.mjs --deploy  # mirrors the 1.5B deploy default (~841 MB)
node scripts/fetch-models.mjs --check   # verify completeness
```

Weights land in `apps/airlock/public/models/` (gitignored) and are served
same-origin. The browser downloads them once into the Cache API — a real
download, resumable, shown with explicit consent in the UI; after that the
whole agent runs offline.

## 4. Driving the demo remotely (the CDP path)

`scripts/cdp.mjs` is a zero-dependency Chrome DevTools Protocol driver (raw
WebSocket; Node's built-in WebSocket client is rejected by Chrome's DevTools
server). It evaluates JS in the real browser — the same browser a human would
use, WebGPU included:

```bash
# Windows: Chrome 136+ requires a dedicated profile dir for the debug port
chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir=C:\tmp\airlock-profile --no-first-run http://127.0.0.1:4173/

node scripts/cdp.mjs "JSON.stringify({gpu: !!navigator.gpu, seal: document.body.innerText.match(/Sealed[^\n]*/)[0]})"
node scripts/cdp.mjs "(...document.querySelectorAll('button')).find(b=>/local model/i.test(b.innerText)).click()"
```

Anything the UI can do, the driver can do: load the demo CSV, download/run the
model, type the agent goal, approve staged proposals, export the attestation,
and check `/verify.html`. Screenshots via PowerShell (`CopyFromScreen`) work
but are DPI-scaled — physical pixels are `logical × (physicalW / logicalW)`,
typically ×1.5 on Windows.

## 5. Deploy to Netlify

The site is `airlock-webmcp.netlify.app` (site id in the Netlify account of
sadilmohammed0004@gmail.com). Two working paths, both learned the hard way:

- **API zip deploy** (scriptable, no CLI): zip the CONTENTS of
  `apps/airlock/dist` at the zip root (not the folder!), include a
  `_redirects` file (`/models/* /models/:splat 200` then `/* /index.html 200`;
  `public/_redirects` ships with the repo so every build already has it), then
  `POST /api/v1/sites/{site_id}/deploys` with `Content-Type: application/zip`.
  Token: `netlify login` once (authorizes in the browser), then read
  `%APPDATA%/netlify/Config/config.json`.
- **CLI**: `npx netlify deploy --prod --site <id> --dir <ABSOLUTE dist path>
  --no-build`, run from OUTSIDE the git repo — the v27 CLI otherwise detects
  the npm workspaces as "multiple projects" (interactive prompt) and runs the
  netlify.toml build command.

Post-deploy checks: `/_models missing → 404`, `/models/<id>/airlock-manifest.json
→ application/json`, `COOP/COEP on /`, worker `Cross-Origin-Resource-Policy:
cross-origin`, deep links 200 (see `DEPLOY.md` for the full checklist).

## 6. Repo layout / conventions

- `docs/NORTH_STAR.md` (why) → `docs/BUILD_PROMPT.md` (what) →
  `docs/PROTOCOL.md` (the SAA spec) → `COLLAB.md` (working rules + log) →
  `docs/GLM_WORKLOG.md` (the current agent's running log).
- Gates before "done", always: `npm run build`, typecheck, `npm test` — report
  actual numbers.
- `main` only moves by fast-forward merge of a green branch; never
  reset/rebase/force-push it.
