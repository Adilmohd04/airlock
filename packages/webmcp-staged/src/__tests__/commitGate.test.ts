/**
 * commitGate.test.ts — Trust-guarantee suite for the propose->commit gate.
 *
 * Feature: submission-hardening (Requirements 5.1-5.6; Properties 7, 8, 9).
 *
 * These tests drive the REAL `registerStagedTool` + `ProposalStore` from the
 * package source (`../core`) through a hand-rolled fake `ModelContext`. Nothing
 * in `core.ts` is modified — the suite is extend-only. Every property runs with
 * fast-check at >= 100 iterations.
 *
 * Behavior pinned directly from core.ts (trusted over the design's assumptions):
 *   - A refused commit returns an *error result* of shape
 *       { content: [{ type: "text", text }], isError: true }
 *     (it does NOT throw).
 *   - The `denied_commit` audit event is
 *       { type: "denied_commit", toolName, proposalId, reason }
 *     where `toolName` is the staged tool's BASE name (config.name), NOT the
 *     "commit_<name>" tool name, and `reason` is a non-empty message string.
 *   - The commit handler removes the proposal from the store BEFORE awaiting
 *     commit(); on a thrown commit it restores the proposal, on success it stays
 *     removed. Hence an approved proposal resolves to `undefined` after a
 *     successful commit and every later call returns a not-found error.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  registerStagedTool,
  ProposalStore,
  type Proposal,
  type StagedAuditEvent,
} from "../core";
import type {
  ModelContext,
  ToolResult,
  WebMCPToolDefinition,
} from "../webmcp-types";

const RUNS = { numRuns: 100 } as const;

/** A recorded tool: the exact definition core.ts registered. */
type RecordedTool = WebMCPToolDefinition;

/**
 * A hand-rolled fake ModelContext whose registerTool records each registered
 * tool by name into a Map, so a test can retrieve
 *   tools.get("commit_<name>")!.execute({ proposalId })
 * and call propose/commit/reject execute functions directly.
 */
function makeFakeMc(): { mc: ModelContext; tools: Map<string, RecordedTool> } {
  const tools = new Map<string, RecordedTool>();
  const mc: ModelContext = {
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      return undefined;
    },
  };
  return { mc, tools };
}

/** Shape of one staged-tool harness. */
interface Harness {
  store: ProposalStore;
  tools: Map<string, RecordedTool>;
  events: StagedAuditEvent[];
  name: string;
  commitCalls: number;
  /** Propose via the real propose_* tool; returns the created proposalId. */
  propose: (input: Record<string, unknown>) => Promise<string>;
  /** Invoke the real commit_* tool. */
  commit: (proposalId: string) => Promise<ToolResult | string | void>;
}

/**
 * Register a staged tool with the real API against a fresh store and fake mc.
 * `commit` is a spy that increments `commitCalls`.
 */
function makeHarness(opts: { name: string; requireApproval?: boolean }): Harness {
  const store = new ProposalStore();
  const { mc, tools } = makeFakeMc();
  const events: StagedAuditEvent[] = [];
  const state = { commitCalls: 0 };

  registerStagedTool(
    {
      name: opts.name,
      description: `test staged tool ${opts.name}`,
      prepare: (input) => ({ summary: `summary for ${opts.name}`, preview: input }),
      commit: () => {
        state.commitCalls += 1;
        return `applied ${opts.name}`;
      },
    },
    {
      store,
      mc,
      requireApproval: opts.requireApproval ?? true,
      audit: (e) => events.push(e),
    }
  );

  const proposeTool = tools.get(`propose_${opts.name}`);
  const commitTool = tools.get(`commit_${opts.name}`);
  if (!proposeTool || !commitTool) {
    throw new Error("staged tools were not registered by the fake mc");
  }

  const harness: Harness = {
    store,
    tools,
    events,
    name: opts.name,
    get commitCalls() {
      return state.commitCalls;
    },
    propose: async (input) => {
      const result = (await proposeTool.execute(input)) as ToolResult;
      // The real propose_* returns structuredContent.proposalId when approval
      // is required; regardless, the store now holds exactly one new proposal.
      const sc = (result as { structuredContent?: { proposalId?: string } })
        .structuredContent;
      if (sc?.proposalId) return sc.proposalId;
      // Auto-approve path (requireApproval:false) doesn't surface an id in
      // structuredContent, so recover it from the store snapshot.
      const all = store.list();
      return all[all.length - 1]!.id;
    },
    commit: (proposalId) => commitTool.execute({ proposalId }),
  } as Harness;

  return harness;
}

/** Type guard: an error ToolResult from core.ts (`isError: true`). */
function isErrorResult(v: unknown): v is ToolResult {
  return (
    !!v &&
    typeof v === "object" &&
    "isError" in v &&
    (v as ToolResult).isError === true &&
    Array.isArray((v as ToolResult).content)
  );
}

function resultText(v: ToolResult): string {
  return v.content.map((c) => c.text).join("");
}

// A generator for harmless proposal inputs (objects; core.ts requires
// TInput extends Record<string, unknown>).
const inputArb = fc.record({
  col: fc.string(),
  value: fc.oneof(fc.string(), fc.integer(), fc.boolean()),
});

describe("commit gate — sanity", () => {
  it("registers propose_/commit_/reject_ tools via the fake ModelContext", () => {
    const h = makeHarness({ name: "transform" });
    expect(h.tools.has("propose_transform")).toBe(true);
    expect(h.tools.has("commit_transform")).toBe(true);
    expect(h.tools.has("reject_transform")).toBe(true);
  });
});

describe("Property 7 — a non-approved proposal can never be committed", () => {
  // Feature: submission-hardening, Property 7: For any pending or rejected
  // proposal, commit_* returns an error result, never calls commit(), and
  // leaves the proposal in the store with its status unchanged.
  // Validates: Requirements 5.1, 5.2.
  it("pending or rejected proposals are refused; commit() not called; status unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb,
        fc.constantFrom<"pending" | "rejected">("pending", "rejected"),
        async (input, targetStatus) => {
          const h = makeHarness({ name: "transform" });
          const id = await h.propose(input);

          // Proposals start "pending"; drive to "rejected" for that variant.
          if (targetStatus === "rejected") {
            h.store.setStatus(id, "rejected");
          }
          expect(h.store.get(id)?.status).toBe(targetStatus);

          const before = h.commitCalls;
          const result = await h.commit(id);

          // Error result (core.ts returns, never throws) whose reason mentions
          // not-approved (pending) / rejected.
          expect(isErrorResult(result)).toBe(true);
          expect(resultText(result as ToolResult).length).toBeGreaterThan(0);

          // commit() spy was NOT invoked.
          expect(h.commitCalls).toBe(before);

          // Proposal still present with unchanged status.
          const still = h.store.get(id);
          expect(still).toBeDefined();
          expect(still!.status).toBe(targetStatus);
        }
      ),
      RUNS
    );
  });
});

describe("Property 9 — every refused commit emits exactly one matching audit event", () => {
  // Feature: submission-hardening, Property 9: For any refusal path (missing /
  // pending / rejected), exactly one denied_commit event is emitted, carrying
  // the tool name, the supplied proposalId, and a non-empty reason.
  // Validates: Requirements 5.3, 5.6.
  it("each refusal path emits exactly one denied_commit with correct fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb,
        fc.constantFrom<"missing" | "pending" | "rejected">(
          "missing",
          "pending",
          "rejected"
        ),
        fc.string(),
        async (input, path, missingId) => {
          const h = makeHarness({ name: "transform" });

          let proposalId: string;
          if (path === "missing") {
            // Use an id that does not exist in the store.
            proposalId = `absent-${missingId}`;
            // Guard: ensure it truly isn't present.
            fc.pre(h.store.get(proposalId) === undefined);
          } else {
            proposalId = await h.propose(input);
            if (path === "rejected") h.store.setStatus(proposalId, "rejected");
          }

          const result = await h.commit(proposalId);
          expect(isErrorResult(result)).toBe(true);

          // Exactly one denied_commit event.
          const denied = h.events.filter((e) => e.type === "denied_commit");
          expect(denied).toHaveLength(1);

          const evt = denied[0] as Extract<
            StagedAuditEvent,
            { type: "denied_commit" }
          >;
          // toolName is the base name (config.name), per core.ts.
          expect(evt.toolName).toBe("transform");
          expect(evt.proposalId).toBe(proposalId);
          expect(typeof evt.reason).toBe("string");
          expect(evt.reason.length).toBeGreaterThan(0);
        }
      ),
      RUNS
    );
  });

  // Feature: submission-hardening, Property 9 (metamorphic): K mixed refusals
  // produce exactly K denied_commit events.
  // Validates: Requirements 5.3, 5.6.
  it("K mixed refusals yield exactly K denied_commit events", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<"missing" | "pending" | "rejected">(
            "missing",
            "pending",
            "rejected"
          ),
          { minLength: 1, maxLength: 8 }
        ),
        async (paths) => {
          const h = makeHarness({ name: "transform" });
          let missingCounter = 0;

          for (const path of paths) {
            let proposalId: string;
            if (path === "missing") {
              proposalId = `absent-${missingCounter++}`;
            } else {
              proposalId = await h.propose({ col: "c", value: 1 });
              if (path === "rejected") h.store.setStatus(proposalId, "rejected");
            }
            const result = await h.commit(proposalId);
            expect(isErrorResult(result)).toBe(true);
          }

          const denied = h.events.filter((e) => e.type === "denied_commit");
          expect(denied).toHaveLength(paths.length);
        }
      ),
      RUNS
    );
  });
});

describe("Property 8 — an approved proposal applies at most once, then no longer resolves", () => {
  // Feature: submission-hardening, Property 8: For an approved proposal, across
  // sequential commit_* invocations for its proposalId, commit() runs <= 1 time
  // total; after the first success the proposalId no longer resolves and every
  // later call returns a not-found error.
  // Validates: Requirements 5.4, 5.5.
  // NOTE ON API BEHAVIOR: with `requireApproval:false`, the real propose_*
  // tool auto-commits *inside* the propose call and removes the proposal before
  // returning (and does not surface the proposalId in structuredContent), so
  // that mode does not exercise commit_* on a stored "approved" proposal. To
  // genuinely test Property 8's "commit_* invoked for an approved proposal"
  // path, we drive the proposal to "approved" via the real store.setStatus API
  // and then invoke commit_* directly — the API surface the property is about.
  it("sequential commits apply once; store.get(id) is undefined; second call is not-found", async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArb,
        // Number of extra (post-first) sequential commit attempts.
        fc.integer({ min: 1, max: 4 }),
        async (input, extraCalls) => {
          const h = makeHarness({ name: "transform", requireApproval: true });

          const id = await h.propose(input);

          // Human-approval flow: drive to approved via the real store API,
          // then commit once through the real commit_* tool.
          h.store.setStatus(id, "approved");
          expect(h.store.get(id)?.status).toBe("approved");

          const first = await h.commit(id);
          // First commit succeeds (not an error result) and applies once.
          expect(isErrorResult(first)).toBe(false);
          expect(h.commitCalls).toBe(1);
          expect(h.store.get(id)).toBeUndefined();

          // Every subsequent sequential commit is a not-found error and does
          // not apply again.
          for (let i = 0; i < extraCalls; i++) {
            const again = await h.commit(id);
            expect(isErrorResult(again)).toBe(true);
            expect(resultText(again as ToolResult).toLowerCase()).toContain(
              "no proposal"
            );
          }

          // commit() total invocations never exceed one.
          expect(h.commitCalls).toBeLessThanOrEqual(1);
          expect(h.commitCalls).toBe(1);

          // proposalId no longer resolves.
          expect(h.store.get(id)).toBeUndefined();
        }
      ),
      RUNS
    );
  });
});
