/**
 * authority.test.ts — the transport-agnostic gate, pinned directly.
 *
 * The StagedAuthority engine is the single enforcement point of the SAA
 * contract (docs/PROTOCOL.md §2): propose stages, commit requires the human,
 * refusals are auditable, application happens at most once. These tests drive
 * the engine with no transport involved.
 */

import { describe, it, expect, vi } from "vitest";
import {
  StagedAuthority,
  proposeNameFor,
  commitNameFor,
  rejectNameFor,
  type StagedAuditEvent,
} from "../authority";
import { ProposalStore } from "../store";
import type { ToolResult } from "../webmcp-types";

function isError(v: unknown): v is ToolResult {
  return !!v && typeof v === "object" && "isError" in v && (v as ToolResult).isError === true;
}
function text(v: ToolResult): string {
  return v.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

interface Fixture {
  authority: StagedAuthority;
  store: ProposalStore;
  events: StagedAuditEvent[];
  commitCalls: number;
}

function makeFixture(opts: { requireApproval?: boolean } = {}): Fixture {
  const store = new ProposalStore();
  const events: StagedAuditEvent[] = [];
  const state = { commitCalls: 0 };
  const authority = new StagedAuthority({
    store,
    audit: (e) => events.push(e),
    requireApproval: opts.requireApproval ?? true,
  });
  authority.register({
    name: "transform",
    description: "test transform",
    inputSchema: {
      type: "object",
      properties: { col: { type: "string" }, value: {} },
      required: ["col"],
    },
    prepare: (input) => ({ summary: `summary ${String(input.col)}`, preview: input }),
    commit: () => {
      state.commitCalls += 1;
      return `applied transform`;
    },
  });
  authority.register({
    name: "other",
    description: "second action",
    prepare: () => ({ summary: "other", preview: {} }),
    commit: () => "applied other",
  });
  return {
    authority,
    store,
    events,
    get commitCalls() {
      return state.commitCalls;
    },
  };
}

async function proposeStage(
  f: Fixture,
  input: Record<string, unknown> = { col: "a" }
): Promise<string> {
  const result = await f.authority.propose("transform", input);
  expect(isError(result)).toBe(false);
  const id = (result.structuredContent as { proposalId?: string }).proposalId;
  expect(id).toBeTruthy();
  return id as string;
}

describe("propose stages; nothing applies", () => {
  it("returns staged text with the proposalId and a pending proposal in the store", async () => {
    const f = makeFixture();
    const id = await proposeStage(f, { col: "ssn" });
    expect(text(await f.authority.propose("transform", { col: "b" }))).toContain(
      "Awaiting the user's approval"
    );
    const p = f.store.get(id);
    expect(p?.status).toBe("pending");
    expect(p?.toolName).toBe("transform");
    expect(f.commitCalls).toBe(0);
  });

  it("method naming is stable: propose_/commit_/reject_", () => {
    expect(proposeNameFor("transform")).toBe("propose_transform");
    expect(commitNameFor("transform")).toBe("commit_transform");
    expect(rejectNameFor("transform")).toBe("reject_transform");
  });
});

describe("commit requires the Principal", () => {
  it("refuses a pending proposal with an error result and a denied_commit audit event", async () => {
    const f = makeFixture();
    const id = await proposeStage(f);
    const result = await f.authority.commit("transform", id);
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("pending the user's approval");
    expect(f.commitCalls).toBe(0);
    expect(f.store.get(id)?.status).toBe("pending");
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      type: "denied_commit",
      toolName: "transform",
      proposalId: id,
    });
  });

  it("refuses a rejected proposal", async () => {
    const f = makeFixture();
    const id = await proposeStage(f);
    f.store.setStatus(id, "rejected");
    const result = await f.authority.commit("transform", id);
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("rejected");
    expect(f.commitCalls).toBe(0);
  });

  it("refuses an unknown proposalId", async () => {
    const f = makeFixture();
    const result = await f.authority.commit("transform", "absent-123");
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("No proposal absent-123");
    expect(f.events).toHaveLength(1);
  });

  it("refuses an unknown action name", async () => {
    const f = makeFixture();
    const result = await f.authority.commit("nope", "x");
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('Unknown staged action "nope"');
  });

  // Hardening beyond the original WebMCP-bound behavior: a proposal may only
  // be committed by the action that proposed it.
  it("refuses committing one action's proposal through another action", async () => {
    const f = makeFixture();
    const id = await proposeStage(f);
    const result = await f.authority.commit("other", id);
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('belongs to "transform"');
    expect(f.commitCalls).toBe(0);
    expect(f.store.get(id)).toBeDefined();
  });
});

describe("an approved proposal applies at most once", () => {
  it("applies after approval, removes the proposal, and later commits are not-found", async () => {
    const f = makeFixture();
    const id = await proposeStage(f);
    f.store.setStatus(id, "approved");
    const result = await f.authority.commit("transform", id);
    expect(isError(result)).toBe(false);
    expect(text(result)).toBe("applied transform");
    expect(f.commitCalls).toBe(1);
    expect(f.store.get(id)).toBeUndefined();
    expect(f.events).toHaveLength(0);

    const again = await f.authority.commit("transform", id);
    expect(isError(again)).toBe(true);
    expect(f.commitCalls).toBe(1);
  });

  it("restores the proposal and rethrows when commit() throws", async () => {
    const store = new ProposalStore();
    const authority = new StagedAuthority({ store });
    authority.register({
      name: "boom",
      description: "throws",
      prepare: () => ({ summary: "s", preview: {} }),
      commit: () => {
        throw new Error("backend down");
      },
    });
    const staged = await authority.propose("boom", {});
    const id = (staged.structuredContent as { proposalId?: string }).proposalId as string;
    store.setStatus(id, "approved");
    await expect(authority.commit("boom", id)).rejects.toThrow("backend down");
    // Restored for another attempt.
    expect(store.get(id)).toBeDefined();
  });
});

describe("agent-side withdrawal", () => {
  it("reject_ removes the proposal and emits a rejected audit event", async () => {
    const f = makeFixture();
    const id = await proposeStage(f);
    const result = f.authority.reject("transform", id);
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain(`Withdrew proposal ${id}`);
    expect(f.store.get(id)).toBeUndefined();
    expect(f.events).toEqual([
      { type: "rejected", toolName: "transform", proposalId: id },
    ]);
  });

  it("reject_ of an unknown id is an error without audit", async () => {
    const f = makeFixture();
    const result = f.authority.reject("transform", "absent");
    expect(isError(result)).toBe(true);
    expect(f.events).toHaveLength(0);
  });
});

describe("auto-apply mode (requireApproval: false)", () => {
  it("propose applies immediately and returns plain text", async () => {
    const f = makeFixture({ requireApproval: false });
    const result = await f.authority.propose("transform", { col: "x" });
    expect(isError(result)).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toBe("applied transform");
    expect(f.commitCalls).toBe(1);
  });
});

describe("manifest and method resolution", () => {
  it("listActions exposes names, schemas and method triples", () => {
    const f = makeFixture();
    const actions = f.authority.listActions();
    expect(actions.map((a) => a.name)).toEqual(["transform", "other"]);
    const t = actions[0]!;
    expect(t.staged).toBe(true);
    expect(t.methods).toEqual({
      propose: "propose_transform",
      commit: "commit_transform",
      reject: "reject_transform",
    });
    expect(t.inputSchema?.required).toEqual(["col"]);
  });

  it("resolveMethod and hasMethod route the trio", async () => {
    const f = makeFixture();
    await proposeStage(f);
    expect(f.authority.hasMethod("propose_transform")).toBe(true);
    expect(f.authority.hasMethod("commit_transform")).toBe(true);
    expect(f.authority.hasMethod("reject_transform")).toBe(true);
    expect(f.authority.hasMethod("transform")).toBe(false);
    expect(f.authority.resolveMethod("commit_transform")?.verb).toBe("commit");
    expect(f.authority.resolveMethod("nope")).toBeUndefined();
  });
});

describe("audit stream is injectable", () => {
  it("accepts a vi.fn() audit sink", async () => {
    const audit = vi.fn();
    const authority = new StagedAuthority({ audit });
    authority.register({
      name: "t",
      description: "d",
      prepare: () => ({ summary: "s", preview: {} }),
      commit: () => "ok",
    });
    await authority.commit("t", "missing");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      type: "denied_commit",
      toolName: "t",
      proposalId: "missing",
    });
  });
});
