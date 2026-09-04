/**
 * consoleShim — the Agent console's tool transport under both hosts.
 *
 * `navigator`/`document` don't exist under Vitest's node environment, so the
 * DOM-touching paths are driven through minimal fakes installed on
 * `globalThis` (same pattern as hostAttach.test.ts) and removed afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getTestingShim,
  getNativeShim,
  resolveConsoleShim,
} from "../consoleShim";

type Globals = {
  navigator?: {
    modelContextTesting?: {
      listTools: () => { name: string; description?: string }[];
      executeTool: (name: string, argsJson: string) => Promise<unknown>;
    };
  };
  document?: {
    modelContext?: unknown;
  };
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

  beforeEach(() => {
    savedNavigator = globals().navigator;
    savedDocument = globals().document;
    delete globals().navigator;
    delete globals().document;
  });

  afterEach(() => {
    if (savedNavigator === undefined) delete globals().navigator;
    else globals().navigator = savedNavigator as Globals["navigator"];
    if (savedDocument === undefined) delete globals().document;
    else globals().document = savedDocument as Globals["document"];
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

  it("prefers the testing shim when both exist", async () => {
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
    expect(await shim!.listTools()).toEqual([{ name: "from-shim" }]);
    expect(host.calls).toEqual([]);
  });
});
