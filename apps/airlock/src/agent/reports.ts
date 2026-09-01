/**
 * Insight reports — markdown findings documents the agent drafts and the human
 * approves. Workspace-level (a report can reference several datasets), rendered
 * in the Report tab, exportable as `.md`.
 */

import { rid } from "../engine/datasetStore";

export interface InsightReport {
  id: string;
  title: string;
  markdown: string;
  createdAt: number;
  origin: "agent" | "human";
}

type Listener = () => void;

class ReportStore {
  private reports: InsightReport[] = [];
  private listeners = new Set<Listener>();
  private snapshot: InsightReport[] = [];

  getState = (): InsightReport[] => this.snapshot;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit(): void {
    this.snapshot = [...this.reports];
    for (const l of this.listeners) l();
  }

  add(title: string, markdown: string, origin: InsightReport["origin"]): InsightReport {
    const r: InsightReport = {
      id: rid(),
      title,
      markdown,
      createdAt: Date.now(),
      origin,
    };
    this.reports = [r, ...this.reports];
    this.emit();
    return r;
  }

  remove(id: string): void {
    this.reports = this.reports.filter((r) => r.id !== id);
    this.emit();
  }

  list(): InsightReport[] {
    return [...this.reports];
  }

  /** Persistence: replace all reports with a saved set (session restore/switch). */
  hydrate(reports: InsightReport[]): void {
    this.reports = [...reports];
    this.emit();
  }
}

export const reportStore = new ReportStore();
