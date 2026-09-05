/**
 * Tool-calling surface for the built-in Agent console ("Developer tools").
 *
 * Two transports, one shape. The polyfill's `navigator.modelContextTesting`
 * shim exists only when the polyfill installed — i.e. precisely when there
 * is NO native host. Under a native host the console would otherwise go
 * dead (no shim to call), so it falls back to the host object's own
 * producer-preview surface, `getTools()` / `executeTool()`. Native execution
 * takes the tool object from fresh discovery (not just a name).
 *
 * Either way the calls run the same registered `execute` functions the
 * activity ledger records. Manual calls are not evidence that ChatGPT
 * connected or received any data.
 */

import { classifyHost, onHostAttach } from "./hostAttach";

export interface ConsoleToolInfo {
  name: string;
  description?: string;
}

export interface ConsoleShim {
  listTools: () => Promise<ConsoleToolInfo[]>;
  executeTool: (name: string, argsJson: string) => Promise<unknown>;
}

interface TestingShimHost {
  listTools: () => ConsoleToolInfo[] | Promise<ConsoleToolInfo[]>;
  executeTool: (name: string, argsJson: string) => Promise<unknown>;
}

interface NativeToolInfo {
  name: string;
  description?: string;
  [key: string]: unknown;
}

interface NativeHost {
  __isWebMCPPolyfill?: boolean;
  getTools: () => Promise<NativeToolInfo[]>;
  executeTool: (tool: NativeToolInfo, argsJson: string) => Promise<unknown>;
}

/** The polyfill path — synchronous, present only without a native host. */
export function getTestingShim(): ConsoleShim | null {
  if (typeof navigator === "undefined") return null;
  const t = (
    navigator as unknown as { modelContextTesting?: TestingShimHost }
  ).modelContextTesting;
  if (!t || typeof t.listTools !== "function" || typeof t.executeTool !== "function") {
    return null;
  }
  return {
    listTools: async () => t.listTools(),
    executeTool: async (name, argsJson) => t.executeTool(name, argsJson),
  };
}

/** Resolve against fresh discovery, passing the exact host-owned tool object. */
export async function getNativeShim(): Promise<ConsoleShim | null> {
  if (typeof document === "undefined") return null;
  const mc = (document as unknown as { modelContext?: NativeHost })
    .modelContext;
  if (
    !mc ||
    mc.__isWebMCPPolyfill === true ||
    typeof mc.getTools !== "function" ||
    typeof mc.executeTool !== "function"
  ) {
    return null;
  }
  return {
    listTools: async () =>
      (await mc.getTools()).map((t) => ({ name: t.name, description: t.description })),
    executeTool: async (name, argsJson) => {
      const info = (await mc.getTools()).find((t) => t.name === name);
      if (!info) throw new Error(`Tool not found: ${name}`);
      return mc.executeTool(info, argsJson);
    },
  };
}

/** Never route a live native host's calls through a leftover polyfill shim. */
export async function resolveConsoleShim(): Promise<ConsoleShim | null> {
  const native = await getNativeShim();
  if (native) return native;
  if (typeof document !== "undefined" && classifyHost(document.modelContext) === "native") {
    return null;
  }
  return getTestingShim();
}

/** Listen on the contexts themselves; toolchange need not bubble to document. */
export function subscribeConsoleDiscovery(onChange: () => void): () => void {
  const contexts = (): unknown[] => [
    typeof document === "undefined" ? undefined : document.modelContext,
    typeof navigator === "undefined" ? undefined :
      (navigator as unknown as { modelContext?: unknown }).modelContext,
    typeof navigator === "undefined" ? undefined :
      (navigator as unknown as { modelContextTesting?: unknown }).modelContextTesting,
  ];
  let current: unknown[] = [];
  let cleanups: (() => void)[] = [];
  const bind = () => {
    for (const off of cleanups) off();
    cleanups = [];
    current = contexts();
    for (const context of new Set(current)) {
      const target = context as Partial<EventTarget> | undefined;
      if (typeof target?.addEventListener !== "function" ||
          typeof target.removeEventListener !== "function") continue;
      target.addEventListener("toolchange", onChange);
      cleanups.push(() => target.removeEventListener!("toolchange", onChange));
    }
  };
  const checkContexts = () => {
    if (contexts().some((context, i) => context !== current[i])) {
      bind();
      onChange();
    }
  };
  bind();
  const offAttach = onHostAttach(() => {
    bind();
    onChange();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", checkContexts);
    window.addEventListener("pageshow", checkContexts);
  }
  if (typeof document !== "undefined") {
    document.addEventListener?.("visibilitychange", checkContexts);
  }
  return () => {
    offAttach();
    for (const off of cleanups) off();
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", checkContexts);
      window.removeEventListener("pageshow", checkContexts);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener?.("visibilitychange", checkContexts);
    }
  };
}
