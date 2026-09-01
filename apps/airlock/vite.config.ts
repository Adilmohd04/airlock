import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// DuckDB-WASM ships large .wasm assets and uses web workers. Everything is
// client-side; no server, no uploads. `exclude` keeps Vite's dep optimizer from
// pre-bundling the wasm entrypoints.
//
// `webmcp-staged` is a linked workspace package — `dedupe` makes it share the
// app's single React copy so hooks resolve correctly.
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
  build: {
    target: "es2021",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split large vendor libraries into their own chunks so no single JS
        // app chunk trips Vite's 500 kB advisory. We only group by top-level
        // node_modules package name and stay conservative: `@duckdb/*` is
        // deliberately left out so Vite's own dynamic-import chunking (the lazy
        // `await import("@duckdb/duckdb-wasm")` in duckdb.ts) keeps the engine
        // glue + wasm/worker assets in their own async chunks. We do NOT raise
        // chunkSizeWarningLimit — the advisory must genuinely reflect <500 kB.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          // Never pull the DuckDB glue into a static vendor chunk — leave it to
          // Vite's dynamic-import chunking from the lazy import in duckdb.ts.
          if (id.includes("@duckdb")) return undefined;

          if (id.includes("/react/") || id.includes("/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("/recharts/")) {
            return "vendor-recharts";
          }
          if (id.includes("/marked/") || id.includes("/dompurify/")) {
            return "vendor-markdown";
          }

          return undefined;
        },
      },
    },
  },
});
