/**
 * Airlock workspace store — the top-level container. Holds every loaded dataset
 * (each with its own `DatasetStore`), tracks which one is active, and owns
 * cross-dataset operations (joins). The human dataset switcher and the agent's
 * `list_datasets` / `join_datasets` tools both go through here.
 */

import {
  createDatasetStore,
  rid,
  type DatasetStore,
  type DatasetViewSnapshot,
  type Origin,
} from "./datasetStore";
import {
  assertIdentifier,
  registerCsv,
  registerJson,
  runQuery,
  runStatement,
} from "./duckdb";
import { rowsToCsv } from "../lib/csv";

export interface DatasetHandle {
  id: string;
  store: DatasetStore;
}

/** One dataset as written to IndexedDB by `lib/persistence.ts`. */
export interface DatasetSnapshot {
  id: string;
  fileName: string;
  source: "file" | "demo" | "join";
  /** Preserved verbatim so chart SQL that names the real table still resolves. */
  tableName: string;
  /** How to rebuild the base table from the saved source bytes. */
  kind: "csv" | "json";
  view: DatasetViewSnapshot;
}

export interface WorkspaceSnapshot {
  activeId: string | null;
  datasets: DatasetSnapshot[];
}

type Listener = () => void;

export interface WorkspaceState {
  datasets: DatasetHandle[];
  activeId: string | null;
  /** Bumps whenever the active dataset's own state changes, so hooks re-read. */
  revision: number;
}

class WorkspaceStore {
  private datasets: DatasetHandle[] = [];
  private activeId: string | null = null;
  private revision = 0;
  private listeners = new Set<Listener>();
  private activeUnsub: (() => void) | null = null;
  /**
   * Raw source bytes per dataset, kept so `lib/persistence.ts` can rebuild the
   * base table on reload from the *exact* bytes the user loaded — the same code
   * path (`registerCsv` / `registerJson`) runs, so restore is deterministic.
   * Populated on every load, dropped on `removeDataset`. Never leaves the tab.
   */
  private sources = new Map<string, { kind: "csv" | "json"; text: string }>();
  private snapshot: WorkspaceState = {
    datasets: [],
    activeId: null,
    revision: 0,
  };

  getState = (): WorkspaceState => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private rebuildSnapshot(): void {
    this.snapshot = {
      datasets: [...this.datasets],
      activeId: this.activeId,
      revision: this.revision,
    };
  }

  private emit(): void {
    this.rebuildSnapshot();
    for (const l of this.listeners) l();
  }

  /** Re-subscribe the workspace to whichever dataset is active. */
  private bindActive(): void {
    this.activeUnsub?.();
    const active = this.getActive();
    if (!active) {
      this.activeUnsub = null;
      return;
    }
    this.activeUnsub = active.store.subscribe(() => {
      this.revision += 1;
      this.emit();
    });
  }

  getActive(): DatasetHandle | null {
    return this.datasets.find((d) => d.id === this.activeId) ?? null;
  }

  getActiveStore(): DatasetStore | null {
    return this.getActive()?.store ?? null;
  }

  get(id: string): DatasetHandle | null {
    return this.datasets.find((d) => d.id === id) ?? null;
  }

  list(): DatasetHandle[] {
    return [...this.datasets];
  }

  setActive(id: string): void {
    if (!this.datasets.some((d) => d.id === id)) return;
    this.activeId = id;
    this.revision += 1;
    this.bindActive();
    void this.syncActiveAlias();
    this.emit();
  }

  /**
   * Keep a stable SQL name, `dataset`, pointing at the active dataset's base
   * table. The real table names carry a unique suffix
   * (`compensation__1a2b3c4d`) so multiple files don't collide, but the agent
   * shouldn't have to discover that — `SELECT * FROM dataset` always works and
   * always means "the table the human is looking at".
   */
  private async syncActiveAlias(): Promise<void> {
    const active = this.getActive();
    if (!active) return;
    const t = active.store.getState().tableName;
    try {
      await runStatement(
        `CREATE OR REPLACE VIEW dataset AS SELECT * FROM "${t.replace(/"/g, '""')}"`
      );
    } catch {
      /* non-fatal — run_sql can still use the real table name */
    }
  }

  private tableNameFor(fileName: string, suffix?: string): string {
    const base = fileName
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "dataset";
    const uniq = suffix ?? String(this.datasets.length + 1);
    return `${base}__${uniq}`;
  }

  private async register(
    handle: DatasetHandle,
    makeActive: boolean
  ): Promise<void> {
    this.datasets = [...this.datasets, handle];
    if (makeActive || this.activeId === null) {
      this.activeId = handle.id;
      this.bindActive();
      await this.syncActiveAlias();
    }
    this.revision += 1;
    this.emit();
  }

  /** Load a user File entirely client-side. */
  async loadFile(file: File): Promise<DatasetHandle> {
    const id = rid();
    const tableName = this.tableNameFor(file.name, id.slice(0, 8));
    const name = file.name.toLowerCase();
    const text = await file.text();

    if (name.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That JSON file could not be parsed.");
      }
      const records = Array.isArray(parsed) ? parsed : [parsed];
      await registerJson(tableName, records as Record<string, unknown>[]);
      // Kept so lib/persistence.ts can rebuild this table on reload.
      this.sources.set(id, { kind: "json", text });
    } else {
      await registerCsv(tableName, text);
      this.sources.set(id, { kind: "csv", text });
    }

    const store = createDatasetStore({
      id,
      tableName,
      fileName: file.name,
      source: "file",
    });
    const handle: DatasetHandle = { id, store };
    await this.register(handle, true);
    await store.onLoaded(file.name);
    return handle;
  }

  /** Load a bundled demo dataset from /public — still entirely client-side. */
  async loadDemo(url: string, fileName: string): Promise<DatasetHandle> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load demo data (${res.status}).`);
    const text = await res.text();
    const id = rid();
    const tableName = this.tableNameFor(fileName, id.slice(0, 8));
    await registerCsv(tableName, text);
    this.sources.set(id, { kind: "csv", text });
    const store = createDatasetStore({
      id,
      tableName,
      fileName,
      source: "demo",
    });
    const handle: DatasetHandle = { id, store };
    await this.register(handle, true);
    await store.onLoaded(fileName);
    return handle;
  }

  async removeDataset(id: string): Promise<void> {
    const handle = this.get(id);
    if (!handle) return;
    await handle.store.destroy();
    this.sources.delete(id);
    this.datasets = this.datasets.filter((d) => d.id !== id);
    if (this.activeId === id) {
      this.activeId = this.datasets[0]?.id ?? null;
      this.bindActive();
      await this.syncActiveAlias();
    }
    this.revision += 1;
    this.emit();
  }

  /**
   * Preview a join without materializing it — returns the resulting row count
   * and column list. Used by `propose_join_datasets`.
   */
  async previewJoin(opts: {
    leftId: string;
    rightId: string;
    on: { left: string; right: string }[];
    type: "inner" | "left";
    /** When set, redacted columns are dropped from the join and cannot be keys. */
    excludeRedacted?: boolean;
  }): Promise<{ rowCount: number; columns: string[]; sql: string }> {
    const left = this.get(opts.leftId);
    const right = this.get(opts.rightId);
    if (!left || !right) throw new Error("Unknown dataset in join.");
    if (opts.on.length === 0) throw new Error("A join needs at least one key pair.");
    const leftState = left.store.getState();
    const rightState = right.store.getState();
    const leftCols = new Set(leftState.columns);
    const rightCols = new Set(rightState.columns);
    const leftRedacted = new Set(
      opts.excludeRedacted ? leftState.redactedColumns : []
    );
    const rightRedacted = new Set(
      opts.excludeRedacted ? rightState.redactedColumns : []
    );
    const lt = `"${leftState.tableName}"`;
    const rt = `"${rightState.tableName}"`;
    const cond = opts.on
      .map((p) => {
        const l = assertIdentifier(p.left);
        const r = assertIdentifier(p.right);
        if (!leftCols.has(l)) throw new Error(`Left dataset has no column "${l}".`);
        if (!rightCols.has(r)) throw new Error(`Right dataset has no column "${r}".`);
        if (leftRedacted.has(l) || rightRedacted.has(r)) {
          throw new Error(`Cannot join on a redacted column ("${l}"/"${r}").`);
        }
        return `l."${l}" = r."${r}"`;
      })
      .join(" AND ");
    const joinKw = opts.type === "left" ? "LEFT JOIN" : "JOIN";
    // Explicit projection when redaction is in play, so redacted values are
    // never copied into the materialized joined table.
    const proj = (alias: "l" | "r", state: typeof leftState, drop: Set<string>): string => {
      const kept = state.columns.filter((c) => !drop.has(c));
      return kept.map((c) => `${alias}."${c.replace(/"/g, '""')}"`).join(", ");
    };
    const projection =
      leftRedacted.size || rightRedacted.size
        ? `${proj("l", leftState, leftRedacted)}, ${proj("r", rightState, rightRedacted)}`
        : "l.*, r.*";
    const sql = `SELECT ${projection} FROM ${lt} l ${joinKw} ${rt} r ON ${cond}`;
    const countRes = await runQuery(
      `SELECT count(*) AS n FROM (${sql})`
    );
    const sample = await runQuery(`${sql} LIMIT 1`);
    return {
      rowCount: Number(countRes.rows[0]?.n ?? 0),
      columns: sample.columns,
      sql,
    };
  }

  /** Materialize a join as a new dataset. */
  async commitJoin(opts: {
    leftId: string;
    rightId: string;
    on: { left: string; right: string }[];
    type: "inner" | "left";
    name?: string;
    origin?: Origin;
    excludeRedacted?: boolean;
  }): Promise<DatasetHandle> {
    const { sql } = await this.previewJoin(opts);
    const left = this.get(opts.leftId)!;
    const right = this.get(opts.rightId)!;
    const fileName =
      opts.name ??
      `${left.store.getState().fileName} ⋈ ${right.store.getState().fileName}`;
    const id = rid();
    const tableName = this.tableNameFor("joined", id.slice(0, 8));
    await runStatement(`CREATE TABLE "${tableName}" AS ${sql}`);
    // Persist the materialized result as CSV so a reload rebuilds it without the
    // source datasets having to be re-joined.
    const dump = await runQuery(`SELECT * FROM "${tableName}"`);
    this.sources.set(id, {
      kind: "csv",
      text: rowsToCsv(dump.columns, dump.rows),
    });
    const store = createDatasetStore({
      id,
      tableName,
      fileName,
      source: "join",
    });
    const handle: DatasetHandle = { id, store };
    await this.register(handle, true);
    await store.onLoaded(fileName);
    return handle;
  }

  // --- Persistence (lib/persistence.ts) ------------------------------------

  /** The saved source bytes for one dataset, or undefined if it can't be rebuilt. */
  getSource(id: string): { kind: "csv" | "json"; text: string } | undefined {
    return this.sources.get(id);
  }

  /** Metadata snapshot for IndexedDB. Bytes are fetched separately via `getSource`. */
  serialize(): WorkspaceSnapshot {
    return {
      activeId: this.activeId,
      datasets: this.datasets
        .filter((h) => this.sources.has(h.id))
        .map((h) => {
          const st = h.store.getState();
          return {
            id: h.id,
            fileName: st.fileName,
            source: st.source,
            tableName: st.tableName,
            kind: this.sources.get(h.id)!.kind,
            view: h.store.serialize(),
          };
        }),
    };
  }

  /**
   * Rebuild the workspace from a saved snapshot: re-register each base table
   * from its bytes, recreate the dataset store, re-profile, then re-apply the
   * view layer. A dataset that fails to restore is skipped so the rest of the
   * session still opens. The caller (`lib/persistence.ts`) has already cleared
   * any existing workspace.
   */
  async hydrate(
    datasets: (DatasetSnapshot & { text: string })[],
    activeId: string | null
  ): Promise<void> {
    for (const d of datasets) {
      try {
        if (d.kind === "json") {
          await registerJson(
            d.tableName,
            JSON.parse(d.text) as Record<string, unknown>[]
          );
        } else {
          await registerCsv(d.tableName, d.text);
        }
        const store = createDatasetStore({
          id: d.id,
          tableName: d.tableName,
          fileName: d.fileName,
          source: d.source,
        });
        const handle: DatasetHandle = { id: d.id, store };
        this.datasets = [...this.datasets, handle];
        this.sources.set(d.id, { kind: d.kind, text: d.text });
        await store.onLoaded(d.fileName);
        await store.hydrate(d.view);
      } catch {
        /* skip this dataset; the rest of the session still loads */
      }
    }
    this.activeId =
      activeId && this.datasets.some((x) => x.id === activeId)
        ? activeId
        : this.datasets[0]?.id ?? null;
    this.bindActive();
    await this.syncActiveAlias();
    this.revision += 1;
    this.emit();
  }
}

export const workspaceStore = new WorkspaceStore();
