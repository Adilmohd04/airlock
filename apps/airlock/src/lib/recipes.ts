/**
 * Recipes — save an approved transform sequence and replay it on a fresh dataset.
 *
 * An analyst runs the same review every quarter: filter, derive a ratio, rename
 * a column, chart it, flag the outliers. A *recipe* is that sequence captured as
 * a versioned, human-readable, git-diffable JSON file. Load next quarter's CSV,
 * replay the recipe, and the same view is reconstructed.
 *
 * Two hard rules, both load-bearing for the product's thesis:
 *
 *  1. Replay never mutates. `replayRecipe` applies nothing — it stages each step
 *     as a pending Proposal in the SAME review queue the agent's `propose_*`
 *     tools feed, and the human approves (or rejects) each one. A recipe is not a
 *     licence to change the data silently. See `replayRecipe` for the
 *     batch-vs-sequential decision and its justification.
 *
 *  2. A step that references a column the new dataset doesn't have is reported as
 *     skipped, with the missing column named — never dropped in silence.
 *
 * Additive module: reads the dataset store, writes only to the shared
 * `defaultProposalStore` (via the normal proposal path) and the activity ledger.
 */

import { defaultProposalStore, type Proposal } from "webmcp-staged";
import { rid, type DatasetState, type DatasetStore } from "../engine/datasetStore";
import { assertExpression, assertSelectOnly, runQuery } from "../engine/duckdb";
import { activityLog } from "../agent/activity";
import type { ToolPreview } from "../agent/previewTypes";
import { downloadText } from "./csv";

export const RECIPE_VERSION = 1 as const;

/** One transform, in the same vocabulary as the staged write tools. */
export type RecipeStep =
  | { op: "rename_column"; from: string; to: string }
  | { op: "add_derived_column"; name: string; expression: string }
  | { op: "add_filter"; expression: string; label: string }
  | { op: "flag_rows"; expression: string; reason: string }
  | { op: "add_chart"; title: string; chartKind: "bar" | "line"; sql: string };

export interface Recipe {
  version: typeof RECIPE_VERSION;
  name: string;
  /** ISO-8601. Informational — two exports of the same view differ only by this. */
  createdAt: string;
  /**
   * The dataset the recipe was captured from. Used to explain replay skips
   * (which columns a step needs), never to gate replay against a different file.
   */
  source: {
    fileName: string;
    rows: number;
    columns: string[];
  };
  steps: RecipeStep[];
}

// ── capture / serialize ────────────────────────────────────────────────────

/**
 * Snapshot every transform on the current view as an ordered recipe.
 *
 * Step order is fixed (renames, derived columns, filters, flags, charts) rather
 * than capture-order. Every expression is evaluated against the immutable base
 * table — filters and derived columns can't see each other or the renames — so
 * the order is cosmetic for replay, but a deterministic one keeps re-exports of
 * the same view byte-identical and diffable.
 */
export function serializeRecipe(state: DatasetState, name?: string): Recipe {
  const steps: RecipeStep[] = [];

  for (const from of Object.keys(state.renames).sort()) {
    steps.push({ op: "rename_column", from, to: state.renames[from] });
  }
  for (const d of state.derived) {
    steps.push({ op: "add_derived_column", name: d.name, expression: d.expression });
  }
  for (const f of state.filters) {
    steps.push({ op: "add_filter", expression: f.expression, label: f.label });
  }
  for (const f of state.flags) {
    steps.push({ op: "flag_rows", expression: f.expression, reason: f.reason });
  }
  for (const c of state.charts) {
    steps.push({ op: "add_chart", title: c.title, chartKind: c.kind, sql: c.sql });
  }

  return {
    version: RECIPE_VERSION,
    name: name?.trim() || defaultRecipeName(state.fileName),
    createdAt: new Date().toISOString(),
    source: {
      fileName: state.fileName,
      rows: state.totalRows,
      columns: [...state.columns],
    },
    steps,
  };
}

export function recipeToText(recipe: Recipe): string {
  return JSON.stringify(recipe, null, 2) + "\n";
}

/** Export → a `.json` download, straight to the user's Downloads folder. */
export function downloadRecipe(recipe: Recipe): void {
  const slug =
    recipe.name
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "recipe";
  downloadText(`${slug}.recipe.json`, recipeToText(recipe), "application/json");
}

function defaultRecipeName(fileName: string): string {
  return `${fileName.replace(/\.[^.]+$/, "")} recipe`;
}

// ── import / parse ─────────────────────────────────────────────────────────

/**
 * Parse and validate recipe JSON. Throws a plain-language error on anything that
 * isn't a v1 recipe. Forward compatibility is the `version` gate: a future
 * schema bumps the number and this build refuses it cleanly rather than
 * misreading it.
 */
export function parseRecipe(text: string): Recipe {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON, so it isn't an Airlock recipe.");
  }
  if (!isRecord(raw)) throw new Error("A recipe must be a JSON object.");

  if (raw.version !== RECIPE_VERSION) {
    throw new Error(
      typeof raw.version === "number"
        ? `Recipe schema v${raw.version} isn't supported by this build (expected v${RECIPE_VERSION}).`
        : `Recipe is missing its "version" field.`
    );
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error(`Recipe "steps" must be an array.`);
  }

  const steps = raw.steps.map(parseStep);
  const src = isRecord(raw.source) ? raw.source : {};

  return {
    version: RECIPE_VERSION,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : "Untitled recipe",
    createdAt:
      typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    source: {
      fileName: typeof src.fileName === "string" ? src.fileName : "(unknown)",
      rows: typeof src.rows === "number" ? src.rows : 0,
      columns: Array.isArray(src.columns)
        ? src.columns.filter((c): c is string => typeof c === "string")
        : [],
    },
    steps,
  };
}

function parseStep(raw: unknown, i: number): RecipeStep {
  if (!isRecord(raw) || typeof raw.op !== "string") {
    throw new Error(`Step ${i + 1} is missing its "op".`);
  }
  const str = (k: string): string => {
    const v = raw[k];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`Step ${i + 1} (${raw.op}) is missing "${k}".`);
    }
    return v;
  };

  switch (raw.op) {
    case "rename_column":
      return { op: "rename_column", from: str("from"), to: str("to") };
    case "add_derived_column":
      return {
        op: "add_derived_column",
        name: str("name"),
        expression: str("expression"),
      };
    case "add_filter": {
      const expression = str("expression");
      const label =
        typeof raw.label === "string" && raw.label.trim() ? raw.label : expression;
      return { op: "add_filter", expression, label };
    }
    case "flag_rows":
      return { op: "flag_rows", expression: str("expression"), reason: str("reason") };
    case "add_chart":
      return {
        op: "add_chart",
        title: str("title"),
        chartKind: raw.chartKind === "line" ? "line" : "bar",
        sql: str("sql"),
      };
    default:
      throw new Error(`Step ${i + 1} uses an unknown op "${raw.op}".`);
  }
}

// ── replay planning ───────────────────────────────────────────────────────

export interface SkippedStep {
  index: number;
  step: RecipeStep;
  reason: string;
}

export interface ReplayPlan {
  applicable: { index: number; step: RecipeStep }[];
  skipped: SkippedStep[];
}

/**
 * Decide, without touching anything, which steps can replay against `target` and
 * which can't. Pure — the RecipePanel calls this on every render to preview the
 * skip report before the user commits to a replay.
 */
export function planReplay(recipe: Recipe, target: DatasetState): ReplayPlan {
  const applicable: ReplayPlan["applicable"] = [];
  const skipped: SkippedStep[] = [];
  const cols = new Set(target.columns);
  // Without a captured column list we can't detect missing references up front;
  // fall back to the target's own columns (→ no false skips) and let the replay
  // query surface any real "column not found" as a skip reason.
  const vocab = recipe.source.columns.length
    ? recipe.source.columns
    : target.columns;

  recipe.steps.forEach((step, index) => {
    const skip = (reason: string) => skipped.push({ index, step, reason });

    const missing = referencedColumns(step, vocab).filter((c) => !cols.has(c));
    if (missing.length > 0) {
      skip(
        `references ${missing.length > 1 ? "columns" : "column"} not in "${target.fileName}": ` +
          missing.join(", ")
      );
      return;
    }

    if (step.op === "add_derived_column" && cols.has(step.name)) {
      skip(`a base column named "${step.name}" already exists here`);
      return;
    }
    if (step.op === "rename_column" && renameTargetTaken(step, target)) {
      skip(`the name "${step.to}" is already used in this view`);
      return;
    }
    if (alreadyApplied(step, target)) {
      skip("already applied");
      return;
    }

    applicable.push({ index, step });
  });

  return { applicable, skipped };
}

/**
 * Best-effort: which of `vocabulary` are named in this step's SQL. Word-boundary
 * matched, so `id` doesn't match inside `width` and a quoted "spaced name" still
 * resolves.
 */
export function referencedColumns(step: RecipeStep, vocabulary: string[]): string[] {
  if (step.op === "rename_column") return [step.from];
  const sql = step.op === "add_chart" ? step.sql : step.expression;
  return vocabulary.filter((col) => wordPresent(sql, col));
}

function wordPresent(haystack: string, word: string): boolean {
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`
  ).test(haystack);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameTargetTaken(
  step: Extract<RecipeStep, { op: "rename_column" }>,
  target: DatasetState
): boolean {
  const taken = new Set<string>([
    ...target.columns.filter((c) => c !== step.from),
    ...Object.entries(target.renames)
      .filter(([base]) => base !== step.from)
      .map(([, shown]) => shown),
    ...target.derived.map((d) => d.name),
  ]);
  return taken.has(step.to);
}

/** True when the target view already carries an equivalent transform. */
function alreadyApplied(step: RecipeStep, target: DatasetState): boolean {
  switch (step.op) {
    case "rename_column":
      return target.renames[step.from] === step.to;
    case "add_derived_column":
      return target.derived.some(
        (d) => d.name === step.name && d.expression === step.expression
      );
    case "add_filter":
      return target.filters.some((f) => f.expression === step.expression);
    case "flag_rows":
      return target.flags.some((f) => f.expression === step.expression);
    case "add_chart":
      return target.charts.some(
        (c) => c.title === step.title && c.sql === step.sql
      );
    default:
      return false;
  }
}

export function describeStep(step: RecipeStep): string {
  switch (step.op) {
    case "rename_column":
      return `rename ${step.from} → ${step.to}`;
    case "add_derived_column":
      return `column ${step.name} = ${step.expression}`;
    case "add_filter":
      return `filter ${step.label}`;
    case "flag_rows":
      return `flag "${step.reason}"`;
    case "add_chart":
      return `${step.chartKind} chart "${step.title}"`;
  }
}

// ── replay ────────────────────────────────────────────────────────────────

export interface ReplayOutcome {
  /** Proposals added to the review queue, awaiting the human. */
  staged: number;
  /** Steps not staged, each with the reason. Sorted by recipe order. */
  skipped: SkippedStep[];
}

/**
 * REPLAY GOES THROUGH THE REVIEW QUEUE — SEQUENTIALLY, ONE PROPOSAL PER STEP.
 *
 * `replayRecipe` applies nothing. It stages each replayable step as its own
 * pending Proposal in the shared `defaultProposalStore` — the exact queue the
 * agent's `propose_*` tools feed and the human clears in the ReviewPanel. Each
 * proposal carries the same typed `ToolPreview` an agent proposal would, so the
 * human sees real row-count deltas, sample values and chart previews and
 * approves (or rejects) each step.
 *
 * Sequential proposals, NOT one batched proposal, because:
 *   - it reuses the per-tool previews and the registered commit handlers
 *     verbatim — no new commit path, no new preview renderer, nothing that can
 *     drift from the hand-driven tools;
 *   - the human keeps step-level control: approve the filter, reject the chart;
 *   - once approved, a replayed filter is byte-identical to one the agent
 *     proposed or the human clicked — same store mutation, same ledger entry,
 *     same undo.
 * "One click" is the Replay button that stages the batch; approval stays honest.
 */
export async function replayRecipe(
  recipe: Recipe,
  store: DatasetStore
): Promise<ReplayOutcome> {
  const plan = planReplay(recipe, store.getState());
  const skipped: SkippedStep[] = [...plan.skipped];
  let staged = 0;

  for (const { index, step } of plan.applicable) {
    try {
      // buildProposal reads current state each time; when the human approves
      // proposal N the queued N+1 still shows its pre-approval preview — exactly
      // as it would if the agent proposed two changes in a row.
      defaultProposalStore.add(await buildProposal(step, store, recipe));
      activityLog.add({
        kind: "propose",
        tool: "replay_recipe",
        args: { recipe: recipe.name, step: index + 1, op: step.op },
        summary: `Recipe "${recipe.name}": staged ${describeStep(step)} for review`,
      });
      staged += 1;
    } catch (e) {
      skipped.push({ index, step, reason: errText(e) });
    }
  }

  skipped.sort((a, b) => a.index - b.index);
  for (const s of skipped) {
    activityLog.add({
      kind: "denied",
      tool: "replay_recipe",
      args: { recipe: recipe.name, step: s.index + 1, op: s.step.op },
      summary: `Recipe "${recipe.name}": skipped ${describeStep(s.step)} — ${s.reason}`,
    });
  }

  return { staged, skipped };
}

const qi = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/**
 * Build the pending Proposal for one step: the same `input` shape the staged
 * tool's `commit` expects (so `reviewController.applyProposal` routes it to the
 * registered handler untouched) and the same `ToolPreview` its `prepare` would
 * produce. Throws on a bad expression or a query failure — the caller turns that
 * into a skip.
 */
async function buildProposal(
  step: RecipeStep,
  store: DatasetStore,
  recipe: Recipe
): Promise<Proposal> {
  const base = {
    id: rid(),
    createdAt: Date.now(),
    status: "pending" as const,
  };
  const tag = `(recipe "${recipe.name}")`;
  const st = store.getState();

  switch (step.op) {
    case "add_filter": {
      assertExpression(step.expression);
      const rowsBefore = st.totalRows;
      const after = await runQuery(
        `SELECT count(*) AS n FROM (${store.buildViewSql()}) WHERE (${step.expression})`
      );
      const rowsAfter = Number(after.rows[0]?.n ?? 0);
      const preview: ToolPreview = {
        kind: "add_filter",
        expression: step.expression,
        label: step.label,
        rowsBefore,
        rowsAfter,
      };
      return {
        ...base,
        toolName: "add_filter",
        input: { expression: step.expression, label: step.label },
        summary: `Filter ${tag}: ${step.label} — keeps ${rowsAfter.toLocaleString()} of ${rowsBefore.toLocaleString()} rows`,
        preview,
      };
    }

    case "add_derived_column": {
      assertExpression(step.expression);
      if (st.columns.includes(step.name)) {
        throw new Error(`"${step.name}" already exists as a base column`);
      }
      const probe = await runQuery(
        `SELECT *, (${step.expression}) AS ${qi(step.name)} FROM ${qi(st.tableName)} LIMIT 3`
      );
      const samples = probe.rows.map((row) => {
        const slim: Record<string, unknown> = {};
        for (const c of st.columns.slice(0, 3)) slim[c] = row[c];
        return { row: slim, value: row[step.name] };
      });
      const preview: ToolPreview = {
        kind: "add_derived_column",
        name: step.name,
        expression: step.expression,
        samples,
      };
      return {
        ...base,
        toolName: "add_derived_column",
        input: { name: step.name, expression: step.expression },
        summary: `New column ${tag}: ${step.name} = ${step.expression}`,
        preview,
      };
    }

    case "rename_column": {
      const baseCol =
        st.columns.find((c) => c === step.from) ??
        st.columns.find((c) => (st.renames[c] ?? c) === step.from);
      if (!baseCol) throw new Error(`no column "${step.from}"`);
      const preview: ToolPreview = {
        kind: "rename_column",
        from: st.renames[baseCol] ?? baseCol,
        to: step.to,
        type: st.columnTypes[baseCol] ?? "?",
      };
      return {
        ...base,
        toolName: "rename_column",
        input: { from: baseCol, to: step.to },
        summary: `Rename ${tag}: ${step.from} → ${step.to}`,
        preview,
      };
    }

    case "flag_rows": {
      assertExpression(step.expression);
      const cnt = await runQuery(
        `SELECT count(*) AS n FROM ${qi(st.tableName)} WHERE (${step.expression})`
      );
      const sample = await runQuery(
        `SELECT * FROM ${qi(st.tableName)} WHERE (${step.expression}) LIMIT 5`
      );
      const count = Number(cnt.rows[0]?.n ?? 0);
      const preview: ToolPreview = {
        kind: "flag_rows",
        expression: step.expression,
        reason: step.reason,
        count,
        sample: sample.rows,
      };
      return {
        ...base,
        toolName: "flag_rows",
        input: { where: step.expression, reason: step.reason },
        summary: `Flag ${tag}: ${count.toLocaleString()} row(s) — ${step.reason}`,
        preview,
      };
    }

    case "add_chart": {
      const safe = assertSelectOnly(step.sql);
      const res = await runQuery(`SELECT * FROM (${safe}) LIMIT 50`);
      if (res.columns.length < 2) {
        throw new Error("chart query must return a label column and a value column");
      }
      const [l, v] = res.columns;
      const data = res.rows.map((r) => ({
        label: String(r[l]),
        value: Number(r[v]),
      }));
      const preview: ToolPreview = {
        kind: "add_chart",
        title: step.title,
        chartKind: step.chartKind,
        sql: step.sql,
        data,
      };
      return {
        ...base,
        toolName: "add_chart",
        input: { title: step.title, kind: step.chartKind, sql: step.sql },
        summary: `${step.chartKind} chart ${tag}: ${step.title} (${data.length} points)`,
        preview,
      };
    }

    default:
      throw new Error("unrecognised recipe op");
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
