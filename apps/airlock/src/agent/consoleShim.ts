/**
 * Tool-calling surface for the built-in Agent console ("Developer tools").
 *
 * Two transports, one shape. The polyfill's `navigator.modelContextTesting`
 * shim exists only when the polyfill installed — i.e. precisely when there
 * is NO native host. Under a native host the console would otherwise go
 * dead (no shim to call), so it falls back to the host object's own
 * producer-preview surface, `getTools()` / `executeTool()`. Native execution
 * takes the tool object from discovery (not just a name), so the adapter
 * caches one `getTools()` result and resolves names against it.
 *
 * Either way the calls run the same registered `execute` functions the
 * activity ledger records — a host call and a console call are
 * indistinguishable downstream.
 */

export interface ConsoleToolInfo {
  name: string;
  description?: string;
}

export interface ConsoleShim {
  listTools: () => Promise<ConsoleToolInfo[]>;
  executeTool: (name: string, argsJson: string) => Promise<unknown>;
}

interface TestingShimHost {
  listTools: () => ConsoleToolInfo[];
  executeTool: (name: string, argsJson: string) => Promise<unknown>;
}

interface NativeToolInfo {
  name: string;
  description?: string;
  [key: string]: unknown;
}

interface NativeHost {
  getTools: () => Promise<NativeToolInfo[]>;
  executeTool: (tool: NativeToolInfo, argsJson: string) => Promise<unknown>;
}

/** The polyfill path — synchronous, present only without a native host. */
export function getTestingShim(): ConsoleShim | null {
  if (typeof navigator === "undefined") return null;
  const t = (
    navigator as unknown as { modelContextTesting?: TestingShimHost }
  ).modelContextTesting;
  if (!t) return null;
  return {
    listTools: () => Promise.resolve(t.listTools()),
    executeTool: (name, argsJson) => t.executeTool(name, argsJson),
  };
}

/** The native-host path — resolves names against one cached discovery. */
export async function getNativeShim(): Promise<ConsoleShim | null> {
  if (typeof document === "undefined") return null;
  const mc = (document as unknown as { modelContext?: NativeHost })
    .modelContext;
  if (
    !mc ||
    typeof mc.getTools !== "function" ||
    typeof mc.executeTool !== "function"
  ) {
    return null;
  }
  let cache: NativeToolInfo[] | null = null;
  const infos = async (): Promise<NativeToolInfo[]> =>
    (cache ??= await mc.getTools());
  return {
    listTools: async () =>
      (await infos()).map((t) => ({ name: t.name, description: t.description })),
    executeTool: async (name, argsJson) => {
      const info = (await infos()).find((t) => t.name === name);
      if (!info) throw new Error(`Tool not found: ${name}`);
      return mc.executeTool(info, argsJson);
    },
  };
}

/** Testing shim wins when both exist (it is the explicit dev surface). */
export async function resolveConsoleShim(): Promise<ConsoleShim | null> {
  return getTestingShim() ?? (await getNativeShim());
}
