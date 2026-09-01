/**
 * Recipe serialization / parsing / replay-planning tests.
 *
 * These cover the pure surface of `lib/recipes.ts` — capture, round-trip,
 * validation, and the "which steps replay / which are skipped and why" planner.
 * The `replayRecipe` path needs DuckDB-WASM and the DOM proposal store, so it is
 * exercised in-browser, not here.
 */

import { describe, it, expect } from "vitest";
import type { DatasetState } from "../engine/datasetStore";
import {
  RECIPE_VERSION,
  describeStep,
  parseRecipe,
  planReplay,
  recipeToText,
  referencedColumns,
  serializeRecipe,
  type Recipe,
  type RecipeStep,
} from "./recipes";

// A DatasetState with everything empty; override the parts a test cares about.
function mkState(over: Partial<DatasetState> = {}): DatasetState {
  return {
    id: "d1",
    loaded: true,
    tableName: "t__1",
    fileName: "compensation.csv",
    source: "file",
    totalRows: 800,
    columns: ["employee_id", "department", "base_salary", "market_median"],
    columnTypes: {
      employee_id: "VARCHAR",
      department: "VARCHAR",
      base_salary: "DOUBLE",
      market_median: "DOUBLE",
    },
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
    ...over,
  };
}

const fullState = (): DatasetState =>
  mkState({
    renames: { department: "Team" },
    derived: [
      {
        id: "1",
        name: "comp_ratio",
        expression: "round(base_salary / market_median, 3)",
        origin: "agent",
      },
    ],
    filters: [
      {
        id: "2",
        expression: "base_salary > 100000",
        label: "six figures",
        origin: "human",
      },
    ],
    flags: [
      {
        id: "3",
        expression: "base_salary < market_median * 0.8",
        reason: "paid >20% below market",
        count: 12,
        origin: "agent",
      },
    ],
    charts: [
      {
        id: "4",
        title: "Avg comp ratio by department",
        kind: "bar",
        sql: "SELECT department, avg(base_salary / market_median) FROM dataset GROUP BY 1",
        origin: "agent",
      },
    ],
  });

describe("serializeRecipe", () => {
  it("captures a versioned, ordered recipe of every transform type", () => {
    const recipe = serializeRecipe(fullState());
    expect(recipe.version).toBe(RECIPE_VERSION);
    expect(recipe.source.fileName).toBe("compensation.csv");
    expect(recipe.source.columns).toEqual([
      "employee_id",
      "department",
      "base_salary",
      "market_median",
    ]);
    expect(recipe.steps.map((s) => s.op)).toEqual([
      "rename_column",
      "add_derived_column",
      "add_filter",
      "flag_rows",
      "add_chart",
    ]);
  });

  it("uses a stable name and a fresh ISO timestamp", () => {
    const recipe = serializeRecipe(mkState());
    expect(recipe.name).toBe("compensation recipe");
    expect(() => new Date(recipe.createdAt).toISOString()).not.toThrow();
    expect(recipe.createdAt).toBe(new Date(recipe.createdAt).toISOString());
  });

  it("honours an explicit name", () => {
    expect(serializeRecipe(mkState(), "  Q3 comp review  ").name).toBe(
      "Q3 comp review"
    );
  });

  it("emits pretty-printed, newline-terminated JSON", () => {
    const text = recipeToText(serializeRecipe(mkState()));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 1');
  });
});

describe("parseRecipe round-trip", () => {
  it("re-parses a serialized recipe to an equal value", () => {
    const recipe = serializeRecipe(fullState(), "roundtrip");
    expect(parseRecipe(recipeToText(recipe))).toEqual(recipe);
  });

  it("accepts a minimal hand-written recipe and fills defaults", () => {
    const recipe = parseRecipe(
      JSON.stringify({
        version: 1,
        steps: [{ op: "add_filter", expression: "base_salary > 0" }],
      })
    );
    expect(recipe.name).toBe("Untitled recipe");
    expect(recipe.source.columns).toEqual([]);
    expect(recipe.steps[0]).toEqual({
      op: "add_filter",
      expression: "base_salary > 0",
      label: "base_salary > 0", // label defaults to the expression
    });
  });

  it("defaults an unrecognised chartKind to bar", () => {
    const recipe = parseRecipe(
      JSON.stringify({
        version: 1,
        steps: [{ op: "add_chart", title: "x", sql: "SELECT a, b FROM dataset", chartKind: "pie" }],
      })
    );
    expect((recipe.steps[0] as Extract<RecipeStep, { op: "add_chart" }>).chartKind).toBe(
      "bar"
    );
  });
});

describe("parseRecipe validation", () => {
  it.each([
    ["not json", "{{{", /isn't valid JSON/],
    ["a JSON array", "[]", /must be a JSON object/],
    ["missing version", JSON.stringify({ steps: [] }), /missing its "version"/],
    ["a future version", JSON.stringify({ version: 2, steps: [] }), /v2 isn't supported/],
    ["missing steps", JSON.stringify({ version: 1 }), /"steps" must be an array/],
    [
      "a step with no op",
      JSON.stringify({ version: 1, steps: [{ expression: "x" }] }),
      /Step 1 is missing its "op"/,
    ],
    [
      "an unknown op",
      JSON.stringify({ version: 1, steps: [{ op: "delete_rows" }] }),
      /unknown op "delete_rows"/,
    ],
    [
      "a step missing a required field",
      JSON.stringify({ version: 1, steps: [{ op: "rename_column", from: "a" }] }),
      /Step 1 \(rename_column\) is missing "to"/,
    ],
  ])("rejects %s", (_label, text, pattern) => {
    expect(() => parseRecipe(text)).toThrow(pattern as RegExp);
  });
});

describe("referencedColumns", () => {
  const vocab = ["base_salary", "market_median", "id", "department"];

  it("word-boundary matches identifiers, not substrings", () => {
    const step: RecipeStep = {
      op: "add_filter",
      expression: "base_salary > market_median",
      label: "x",
    };
    // `id` must not match inside `market_median`
    expect(referencedColumns(step, vocab).sort()).toEqual([
      "base_salary",
      "market_median",
    ]);
  });

  it("resolves a quoted column name with a space", () => {
    const step: RecipeStep = {
      op: "add_chart",
      chartKind: "bar",
      title: "t",
      sql: 'SELECT "head count" FROM dataset',
    };
    expect(referencedColumns(step, ["head count", "id"])).toEqual(["head count"]);
  });

  it("returns the source column for a rename regardless of expression text", () => {
    const step: RecipeStep = { op: "rename_column", from: "department", to: "Team" };
    expect(referencedColumns(step, vocab)).toEqual(["department"]);
  });
});

describe("planReplay", () => {
  it("marks every step applicable when the schema matches", () => {
    const recipe = serializeRecipe(fullState(), "r");
    const plan = planReplay(recipe, mkState());
    expect(plan.applicable).toHaveLength(recipe.steps.length);
    expect(plan.skipped).toEqual([]);
  });

  it("skips — never drops — a step referencing a missing column, and keeps the rest", () => {
    const recipe = serializeRecipe(fullState(), "r");
    // next quarter's export lost `market_median`
    const target = mkState({
      columns: ["employee_id", "department", "base_salary"],
    });
    const plan = planReplay(recipe, target);

    const skippedOps = plan.skipped.map((s) => s.step.op);
    expect(skippedOps).toContain("add_derived_column"); // uses market_median
    expect(skippedOps).toContain("flag_rows"); // uses market_median
    expect(skippedOps).toContain("add_chart"); // uses market_median (dataset alias irrelevant)

    for (const s of plan.skipped) {
      expect(s.reason).toMatch(/market_median/);
    }
    // the filter and the rename don't touch market_median → still applicable
    expect(plan.applicable.map((a) => a.step.op).sort()).toEqual([
      "add_filter",
      "rename_column",
    ]);
  });

  it("skips a rename whose source column is absent", () => {
    const recipe: Recipe = {
      version: 1,
      name: "r",
      createdAt: new Date().toISOString(),
      source: { fileName: "old.csv", rows: 1, columns: ["a", "b"] },
      steps: [{ op: "rename_column", from: "b", to: "B" }],
    };
    const plan = planReplay(recipe, mkState({ columns: ["a"] }));
    expect(plan.applicable).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/column not in "compensation.csv": b/);
  });

  it("skips a derived column whose name collides with a base column", () => {
    const recipe: Recipe = {
      version: 1,
      name: "r",
      createdAt: new Date().toISOString(),
      source: { fileName: "old.csv", rows: 1, columns: ["base_salary"] },
      steps: [
        { op: "add_derived_column", name: "department", expression: "base_salary * 2" },
      ],
    };
    const plan = planReplay(recipe, mkState());
    expect(plan.skipped[0].reason).toMatch(/already exists/);
  });

  it("skips steps already present on the target (idempotent replay)", () => {
    const recipe = serializeRecipe(fullState(), "r");
    const plan = planReplay(recipe, fullState());
    expect(plan.applicable).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(
      Array(recipe.steps.length).fill("already applied")
    );
  });

  it("does not flag missing columns when the recipe carries no source column list", () => {
    const recipe: Recipe = {
      version: 1,
      name: "r",
      createdAt: new Date().toISOString(),
      source: { fileName: "old.csv", rows: 0, columns: [] },
      steps: [{ op: "add_filter", expression: "anything > 0", label: "x" }],
    };
    const plan = planReplay(recipe, mkState());
    expect(plan.applicable).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });
});

describe("describeStep", () => {
  it("renders a one-line human summary per op", () => {
    expect(
      describeStep({ op: "rename_column", from: "a", to: "b" })
    ).toBe("rename a → b");
    expect(
      describeStep({ op: "add_filter", expression: "x>0", label: "pos" })
    ).toBe("filter pos");
    expect(
      describeStep({
        op: "add_chart",
        chartKind: "line",
        title: "Trend",
        sql: "s",
      })
    ).toBe('line chart "Trend"');
  });
});
