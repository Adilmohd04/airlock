/**
 * DatasetStore redaction behaviour — the store-level half of the blindfold.
 *
 * These exercise the pure methods only (no DuckDB): the agent view builder, the
 * identifier set the guard uses, and the origin-gated mutation guard. State is
 * seeded directly because `onLoaded` needs a live engine.
 */
import { describe, it, expect } from "vitest";
import { createDatasetStore, type DatasetState } from "./datasetStore";

function seed(patch: Partial<DatasetState>) {
  const store = createDatasetStore({
    id: "t",
    tableName: "employees",
    fileName: "employees.csv",
    source: "file",
  });
  const s = store as unknown as { state: DatasetState };
  s.state = {
    ...store.getState(),
    // loaded stays false: these tests exercise pure methods; a true value would
    // send refreshView / re-profile at the (absent) DuckDB engine.
    columns: ["employee_id", "name", "department", "ssn", "base_salary"],
    columnTypes: {
      employee_id: "VARCHAR",
      name: "VARCHAR",
      department: "VARCHAR",
      ssn: "VARCHAR",
      base_salary: "INTEGER",
    },
    ...patch,
  };
  return store;
}

describe("redactedIdentifiers", () => {
  it("returns base names plus any active rename of a redacted column", () => {
    const store = seed({
      redactedColumns: ["ssn", "name"],
      renames: { ssn: "tax_id" },
    });
    expect(new Set(store.redactedIdentifiers())).toEqual(
      new Set(["ssn", "tax_id", "name"])
    );
  });

  it("is empty when nothing is redacted", () => {
    expect(seed({}).redactedIdentifiers()).toEqual([]);
  });
});

describe("buildAgentViewSql", () => {
  it("omits redacted base columns entirely", () => {
    const sql = seed({ redactedColumns: ["ssn", "name"] }).buildAgentViewSql();
    expect(sql).not.toMatch(/\bssn\b/i);
    expect(sql).not.toMatch(/"name"/i);
    expect(sql).toMatch(/employee_id/);
    expect(sql).toMatch(/base_salary/);
  });

  it("drops a derived column whose formula references a redacted column", () => {
    const store = seed({
      redactedColumns: ["base_salary"],
      derived: [
        {
          id: "d1",
          name: "salary_band",
          expression: "floor(base_salary / 10000)",
          origin: "agent",
        },
        {
          id: "d2",
          name: "dept_upper",
          expression: "upper(department)",
          origin: "agent",
        },
      ],
    });
    const sql = store.buildAgentViewSql();
    expect(sql).not.toMatch(/salary_band/);
    expect(sql).not.toMatch(/base_salary/);
    expect(sql).toMatch(/dept_upper/);
  });

  it("still applies renames for non-redacted columns", () => {
    const sql = seed({ renames: { department: "team" } }).buildAgentViewSql();
    expect(sql).toMatch(/AS "team"/);
  });

  it("keeps the human view (buildViewSql) complete — redaction is agent-only", () => {
    const store = seed({ redactedColumns: ["ssn"] });
    expect(store.buildViewSql()).toMatch(/employees/);
    // buildViewSql uses `SELECT *` when there are no renames/derived, so `ssn`
    // is still there for the human grid.
    expect(store.buildViewSql()).toContain("*");
  });
});

describe("assertAgentMaySee", () => {
  it("throws when an agent fragment names a redacted column", () => {
    const store = seed({ redactedColumns: ["ssn"] });
    expect(() => store.assertAgentMaySee("ssn = '123'")).toThrow(/redacted/);
    expect(() => store.assertAgentMaySee("length(ssn) > 0")).toThrow(/redacted/);
  });

  it("allows fragments that only touch visible columns", () => {
    const store = seed({ redactedColumns: ["ssn"] });
    expect(() => store.assertAgentMaySee("base_salary > 100000")).not.toThrow();
  });
});

describe("origin-gated mutation guard", () => {
  it("rejects an agent-origin filter that names a redacted column", async () => {
    const store = seed({ redactedColumns: ["ssn"] });
    await expect(
      store.addFilter("ssn IS NOT NULL", "has ssn", "agent")
    ).rejects.toThrow(/redacted/);
    await expect(
      store.addDerivedColumn("x", "substr(ssn, 1, 3)", "agent")
    ).rejects.toThrow(/redacted/);
  });

  it("does NOT block the human path on redaction (the human is the authority)", async () => {
    // loaded:false so refreshView is a no-op and we isolate the guard.
    const store = seed({ redactedColumns: ["ssn"], loaded: false });
    await expect(
      store.addFilter("ssn IS NOT NULL", "has ssn", "human")
    ).resolves.toMatchObject({ expression: "ssn IS NOT NULL" });
  });
});

describe("redact / un-redact", () => {
  it("redactColumn resolves a display name to its base and is idempotent", () => {
    const store = seed({ renames: { ssn: "tax_id" } });
    store.redactColumn("tax_id");
    store.redactColumn("tax_id");
    expect(store.getState().redactedColumns).toEqual(["ssn"]);
  });

  it("unredactColumn removes it", () => {
    const store = seed({ redactedColumns: ["ssn", "name"] });
    store.unredactColumn("ssn");
    expect(store.getState().redactedColumns).toEqual(["name"]);
  });

  it("isRedacted works through a rename", () => {
    const store = seed({ redactedColumns: ["ssn"], renames: { ssn: "tax_id" } });
    expect(store.isRedacted("tax_id")).toBe(true);
    expect(store.isRedacted("ssn")).toBe(true);
    expect(store.isRedacted("department")).toBe(false);
  });
});
