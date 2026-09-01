/**
 * Airlock dataset store — the single source of truth shared by the human UI and
 * the WebMCP tools the agent calls. Both mutate the same live state, so the
 * grid, charts, and review panel update whether a change comes from a click or
 * an agent tool call.
 *
 * A tiny observable store (no external state lib) with useSyncExternalStore
 * support. One instance per loaded dataset; the set of instances is owned by
 * `workspaceStore`.
 */

import {
  assertExpression,
  assertSelectOnly,
  runQuery,
  runStatement,
  type QueryResult,
} from "./duckdb";

export interface ColumnProfile {
  name: string;
  type: string;
  /** Number of non-null values. */
  count: number;
  nullCount: number;
  distinctCount: number;
  /** Numeric stats when applicable. */
  min?: number;
  max?: number;
  mean?: number;
  /** A few example values for context. */
  samples: string[];
  /** Coarse histogram for the mini-sparkline (numeric columns only). */
  histogram?: number[];
}

export interface ChartSpec {
  id: string;
  title: string;
  kind: "bar" | "line";
  /** SQL that returns exactly two columns: [label, value]. */
  sql: string;
  /** Cached data so charts survive re-renders without re-querying. */
  data?: { label: string; value: number }[];
  /** Who created this chart. */
  origin: Origin;
}

export interface FilterClause {
  id: string;
  /** Raw SQL boolean expression, e.g. `salary > 100000`. */
  expression: string;
  label: string;
  origin: Origin;
}

export interface DerivedColumn {
  id: string;
  name: string;
  /** SQL expression evaluated against the base table. */
  expression: string;
  origin: Origin;
}

export interface FlagSet {
  id: string;
  /** SQL boolean expression identifying the flagged rows. */
  expression: string;
  reason: string;
  count: number;
  origin: Origin;
}

export type Origin = "human" | "agent";

export interface DatasetState {
  id: string;
  /** Whether the dataset has finished importing + profiling. */
  loaded: boolean;
  /** The DuckDB table name for this dataset. */
  tableName: string;
  /** Original file name for display. */
  fileName: string;
  /** How this dataset entered the workspace. */
  source: "file" | "demo" | "join";
  totalRows: number;
  columns: string[];
  columnTypes: Record<string, string>;
  profiles: Record<string, ColumnProfile>;
  /** Display renames: base column name -> shown name. Base table is untouched. */
  renames: Record<string, string>;
  filters: FilterClause[];
  derived: DerivedColumn[];
  flags: FlagSet[];
  charts: ChartSpec[];
  /** The column the human/agent is currently focused on (drives dynamic tools). */
  focusedColumn: string | null;
  /** The most recent query result shown in the grid. */
  view: QueryResult | null;
  /** True while the grid is refreshing. */
  busy: boolean;
  /** Last error, surfaced in the UI. */
  error: string | null;
}

/**
 * The view-level state that `lib/persistence.ts` writes to IndexedDB. Deliberately
 * a subset of `DatasetState`: the base table is rebuilt from the saved source
 * bytes, everything here is layered back on top (see `buildViewSql`).
 */
export interface DatasetViewSnapshot {
  renames: Record<string, string>;
  filters: FilterClause[];
  derived: DerivedColumn[];
  flags: FlagSet[];
  charts: ChartSpec[];
  focusedColumn: string | null;
}

type Listener = () => void;

export interface CreateDatasetOptions {
  id: string;
  tableName: string;
  fileName: string;
  source: DatasetState["source"];
}

function initialState(o: CreateDatasetOptions): DatasetState {
  return {
    id: o.id,
    loaded: false,
    tableName: o.tableName,
    fileName: o.fileName,
    source: o.source,
    totalRows: 0,
    columns: [],
    columnTypes: {},
    profiles: {},
    renames: {},
    filters: [],
    derived: [],
    flags: [],
    charts: [],
    focusedColumn: null,
    view: null,
    busy: false,
    error: null,
  };
}

export class DatasetStore {
  private state: DatasetState;
  private listeners = new Set<Listener>();

  constructor(opts: CreateDatasetOptions) {
    this.state = initialState(opts);
  }

  get id(): string {
    return this.state.id;
  }

  getState = (): DatasetState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<DatasetState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setError(error: string | null): void {
    this.set({ error });
  }

  /** Quote an identifier safely for DuckDB. */
  private q(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  /** The display label for a base column (applies renames). */
  displayName(base: string): string {
    return this.state.renames[base] ?? base;
  }

  /**
   * Build the SQL SELECT for the current view: base table + renames + derived
   * columns, with filters applied. This is what the grid shows and what most
   * read tools query against, so human and agent always see the same shape.
   */
  buildViewSql(limit?: number): string {
    const s = this.state;
    const hasRenames = Object.keys(s.renames).length > 0;

    let selectList: string;
    if (!hasRenames && s.derived.length === 0) {
      selectList = "*";
    } else {
      const baseCols = s.columns.map((c) => {
        const shown = s.renames[c];
        return shown ? `${this.q(c)} AS ${this.q(shown)}` : this.q(c);
      });
      const derivedCols = s.derived.map(
        (d) => `(${d.expression}) AS ${this.q(d.name)}`
      );
      selectList = [...baseCols, ...derivedCols].join(", ") || "*";
    }

    const where =
      s.filters.length > 0
        ? " WHERE " + s.filters.map((f) => `(${f.expression})`).join(" AND ")
        : "";
    const lim = typeof limit === "number" ? ` LIMIT ${limit}` : "";
    return `SELECT ${selectList} FROM ${this.q(s.tableName)}${where}${lim}`;
  }

  /** Re-run the current view query and update the grid + row count. */
  async refreshView(limit = 500): Promise<void> {
    if (!this.state.loaded) return;
    this.set({ busy: true, error: null });
    try {
      const view = await runQuery(this.buildViewSql(limit));
      const countSql = `SELECT count(*) AS n FROM (${this.buildViewSql()})`;
      const countRes = await runQuery(countSql);
      const totalRows = Number(countRes.rows[0]?.n ?? view.rowCount);
      this.set({ view, totalRows, busy: false });
      await this.recountFlags();
    } catch (err) {
      this.set({ busy: false, error: errorMessage(err) });
      throw err;
    }
  }

  /** Called after a fresh import: capture schema and profile every column. */
  async onLoaded(fileName?: string): Promise<void> {
    const schema = await runQuery(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${this.state.tableName}' ORDER BY ordinal_position`
    );
    const columns = schema.rows.map((r) => String(r.column_name));
    const columnTypes: Record<string, string> = {};
    for (const r of schema.rows) {
      columnTypes[String(r.column_name)] = String(r.data_type);
    }
    this.set({
      loaded: true,
      fileName: fileName ?? this.state.fileName,
      columns,
      columnTypes,
      renames: {},
      filters: [],
      derived: [],
      flags: [],
      charts: [],
      focusedColumn: null,
    });
    await this.profileAll();
    await this.refreshView();
  }

  isNumeric(type: string): boolean {
    return /INT|DECIMAL|DOUBLE|FLOAT|REAL|BIGINT|HUGEINT|NUMERIC/i.test(type);
  }

  /** Profile a single column: counts, distinct, numeric stats, samples. */
  async profileColumn(name: string): Promise<ColumnProfile> {
    const s = this.state;
    const type = s.columnTypes[name] ?? "UNKNOWN";
    const col = this.q(name);
    const tbl = this.q(s.tableName);
    const base = await runQuery(
      `SELECT
         count(${col}) AS cnt,
         count(*) - count(${col}) AS nulls,
         count(DISTINCT ${col}) AS distinct_count
       FROM ${tbl}`
    );
    const row = base.rows[0] ?? {};
    const profile: ColumnProfile = {
      name,
      type,
      count: Number(row.cnt ?? 0),
      nullCount: Number(row.nulls ?? 0),
      distinctCount: Number(row.distinct_count ?? 0),
      samples: [],
    };

    if (this.isNumeric(type)) {
      const stats = await runQuery(
        `SELECT min(${col}) AS mn, max(${col}) AS mx, avg(${col}) AS av FROM ${tbl}`
      );
      const sr = stats.rows[0] ?? {};
      profile.min = numOrUndef(sr.mn);
      profile.max = numOrUndef(sr.mx);
      profile.mean = numOrUndef(sr.av);

      if (
        profile.min !== undefined &&
        profile.max !== undefined &&
        profile.max > profile.min
      ) {
        const buckets = 16;
        const hist = await runQuery(
          `SELECT
             least(${buckets - 1},
               floor((${col} - ${profile.min}) /
                 (${(profile.max - profile.min) / buckets}))) AS b,
             count(*) AS n
           FROM ${tbl} WHERE ${col} IS NOT NULL
           GROUP BY b ORDER BY b`
        );
        const arr = new Array(buckets).fill(0);
        for (const r of hist.rows) {
          const b = Number(r.b);
          if (b >= 0 && b < buckets) arr[b] = Number(r.n);
        }
        profile.histogram = arr;
      }
    }

    const samples = await runQuery(
      `SELECT DISTINCT ${col} AS v FROM ${tbl} WHERE ${col} IS NOT NULL LIMIT 5`
    );
    profile.samples = samples.rows.map((r) => String(r.v));
    return profile;
  }

  async profileAll(): Promise<void> {
    const profiles: Record<string, ColumnProfile> = {};
    for (const name of this.state.columns) {
      try {
        profiles[name] = await this.profileColumn(name);
      } catch {
        /* skip columns that fail to profile */
      }
    }
    this.set({ profiles });
  }

  // --- Mutations shared by UI + WebMCP tools ---------------------------------

  setFocusedColumn(name: string | null): void {
    if (name && !this.state.columns.includes(name)) return;
    this.set({ focusedColumn: name });
  }

  async addFilter(
    expression: string,
    label?: string,
    origin: Origin = "human"
  ): Promise<FilterClause> {
    assertExpression(expression);
    const clause: FilterClause = {
      id: rid(),
      expression,
      label: label ?? expression,
      origin,
    };
    this.set({ filters: [...this.state.filters, clause] });
    await this.refreshView();
    return clause;
  }

  async removeFilter(id: string): Promise<void> {
    this.set({ filters: this.state.filters.filter((f) => f.id !== id) });
    await this.refreshView();
  }

  async clearFilters(): Promise<void> {
    this.set({ filters: [] });
    await this.refreshView();
  }

  async addDerivedColumn(
    name: string,
    expression: string,
    origin: Origin = "human"
  ): Promise<DerivedColumn> {
    if (this.state.columns.includes(name)) {
      throw new Error(`Column "${name}" already exists in the base table.`);
    }
    assertExpression(expression);
    const existing = this.state.derived.filter((d) => d.name !== name);
    const col: DerivedColumn = { id: rid(), name, expression, origin };
    this.set({ derived: [...existing, col] });
    await this.refreshView();
    return col;
  }

  async removeDerivedColumn(name: string): Promise<void> {
    this.set({ derived: this.state.derived.filter((d) => d.name !== name) });
    await this.refreshView();
  }

  async renameColumn(
    from: string,
    to: string,
    origin: Origin = "human"
  ): Promise<void> {
    if (!this.state.columns.includes(from)) {
      throw new Error(`No column "${from}" in this dataset.`);
    }
    const taken = new Set([
      ...this.state.columns.filter((c) => c !== from),
      ...Object.entries(this.state.renames)
        .filter(([base]) => base !== from)
        .map(([, shown]) => shown),
      ...this.state.derived.map((d) => d.name),
    ]);
    if (taken.has(to)) {
      throw new Error(`The name "${to}" is already used in this view.`);
    }
    this.set({ renames: { ...this.state.renames, [from]: to } });
    void origin;
    await this.refreshView();
  }

  async removeRename(from: string): Promise<void> {
    const next = { ...this.state.renames };
    delete next[from];
    this.set({ renames: next });
    await this.refreshView();
  }

  async addChart(
    spec: Omit<ChartSpec, "id" | "data" | "origin">,
    origin: Origin = "human"
  ): Promise<ChartSpec> {
    assertSelectOnly(spec.sql);
    const result = await runQuery(spec.sql);
    if (result.columns.length < 2) {
      throw new Error(
        "A chart query must return two columns: a label and a numeric value."
      );
    }
    const [labelCol, valueCol] = result.columns;
    const data = result.rows.map((r) => ({
      label: String(r[labelCol]),
      value: Number(r[valueCol]),
    }));
    const chart: ChartSpec = { ...spec, id: rid(), data, origin };
    this.set({ charts: [...this.state.charts, chart] });
    return chart;
  }

  removeChart(id: string): void {
    this.set({ charts: this.state.charts.filter((c) => c.id !== id) });
  }

  async addFlagSet(
    expression: string,
    reason: string,
    origin: Origin = "human"
  ): Promise<FlagSet> {
    assertExpression(expression);
    const countRes = await runQuery(
      `SELECT count(*) AS n FROM ${this.q(this.state.tableName)} WHERE (${expression})`
    );
    const count = Number(countRes.rows[0]?.n ?? 0);
    const flag: FlagSet = { id: rid(), expression, reason, count, origin };
    this.set({ flags: [...this.state.flags, flag] });
    return flag;
  }

  removeFlagSet(id: string): void {
    this.set({ flags: this.state.flags.filter((f) => f.id !== id) });
  }

  private async recountFlags(): Promise<void> {
    if (this.state.flags.length === 0) return;
    const updated: FlagSet[] = [];
    for (const f of this.state.flags) {
      try {
        const r = await runQuery(
          `SELECT count(*) AS n FROM ${this.q(this.state.tableName)} WHERE (${f.expression})`
        );
        updated.push({ ...f, count: Number(r.rows[0]?.n ?? 0) });
      } catch {
        updated.push(f);
      }
    }
    this.set({ flags: updated });
  }

  /** Row keys (JSON of the row) flagged by any active flag set — for grid tinting. */
  get flaggedExpressions(): string[] {
    return this.state.flags.map((f) => f.expression);
  }

  // --- Persistence (lib/persistence.ts) ------------------------------------

  /** Snapshot the view layer for IndexedDB. Plain data, already serializable. */
  serialize(): DatasetViewSnapshot {
    const { renames, filters, derived, flags, charts, focusedColumn } = this.state;
    return { renames, filters, derived, flags, charts, focusedColumn };
  }

  /**
   * Re-apply a saved view layer onto a freshly-rebuilt base table. Called right
   * after `onLoaded()` on session restore, so the grid ends up identical to the
   * state the user left. `refreshView` re-runs every query and recounts flags.
   */
  async hydrate(v: DatasetViewSnapshot): Promise<void> {
    this.set({
      renames: v.renames ?? {},
      filters: v.filters ?? [],
      derived: v.derived ?? [],
      flags: v.flags ?? [],
      charts: v.charts ?? [],
      focusedColumn: v.focusedColumn ?? null,
    });
    // A bad restored expression surfaces in `state.error`; it must not abort the
    // whole session restore, so don't rethrow here.
    try {
      await this.refreshView();
    } catch {
      /* error is already on state.error via refreshView */
    }
  }

  /** Drop the underlying table (used when a dataset is removed). */
  async destroy(): Promise<void> {
    try {
      await runStatement(`DROP TABLE IF EXISTS ${this.q(this.state.tableName)}`);
    } catch {
      /* ignore */
    }
    this.listeners.clear();
  }
}

export function createDatasetStore(opts: CreateDatasetOptions): DatasetStore {
  return new DatasetStore(opts);
}

function numOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function rid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
