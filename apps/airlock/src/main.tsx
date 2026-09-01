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
import { App } from "./App";
import "./index.css";

installEgressMonitor();

async function bootstrap() {
  const hasNativeWebMCP =
    typeof document !== "undefined" &&
    "modelContext" in document &&
    typeof (document as Document).modelContext?.registerTool === "function";

  (window as unknown as { __airlockWebMCP: string }).__airlockWebMCP =
    hasNativeWebMCP ? "native" : "polyfill";

  if (!hasNativeWebMCP) {
    const { initializeWebMCPPolyfill } = await import("@mcp-b/webmcp-polyfill");
    initializeWebMCPPolyfill({
      autoInitialize: true,
      installTestingShim: "if-missing",
    });
  }

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
