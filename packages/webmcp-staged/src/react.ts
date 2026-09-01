/**
 * webmcp-staged/react — React bindings
 *
 * Lifecycle-managed WebMCP tool registration for React apps. Tools register on
 * mount and unregister on unmount (via AbortSignal), which is exactly what you
 * want for SPA routes where the available tools depend on the current view.
 */

import * as React from "react";
import { useEffect, useRef, useState } from "react";

// `import { useSyncExternalStore } from "react"` can resolve to `undefined`
// under some bundlers' CJS-interop (esbuild/Vite miss the named re-export that
// React 18 adds). The default/namespace object always carries it.
const useSyncExternalStore: typeof React.useSyncExternalStore =
  React.useSyncExternalStore ??
  (React as unknown as { default: typeof React }).default.useSyncExternalStore;
import {
  ProposalStore,
  defaultProposalStore,
  registerStagedTool,
  registerTool,
  type Proposal,
  type StagedToolConfig,
} from "./core";
import type {
  ModelContext,
  RegisterToolOptions,
  WebMCPToolDefinition,
} from "./webmcp-types";
import { getModelContext } from "./core";

/**
 * Register a plain WebMCP tool for the lifetime of the component.
 *
 * The `tool` is captured on first mount; put changing state behind refs or
 * closures inside `execute` rather than expecting re-registration on every
 * render. Pass a `deps`-like `key` to force re-registration when the tool's
 * shape changes.
 */
export function useWebMCPTool(
  tool: WebMCPToolDefinition,
  options: { register?: RegisterToolOptions; key?: unknown } = {}
): void {
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    const mc = getModelContext();
    if (!mc) return;
    // Wrap execute so the latest closure is always used even though we register
    // once. This keeps tools reading fresh component state.
    const stable: WebMCPToolDefinition = {
      ...toolRef.current,
      execute: (input, opts) => toolRef.current.execute(input, opts),
    };
    const { unregister } = registerTool(stable, {
      mc,
      register: options.register,
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.name, options.key]);
}

/**
 * Register a staged (propose/commit/reject) WebMCP tool for the component's
 * lifetime, backed by a ProposalStore.
 */
export function useStagedTool<TInput extends Record<string, unknown>>(
  config: StagedToolConfig<TInput>,
  options: {
    store?: ProposalStore;
    requireApproval?: boolean;
    register?: RegisterToolOptions;
    key?: unknown;
  } = {}
): void {
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const mc: ModelContext | null = getModelContext();
    if (!mc) return;
    const stable: StagedToolConfig<TInput> = {
      name: configRef.current.name,
      description: configRef.current.description,
      inputSchema: configRef.current.inputSchema,
      prepare: (input) => configRef.current.prepare(input),
      commit: (input, proposal) => configRef.current.commit(input, proposal),
    };
    const { unregister } = registerStagedTool(stable, {
      mc,
      store: options.store ?? defaultProposalStore,
      requireApproval: options.requireApproval,
      register: options.register,
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.name, options.key]);
}

/** Subscribe to a ProposalStore and get the current proposals + actions. */
export function useProposals(store: ProposalStore = defaultProposalStore): {
  proposals: Proposal[];
  pending: Proposal[];
  approve: (id: string) => void;
  reject: (id: string) => void;
  clearResolved: () => void;
} {
  const proposals = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.list(),
    () => store.list()
  );

  return {
    proposals,
    pending: proposals.filter((p) => p.status === "pending"),
    approve: (id) => store.setStatus(id, "approved"),
    reject: (id) => store.setStatus(id, "rejected"),
    clearResolved: () => store.clearResolved(),
  };
}

/** Reactively report whether WebMCP is available in this browser. */
export function useWebMCPAvailable(): boolean {
  const [available, setAvailable] = useState(() => getModelContext() !== null);
  useEffect(() => {
    setAvailable(getModelContext() !== null);
  }, []);
  return available;
}
