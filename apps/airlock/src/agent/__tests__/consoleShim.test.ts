/**
 * consoleShim — the Agent console's tool transport under both hosts.
 *
 * `navigator`/`document` don't exist under Vitest's node environment, so the
 * DOM-touching paths are driven through minimal fakes installed on
 * `globalThis` (same pattern as hostAttach.test.ts) and removed afterwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as hostAttach from "../hostAttach";
import {
  getTestingShim,
  getNativeShim,
  resolveConsoleShim,
  subscribeConsoleDiscovery,
} from "../consoleShim";

type Globals = {
  navigator?: {
    modelContext?: unknown;
    modelContextTesting?: {
      listTools: () => { name: string; description?: string }[] | Promise<{ name: string }[]>;
      executeTool: (name: string, argsJson: string) => Promise<unknown>;
    };
  };
  document?: {
    modelContext?: unknown;
  } & Partial<EventTarget>;
  window?: EventTarget;
};

function globals(): Globals {
  return globalThis as unknown as Globals;
}

function nativeHost(
  tools: { name: string; description?: string }[] = [
    { name: "profile_column", description: "Profile one column." },
  ]
) {
  return {
    calls: [] as { name: string; argsJson: string }[],
    modelContext: {
      registerTool: () => undefined,
      getTools: () => Promise.resolve(tools.map((t) => ({ ...t }))),
      executeTool: function (
        this: { calls: { name: string; argsJson: string }[] },
        tool: { name: string },
        argsJson: string
      ) {
        this.calls.push({ name: tool.name, argsJson });
        return Promise.resolve(`{"ok":true,"tool":"${tool.name}"}`);
      },
    },
  };
}

describe("consoleShim", () => {
  let savedNavigator: unknown;
  let savedDocument: unknown;
  let savedWindow: unknown;

  beforeEach(() => {
    savedNavigator = globals().navigator;
    savedDocument = globals().document;
    savedWindow = globals().window;
    delete globals().navigator;
    delete globals().document;
    delete globals().window;
  });

  afterEach(() => {
    if (savedNavigator === undefined) delete globals().navigator;
    else globals().navigator = savedNavigator as Globals["navigator"];
    if (savedDocument === undefined) delete globals().document;
    else globals().document = savedDocument as Globals["document"];
    if (savedWindow === undefined) delete globals().window;
    else globals().window = savedWindow as Globals["window"];
    vi.restoreAllMocks();
  });

  it("returns null with no DOM at all", async () => {
    expect(getTestingShim()).toBe(null);
    expect(await getNativeShim()).toBe(null);
    expect(await resolveConsoleShim()).toBe(null);
  });

  it("uses the testing shim when present", async () => {
    globals().navigator = {
      modelContextTesting: {
        listTools: () => [{ name: "run_sql" }],
        executeTool: (name, argsJson) =>
          Promise.resolve(`ran ${name} ${argsJson}`),
      },
    };
    const shim = await resolveConsoleShim();
    expect(shim).not.toBe(null);
    expect(await shim!.listTools()).toEqual([{ name: "run_sql" }]);
    expect(await shim!.executeTool("run_sql", "{}")).toBe("ran run_sql {}");
  });

  it("falls back to the native host surface", async () => {
    const host = nativeHost();
    host.modelContext.executeTool = host.modelContext.executeTool.bind(host);
    globals().document = { modelContext: host.modelContext };

    const shim = await resolveConsoleShim();
    expect(shim).not.toBe(null);
    expect(await shim!.listTools()).toEqual([
      { name: "profile_column", description: "Profile one column." },
    ]);
    const out = await shim!.executeTool(
      "profile_column",
      '{"column":"base_salary"}'
    );
    expect(out).toBe('{"ok":true,"tool":"profile_column"}');
    expect(host.calls).toEqual([
      { name: "profile_column", argsJson: '{"column":"base_salary"}' },
    ]);
  });

  it("native execute rejects unknown tools instead of calling the host", async () => {
    const host = nativeHost();
    host.modelContext.executeTool = host.modelContext.executeTool.bind(host);
    globals().document = { modelContext: host.modelContext };

    const shim = (await getNativeShim())!;
    await expect(shim.executeTool("nope", "{}")).rejects.toThrow(
      "Tool not found: nope"
    );
    expect(host.calls).toEqual([]);
  });

  it("ignores a native-shaped object without discovery", async () => {
    globals().document = {
      modelContext: { registerTool: () => undefined },
    };
    expect(await getNativeShim()).toBe(null);
  });

  it("prefers the live native host over a leftover testing shim", async () => {
    const host = nativeHost();
    host.modelContext.executeTool = host.modelContext.executeTool.bind(host);
    globals().document = { modelContext: host.modelContext };
    globals().navigator = {
      modelContextTesting: {
        listTools: () => [{ name: "from-shim" }],
        executeTool: () => Promise.resolve("shim-result"),
      },
    };
    const shim = await resolveConsoleShim();
    expect(await shim!.listTools()).toEqual([
      { name: "profile_column", description: "Profile one column." },
    ]);
    await shim!.executeTool("profile_column", "{}");
    expect(host.calls).toEqual([{ name: "profile_column", argsJson: "{}" }]);
  });

  it("does not fall back to stale polyfill tools when native preview is unavailable", async () => {
    globals().document = { modelContext: { registerTool: () => undefined } };
    globals().navigator = {
      modelContextTesting: { listTools: () => [{ name: "stale" }], executeTool: vi.fn() },
    };
    expect(await resolveConsoleShim()).toBe(null);
  });

  it("uses the testing shim, not a polyfill's native-shaped surface", async () => {
    globals().document = {
      modelContext: { ...nativeHost().modelContext, __isWebMCPPolyfill: true },
    };
    globals().navigator = {
      modelContextTesting: { listTools: () => [{ name: "testing" }], executeTool: vi.fn() },
    };
    expect(await getNativeShim()).toBe(null);
    expect(await (await resolveConsoleShim())!.listTools()).toEqual([{ name: "testing" }]);
  });

  it.each([
    {},
    { listTools: "invalid", executeTool: () => undefined },
    { listTools: () => [], executeTool: true },
  ])("ignores malformed testing methods: %o", async (testing) => {
    globals().navigator = { modelContextTesting: testing } as unknown as Globals["navigator"];
    expect(getTestingShim()).toBe(null);
    expect(await resolveConsoleShim()).toBe(null);
  });

  it("rediscovers added, replaced and removed native tools and preserves object identity", async () => {
    const first = { name: "first" };
    const replacement = { name: "first", opaqueToken: Symbol("host-owned") };
    const added = { name: "added" };
    let tools = [first];
    const host = {
      getTools: vi.fn(async function (this: unknown) {
        expect(this).toBe(host);
        return tools;
      }),
      executeTool: vi.fn(async function (this: unknown, info: unknown, args: string) {
        expect(this).toBe(host);
        expect(info).toBe(replacement);
        expect(args).toBe("{}");
        return "ok";
      }),
    };
    globals().document = { modelContext: host };
    const shim = (await getNativeShim())!;
    expect(await shim.listTools()).toEqual([{ name: "first" }]);
    tools = [replacement, added];
    expect(await shim.listTools()).toEqual([{ name: "first" }, { name: "added" }]);
    expect(await shim.executeTool("first", "{}")).toBe("ok");
    tools = [];
    await expect(shim.executeTool("first", "{}")).rejects.toThrow("Tool not found: first");
    expect(host.executeTool).toHaveBeenCalledTimes(1);
    expect(await shim.listTools()).toEqual([]);
    expect(host.getTools).toHaveBeenCalledTimes(5);
  });

  it("surfaces native discovery failures and retries without a poisoned cache", async () => {
    const getTools = vi.fn().mockRejectedValueOnce(new Error("Discovery denied"))
      .mockResolvedValueOnce([{ name: "recovered" }])
      .mockRejectedValueOnce(new Error("Host offline"));
    const executeTool = vi.fn();
    globals().document = { modelContext: { getTools, executeTool } };
    const shim = (await getNativeShim())!;
    await expect(shim.listTools()).rejects.toThrow("Discovery denied");
    expect(await shim.listTools()).toEqual([{ name: "recovered" }]);
    await expect(shim.executeTool("recovered", "{}")).rejects.toThrow("Host offline");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("turns synchronous testing failures into rejections and preserves method receivers", async () => {
    const testing = {
      listTools: vi.fn(function (this: unknown) {
        expect(this).toBe(testing);
        throw new Error("Testing discovery denied");
      }),
      executeTool: vi.fn(async function (this: unknown) {
        expect(this).toBe(testing);
        return "ok";
      }),
    };
    globals().navigator = { modelContextTesting: testing };
    const shim = getTestingShim()!;
    await expect(shim.listTools()).rejects.toThrow("Testing discovery denied");
    expect(await shim.executeTool("test", "{}")).toBe("ok");
  });

  it("subscribes to actual contexts, rebinds on attach, and cleans up all listeners", () => {
    let attach = () => {};
    const offAttach = vi.fn();
    vi.spyOn(hostAttach, "onHostAttach").mockImplementation((listener) => {
      attach = listener;
      return offAttach;
    });
    const polyfill = new EventTarget();
    const testing = Object.assign(new EventTarget(), {
      listTools: () => [], executeTool: vi.fn(),
    });
    const native = new EventTarget();
    const doc = Object.assign(new EventTarget(), { modelContext: polyfill });
    const win = new EventTarget();
    const removeDoc = vi.spyOn(doc, "removeEventListener");
    const removeWin = vi.spyOn(win, "removeEventListener");
    globals().document = doc;
    globals().window = win;
    globals().navigator = { modelContext: polyfill, modelContextTesting: testing };
    const changed = vi.fn();
    const off = subscribeConsoleDiscovery(changed);
    polyfill.dispatchEvent(new Event("toolchange"));
    testing.dispatchEvent(new Event("toolchange"));
    doc.dispatchEvent(new Event("toolchange"));
    expect(changed).toHaveBeenCalledTimes(2);

    doc.modelContext = native;
    globals().navigator!.modelContext = native;
    attach();
    expect(changed).toHaveBeenCalledTimes(3);
    polyfill.dispatchEvent(new Event("toolchange"));
    expect(changed).toHaveBeenCalledTimes(3);
    native.dispatchEvent(new Event("toolchange"));
    expect(changed).toHaveBeenCalledTimes(4);

    off();
    native.dispatchEvent(new Event("toolchange"));
    testing.dispatchEvent(new Event("toolchange"));
    expect(changed).toHaveBeenCalledTimes(4);
    expect(offAttach).toHaveBeenCalledOnce();
    expect(removeDoc).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("pageshow", expect.any(Function));
  });

  it("detects replacement and removal on lifecycle events without host-attach notifications", () => {
    const old = new EventTarget();
    const next = new EventTarget();
    const doc = Object.assign(new EventTarget(), { modelContext: old as unknown });
    const win = new EventTarget();
    globals().document = doc;
    globals().window = win;
    const changed = vi.fn();
    const off = subscribeConsoleDiscovery(changed);
    try {
      doc.modelContext = next;
      win.dispatchEvent(new Event("focus"));
      expect(changed).toHaveBeenCalledTimes(1);
      old.dispatchEvent(new Event("toolchange"));
      expect(changed).toHaveBeenCalledTimes(1);
      next.dispatchEvent(new Event("toolchange"));
      expect(changed).toHaveBeenCalledTimes(2);
      doc.modelContext = undefined;
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(changed).toHaveBeenCalledTimes(3);
      win.dispatchEvent(new Event("pageshow"));
      next.dispatchEvent(new Event("toolchange"));
      expect(changed).toHaveBeenCalledTimes(3);
    } finally {
      off();
    }
  });

  it("cleans up safely without DOM or event-capable contexts", () => {
    const off = subscribeConsoleDiscovery(vi.fn());
    off();
    globals().document = { modelContext: { addEventListener: true } };
    expect(() => subscribeConsoleDiscovery(vi.fn())()).not.toThrow();
  });
});
