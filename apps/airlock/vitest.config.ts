import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest runs through Vite's module resolution. Mirroring the app's vite.config
// keeps the `?url` asset imports in `duckdb.ts` resolvable (they become harmless
// URL strings) and shares the single React copy with the linked
// `webmcp-staged` workspace package so the guards can be imported directly.
//
// `environment: 'node'` — the trust guards are pure string functions; no DOM is
// needed. `passWithNoTests` is intentionally left at its default (false) so a
// run with zero test files exits non-zero (Requirement 3.6).
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
  },
});
