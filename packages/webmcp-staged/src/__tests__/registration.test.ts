import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStagedTool, registerTool } from "../core";
import type { ModelContext } from "../webmcp-types";

const tool = { name: "read_data", description: "Read data", execute: () => {} };
const staged = {
  name: "transform",
  description: "Transform data",
  prepare: () => ({ summary: "Transform", preview: null }),
  commit: () => {},
};
const names = ["propose_transform", "commit_transform", "reject_transform"];
const registrations = [
  { label: "plain", count: 1, register: (options: Parameters<typeof registerTool>[1]) => registerTool(tool, options) },
  { label: "staged", count: 3, register: (options: Parameters<typeof registerTool>[1]) => registerStagedTool(staged, options) },
];

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(registrations)("$label registration", ({ register, count }) => {
  it("resolves ready without a host", async () => {
    vi.stubGlobal("document", undefined);
    const result = register({ mc: null });
    await expect(result.ready).resolves.toBeUndefined();
    expect(() => result.unregister()).not.toThrow();
  });

  it("registers immediately and accepts synchronous undefined results", async () => {
    const host = vi.fn(() => undefined);
    const result = register({ mc: { registerTool: host } });
    expect(host).toHaveBeenCalledTimes(count);
    await expect(result.ready).resolves.toBeUndefined();
  });

  it("waits for every host registration and resolves to void", async () => {
    const pending = Array.from({ length: count }, deferred);
    let index = 0;
    const result = register({ mc: { registerTool: () => pending[index++]!.promise } });
    const settled = vi.fn();
    void result.ready.then(settled);
    for (const registration of pending.slice(0, -1)) registration.resolve("ignored");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    pending[count - 1]!.resolve("ignored");
    await expect(result.ready).resolves.toBeUndefined();
  });

  it.each(["sync", "async"])("swallows %s AbortErrors without logging", async (mode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Hosts can supply cross-realm errors, even without a global DOMException.
    vi.stubGlobal("DOMException", undefined);
    const error = { name: "AbortError", message: "cancelled" };
    const result = register({
      mc: { registerTool: () => {
        if (mode === "sync") throw error;
        return Promise.reject(error);
      } },
    });
    await expect(result.ready).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["external", "unregister", "pre-aborted"])("preserves %s cancellation", async (mode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const external = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    const signals: AbortSignal[] = [];
    const exposedTo = ["https://example.test"];
    if (mode === "pre-aborted") external.abort(reason);
    const mc: ModelContext = {
      registerTool: (_tool, options) => {
        expect(options?.exposedTo).toEqual(exposedTo);
        const signal = options!.signal!;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const result = register({ mc, register: { signal: external.signal, exposedTo } });
    if (mode === "external") external.abort(reason);
    if (mode === "unregister") result.unregister();
    await expect(result.ready).resolves.toBeUndefined();
    expect(signals).toHaveLength(count);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(signal.reason.name).toBe("AbortError");
      if (mode !== "unregister") expect(signal.reason).toBe(reason);
      else expect(signal.reason.message).toBe("tool unregistered");
    }
    result.unregister();
    expect(log).not.toHaveBeenCalled();
    if (mode === "unregister") expect(external.signal.aborted).toBe(false);
  });
});

describe("registration failures", () => {
  it.each(["sync", "async"])("reports a named plain-tool %s failure through ready", async (mode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = registerTool(tool, {
      mc: { registerTool: () => {
        if (mode === "sync") throw new Error("host failed");
        return Promise.reject(new Error("host failed"));
      } },
    });
    await expect(result.ready).rejects.toThrow('registerTool "read_data" failed: host failed');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("read_data"),
    }));
  });

  it.each(names.flatMap((name) => [
    { name, mode: "sync" }, { name, mode: "async" },
  ]))("rolls back the trio on $name $mode failure", async ({ name, mode }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const active = new Set<string>();
    const signals: AbortSignal[] = [];
    const failure = deferred();
    const external = new AbortController();
    const mc: ModelContext = {
      registerTool: (definition, options) => {
        const signal = options!.signal!;
        signals.push(signal);
        active.add(definition.name);
        signal.addEventListener("abort", () => active.delete(definition.name));
        if (definition.name === name) {
          if (mode === "sync") throw new Error("host failed");
          return failure.promise;
        }
        if (definition.name === "propose_transform") return undefined;
        // Rollback must reject ready even if another registration is pending.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    };
    const result = registerStagedTool(staged, { mc, register: { signal: external.signal } });
    if (mode === "async") failure.reject(new Error("host failed"));
    await expect(result.ready).rejects.toThrow(`registerTool "${name}" failed: host failed`);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(active.size).toBe(0);
    expect(external.signal.aborted).toBe(false);
    result.unregister();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("does not roll back siblings for an isolated AbortError", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let signal!: AbortSignal;
    const result = registerStagedTool(staged, {
      mc: { registerTool: (definition, options) => {
        signal = options!.signal!;
        if (definition.name === "commit_transform") {
          return Promise.reject(new DOMException("cancelled", "AbortError"));
        }
      } },
    });
    await expect(result.ready).resolves.toBeUndefined();
    expect(signal.aborted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(registrations)("handles ignored $label rejections but still permits a later await", async ({ register, count }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = register({ mc: { registerTool: () => Promise.reject("host failed") } });
    // Cross an event-loop turn with no consumer handler: Vitest fails on any
    // unhandled rejection, including one from the staged aggregate promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(result.ready).rejects.toThrow("host failed");
    expect(log).toHaveBeenCalledTimes(count);
  });

  it("does not hide a non-abort failure racing with unregister", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred();
    const result = registerStagedTool(staged, {
      mc: { registerTool: () => pending.promise },
    });
    result.unregister();
    pending.reject(new Error("host failed"));
    await expect(result.ready).rejects.toThrow("host failed");
  });
});
