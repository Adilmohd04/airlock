/**
 * Airlock entry point.
 *
 * Order matters:
 *   1. Install the egress monitor before any other module can capture `fetch`.
 *   2. Detect a NATIVE `document.modelContext` (ChatGPT / Chrome WebMCP) *before*
 *      importing the polyfill — the polyfill self-installs on import, which would
 *      otherwise make every environment look "native".
 *   3. Load the polyfill only when there is no native host, so the agent in a
 *      real host always sees our real tools.
 *   4. Mount React.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installEgressMonitor } from "./lib/egress";
import { agentModeStore } from "./agent/agentMode";
import {
  classifyHost,
  removeNonFunctionalStub,
  revealNativePrototypeHost,
} from "./agent/hostAttach";
import { App } from "./App";
import "./index.css";

installEgressMonitor();

/**
 * Opt into Chrome's WebMCP origin trial when a token is supplied at build
 * time (`VITE_WEBMCP_ORIGIN_TRIAL_TOKEN`). Without it, Chrome-stable has no
 * WebMCP API and the app runs on the polyfill; with the testing flag or a
 * native host, this is a no-op extra tag. The token is origin-bound and
 * public by design — it carries no secret, so committing the *plumbing* is
 * safe; the value itself stays in the deploy environment, never in git.
 */
function installOriginTrialToken(): void {
  const token = import.meta.env.VITE_WEBMCP_ORIGIN_TRIAL_TOKEN as
    | string
    | undefined;
  if (!token || document.querySelector('meta[http-equiv="origin-trial"]')) return;
  const meta = document.createElement("meta");
  meta.httpEquiv = "origin-trial";
  meta.content = token;
  document.head.append(meta);
}

installOriginTrialToken();

async function bootstrap() {
  // Presence of the API is NOT a connected host: with
  // chrome://flags/#enable-webmcp-testing on, `modelContext` exists with zero
  // agents attached. Status copy must key "connected" off actual tool calls
  // (the activity ledger), never off this flag — see agentMode.describeMode.
  const hasNativeWebMCP =
    typeof document !== "undefined" &&
    "modelContext" in document &&
    typeof (document as Document).modelContext?.registerTool === "function";

  (window as unknown as { __airlockWebMCP: string }).__airlockWebMCP =
    hasNativeWebMCP ? "native" : "polyfill";

  if (!hasNativeWebMCP) {
    // A dead stub would block the polyfill below (it never shadows an
    // existing property) while being callable by nobody — clear it first.
    removeNonFunctionalStub();
    const { initializeWebMCPPolyfill } = await import("@mcp-b/webmcp-polyfill");
    initializeWebMCPPolyfill({
      autoInitialize: true,
      installTestingShim: "if-missing",
    });
    // A host can appear while the polyfill chunk was loading — re-probe the
    // live instance (never the polyfill itself) before freezing the flag.
    // This also unshadows a native prototype getter the polyfill install
    // may have just covered.
    revealNativePrototypeHost();
    if (
      classifyHost((document as Document).modelContext as unknown) ===
      "native"
    ) {
      (window as unknown as { __airlockWebMCP: string }).__airlockWebMCP =
        "native";
    }
  }

  // Sync the store with the flag. Without this the pill reads boot-time
  // module state forever — even a host present from page load would show
  // "not connected", and no transition watcher could ever fire for it.
  agentModeStore.refreshDetection();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

bootstrap().catch((err) => {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<div style="padding:2rem;font-family:system-ui;color:#e5575c">
      <h1 style="font-size:1rem">Airlock failed to start</h1>
      <pre style="white-space:pre-wrap;color:#97abc0;font-size:12px">${String(
        err instanceof Error ? err.stack || err.message : err
      ).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</pre>
    </div>`;
  }
  console.error("[airlock] bootstrap failed", err);
});
