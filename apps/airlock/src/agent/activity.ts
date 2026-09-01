/**
 * Agent activity log — the transparency ledger.
 *
 * Every WebMCP tool call (read or write, propose / commit / reject) is appended
 * here with its arguments and a summary of what it returned. This is the honest
 * answer to "the data never leaves your browser, but what does the agent
 * actually see?": every query and every payload the agent received is on this
 * list, and the user can export it.
 */

import { rid } from "../engine/datasetStore";

export type ActivityKind =
  | "read" // a readOnlyHint tool ran
  | "propose" // a change was staged for review
  | "commit" // a staged change was applied after approval
  | "reject" // a staged change was withdrawn / rejected
  | "denied"; // a tool call was refused (e.g. non-SELECT run_sql)

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: ActivityKind;
  tool: string;
  /** Arguments the agent supplied. */
  args: Record<string, unknown>;
  /** Short human-readable result summary. */
  summary: string;
  /** For read tools: how many rows / how many columns were returned to the agent. */
  returned?: { rows?: number; columns?: string[] };
  /** Links this entry to a proposal, when relevant. */
  proposalId?: string;
}

type Listener = () => void;

class ActivityLog {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<Listener>();
  private snapshot: ActivityEntry[] = [];

  getState = (): ActivityEntry[] => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.snapshot = [...this.entries];
    for (const l of this.listeners) l();
  }

  add(entry: Omit<ActivityEntry, "id" | "ts">): ActivityEntry {
    const full: ActivityEntry = { ...entry, id: rid(), ts: Date.now() };
    this.entries = [...this.entries, full];
    this.emit();
    return full;
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }

  /** Distinct columns the agent has ever received data for (read tools). */
  seenColumns(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) {
      for (const c of e.returned?.columns ?? []) set.add(c);
    }
    return [...set];
  }

  /** Total rows handed to the agent across all read calls. */
  rowsDisclosed(): number {
    return this.entries.reduce((n, e) => n + (e.returned?.rows ?? 0), 0);
  }

  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

export const activityLog = new ActivityLog();
