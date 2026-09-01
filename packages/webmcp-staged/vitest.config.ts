import { defineConfig } from "vitest/config";

// The commit-gate tests hand-roll a fake ModelContext, so no DOM/jsdom is
// required. `environment: 'node'` keeps the runner dependency-free.
//
// `passWithNoTests` is intentionally left at its default (false) so a run with
// zero test files exits non-zero (Requirement 3.6).
export default defineConfig({
  test: {
    environment: "node",
  },
});
