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
  type Origin,
} from "./datasetStore";
import {
  assertIdentifier,
  registerCsv,
  registerJson,
  runQuery,
  runStatement,
} from "./duckdb";

export interface DatasetHandle {
  id: string;
  store: DatasetStore;
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
    } else {
      await registerCsv(tableName, text);
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
}

export const workspaceStore = new WorkspaceStore();
