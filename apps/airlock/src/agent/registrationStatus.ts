/**
 * Registration outcomes made visible.
 *
 * `registerTool` / `registerStagedTool` report host rejections through their
 * `ready` promise (and log them), but the app never looked at it: a host that
 * silently rejects some registrations would leave tools missing from
 * discovery with no explanation anywhere in the UI. `useAirlockTools`
 * records one generation per effect run; the Developer tools panel reads the
 * settled issues and names the failing tools next to the discovery count.
 */

import React from "react";

export interface RegistrationIssue {
  tool: string;
  message: string;
}

interface RegistrationSnapshot {
  generation: number;
  settling: boolean;
  issues: RegistrationIssue[];
}

type Listener = () => void;

class RegistrationStatusStore {
  private generation = 0;
  private snapshot: RegistrationSnapshot = {
    generation: 0,
    settling: false,
    issues: [],
  };
  private listeners = new Set<Listener>();

  getState = (): RegistrationSnapshot => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<RegistrationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /** Starts a registration pass; clears the previous pass's issues. */
  beginGeneration(): number {
    this.generation += 1;
    this.set({ generation: this.generation, settling: true, issues: [] });
    return this.generation;
  }

  /** Records a pass's failures; late settlements from a stale pass are dropped. */
  finishGeneration(gen: number, issues: RegistrationIssue[]): void {
    if (gen !== this.generation) return;
    this.set({ settling: false, issues });
  }
}

export const registrationStatus = new RegistrationStatusStore();

export function useRegistrationStatus(): RegistrationSnapshot {
  return React.useSyncExternalStore(
    registrationStatus.subscribe,
    registrationStatus.getState,
    registrationStatus.getState
  );
}
