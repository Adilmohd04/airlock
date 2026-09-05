/**
 * Registration status — pins generation fencing and issue aggregation.
 * Pure store logic; no DOM, runs under Vitest's node environment.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { registrationStatus } from "../registrationStatus";

describe("registrationStatus", () => {
  beforeEach(() => {
    // Reset to a known state through the public API: each begin/finish pair
    // is self-fencing, so priming one empty generation is enough.
    const gen = registrationStatus.beginGeneration();
    registrationStatus.finishGeneration(gen, []);
  });

  it("starts settling with no issues on beginGeneration", () => {
    const gen = registrationStatus.beginGeneration();
    const state = registrationStatus.getState();
    expect(state.generation).toBe(gen);
    expect(state.settling).toBe(true);
    expect(state.issues).toEqual([]);
    registrationStatus.finishGeneration(gen, []);
  });

  it("records failures on finishGeneration", () => {
    const gen = registrationStatus.beginGeneration();
    registrationStatus.finishGeneration(gen, [
      { tool: "commit_add_filter", message: 'registerTool "commit_add_filter" failed: nope' },
    ]);
    const state = registrationStatus.getState();
    expect(state.settling).toBe(false);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]!.tool).toBe("commit_add_filter");
  });

  it("drops late settlements from a superseded generation", () => {
    const stale = registrationStatus.beginGeneration();
    const current = registrationStatus.beginGeneration();
    expect(current).not.toBe(stale);
    registrationStatus.finishGeneration(stale, [
      { tool: "stale_tool", message: "stale failure" },
    ]);
    const state = registrationStatus.getState();
    expect(state.generation).toBe(current);
    expect(state.settling).toBe(true);
    expect(state.issues).toEqual([]);
    registrationStatus.finishGeneration(current, []);
    expect(registrationStatus.getState().settling).toBe(false);
  });

  it("a new generation clears the previous pass's issues", () => {
    const first = registrationStatus.beginGeneration();
    registrationStatus.finishGeneration(first, [
      { tool: "run_sql", message: "failed once" },
    ]);
    expect(registrationStatus.getState().issues).toHaveLength(1);
    const second = registrationStatus.beginGeneration();
    expect(registrationStatus.getState().issues).toEqual([]);
    registrationStatus.finishGeneration(second, []);
  });
});
