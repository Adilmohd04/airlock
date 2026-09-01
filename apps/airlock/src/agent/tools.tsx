/**
 * Airlock's WebMCP surface — every tool the agent can call, registered against
 * `document.modelContext`.
 *
 * Two tiers, and the split is deliberate and honest (hosts like ChatGPT surface
 * it via `readOnlyHint`):
 *
 *   READ tools   — `registerTool`, `readOnlyHint: true`. Run immediately. They
 *                  never change committed state; they only let the agent look.
 *                  Every call is logged to the activity ledger with a summary of
 *                  what data was returned.
 *
 *   WRITE tools  — `registerStagedTool`, a `propose_* / commit_* / reject_*`
 *                  trio. `propose_*` stages a typed diff for human review and is
 *                  itself `readOnlyHint: true` (it changes nothing yet).
 *                  `commit_*` refuses until the human approves in the UI.
 *
 * The agent and the human mutate the exact same stores, so a filter the agent
 * adds is indistinguishable from one the human clicked — same grid, same charts,
 * same undo.
 */

import { useEffect } from "react";
import {
  getModelContext,
  registerStagedTool,
  registerTool,
} from "webmcp-staged";
import type { DatasetStore } from "../engine/datasetStore";
import { workspaceStore } from "../engine/workspaceStore";
import {
  runQuery,
  assertSelectOnly,
  assertExpression,
} from "../engine/duckdb";
import { rowsToCsv, downloadText } from "../lib/csv";
import { activityLog } from "./activity";
import { citationStats, extractCitations } from "./citations";
import { reportStore } from "./reports";
import { registerCommit } from "./reviewController";
import { uiStore } from "../engine/uiStore";
import type { ToolPreview } from "./previewTypes";

// ── helpers ────────────────────────────────────────────────────────────────

function activeStore(): DatasetStore {
  const s = workspaceStore.getActiveStore();
  if (!s) {
    throw new Error(
      "No dataset is loaded yet. Ask the user to drop a CSV/JSON file or load the demo dataset, then try again."
    );
  }
  return s;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jsonBlock(summary: string, data?: unknown): string {
  if (data === undefined) return summary;
  return `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

/** Wrap a read tool: run it, log it (or log the denial), return text. */
async function read(
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<{ summary: string; data?: unknown; returned?: { rows?: number; columns?: string[] } }>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const r = await fn();
    activityLog.add({
      kind: "read",
      tool,
      args,
      summary: r.summary,
      returned: r.returned,
    });
    return { content: [{ type: "text", text: jsonBlock(r.summary, r.data) }] };
  } catch (e) {
    activityLog.add({ kind: "denied", tool, args, summary: msg(e) });
    return { content: [{ type: "text", text: `Error: ${msg(e)}` }], isError: true };
  }
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

// ── the hook ───────────────────────────────────────────────────────────────

/**
 * Register the full tool suite for the lifetime of the app. Safe to call when
 * WebMCP is unavailable — `registerTool` / `registerStagedTool` no-op cleanly.
 */
export function useAirlockTools(): void {
  useEffect(() => {
    const mc = getModelContext();
    const disposers: (() => void)[] = [];
    const add = (r: { unregister: () => void }) => disposers.push(r.unregister);

    // ───────────────────────── READ TOOLS ─────────────────────────

    add(
      registerTool(
        {
          name: "list_datasets",
          description:
            "List every dataset loaded in the workspace with row/column counts, its SQL table name, and which one is active. The active dataset's base table is also always queryable as `dataset`.",
          annotations: { readOnlyHint: true },
          execute: () =>
            read("list_datasets", {}, async () => {
              const list = workspaceStore.list().map((h) => {
                const st = h.store.getState();
                return {
                  id: h.id,
                  fileName: st.fileName,
                  tableName: st.tableName,
                  source: st.source,
                  rows: st.totalRows,
                  columns: st.columns.length,
                  active: h.id === workspaceStore.getActive()?.id,
                };
              });
              return {
                summary: `${list.length} dataset(s) loaded.`,
                data: list,
              };
            }),
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "get_dataset_summary",
          description:
            "Summarize the active dataset: file name, SQL table name, row count, and every column with its type. Start here. In run_sql you can refer to this table as `dataset` or by its real `tableName`.",
          annotations: { readOnlyHint: true },
          execute: () =>
            read("get_dataset_summary", {}, async () => {
              const st = activeStore().getState();
              return {
                summary: `"${st.fileName}" — ${st.totalRows.toLocaleString()} rows, ${st.columns.length} columns. Query it as \`dataset\`.`,
                data: {
                  fileName: st.fileName,
                  tableName: st.tableName,
                  sqlAlias: "dataset",
                  totalRows: st.totalRows,
                  columns: st.columns.map((c) => ({
                    name: st.renames[c] ?? c,
                    baseName: c,
                    type: st.columnTypes[c],
                  })),
                  activeFilters: st.filters.map((f) => f.label),
                  derivedColumns: st.derived.map((d) => `${d.name} = ${d.expression}`),
                  renames: st.renames,
                },
                returned: { columns: st.columns },
              };
            }),
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "list_columns",
          description:
            "List the active dataset's columns with type, null fraction and distinct count.",
          annotations: { readOnlyHint: true },
          execute: () =>
            read("list_columns", {}, async () => {
              const store = activeStore();
              const st = store.getState();
              const cols = st.columns.map((c) => {
                const p = st.profiles[c];
                return {
                  name: st.renames[c] ?? c,
                  baseName: c,
                  type: st.columnTypes[c],
                  nulls: p ? p.nullCount : null,
                  distinct: p ? p.distinctCount : null,
                };
              });
              return {
                summary: `${cols.length} columns.`,
                data: cols,
                returned: { columns: st.columns },
              };
            }),
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "profile_column",
          description:
            "Full profile of one column: type, non-null count, nulls, distinct count, numeric min/max/mean, and up to 5 example values.",
          inputSchema: {
            type: "object",
            properties: {
              column: { type: "string", description: "Column name (display or base name)." },
            },
            required: ["column"],
          },
          annotations: { readOnlyHint: true },
          execute: (input) => {
            const column = String((input as { column?: unknown }).column ?? "");
            return read("profile_column", { column }, async () => {
              const store = activeStore();
              const st = store.getState();
              const base =
                st.columns.find((c) => c === column) ??
                st.columns.find((c) => (st.renames[c] ?? c) === column);
              if (!base) throw new Error(`No column "${column}".`);
              const p = st.profiles[base] ?? (await store.profileColumn(base));
              return {
                summary: `${st.renames[base] ?? base} (${p.type}): ${p.count} non-null, ${p.nullCount} null, ${p.distinctCount} distinct.`,
                data: p,
                returned: { columns: [base], rows: p.samples.length },
              };
            });
          },
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "preview_rows",
          description:
            "Return rows from the CURRENT VIEW of the active dataset (all filters, derived columns and renames applied). Optional extra WHERE clause and row limit.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max rows (default 25, cap 100)." },
              where: {
                type: "string",
                description: "Optional extra SQL boolean expression, applied on top of active filters.",
              },
            },
          },
          annotations: { readOnlyHint: true },
          execute: (input) => {
            const limit = Math.min(
              100,
              Math.max(1, Number((input as { limit?: unknown }).limit) || 25)
            );
            const where = String((input as { where?: unknown }).where ?? "").trim();
            return read("preview_rows", { limit, where }, async () => {
              const store = activeStore();
              let sql = store.buildViewSql();
              if (where) {
                assertExpression(where);
                sql = `SELECT * FROM (${sql}) WHERE (${where})`;
              }
              sql += ` LIMIT ${limit}`;
              const res = await runQuery(sql);
              return {
                summary: `${res.rowCount} row(s) from the current view.`,
                data: { columns: res.columns, rows: res.rows },
                returned: { rows: res.rowCount, columns: res.columns },
              };
            });
          },
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "run_sql",
          description:
            "Run ONE read-only SQL query (SELECT / WITH / VALUES / EXPLAIN) and return up to 200 rows. The active dataset is available as `dataset` (e.g. \"SELECT department, avg(base_salary) FROM dataset GROUP BY 1\"); other loaded datasets use the `tableName` from list_datasets. Cannot modify data, read files, or reach the network — use the staged propose_* tools for changes.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          annotations: { readOnlyHint: true },
          execute: (input) => {
            const query = String((input as { query?: unknown }).query ?? "");
            return read("run_sql", { query }, async () => {
              const safe = assertSelectOnly(query);
              const res = await runQuery(`SELECT * FROM (${safe}) LIMIT 200`);
              return {
                summary: `${res.rowCount} row(s), ${res.columns.length} column(s) in ${res.elapsedMs}ms.`,
                data: { columns: res.columns, rows: res.rows },
                returned: { rows: res.rowCount, columns: res.columns },
              };
            });
          },
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "describe_workspace",
          description:
            "List everything currently applied to the active dataset: filters, derived columns, renames, charts and flag sets — plus how many are agent-originated.",
          annotations: { readOnlyHint: true },
          execute: () =>
            read("describe_workspace", {}, async () => {
              const st = activeStore().getState();
              return {
                summary: `${st.filters.length} filter(s), ${st.derived.length} derived column(s), ${Object.keys(st.renames).length} rename(s), ${st.charts.length} chart(s), ${st.flags.length} flag set(s).`,
                data: {
                  tableName: st.tableName,
                  sqlAlias: "dataset",
                  filters: st.filters,
                  derived: st.derived,
                  renames: st.renames,
                  charts: st.charts.map((c) => ({ id: c.id, title: c.title, kind: c.kind, sql: c.sql })),
                  flags: st.flags,
                },
              };
            }),
        },
        { mc: mc ?? undefined }
      )
    );

    add(
      registerTool(
        {
          name: "get_activity_log",
          description:
            "Return the transparency ledger: every tool call this session, what it did, and a summary of the data returned to the agent. Each entry's `id` is what a write_report [cite:<id>] marker points at — cite the read entry that produced each number.",
          annotations: { readOnlyHint: true },
          execute: () =>
            read("get_activity_log", {}, async () => {
              const entries = activityLog.list().slice(-40);
              return {
                summary: `${activityLog.list().length} tool call(s) this session; ${activityLog.rowsDisclosed()} rows disclosed across ${activityLog.seenColumns().length} distinct columns.`,
                data: entries,
              };
            }),
        },
        { mc: mc ?? undefined }
      )
    );

    // ──────────────────────── STAGED WRITE TOOLS ────────────────────────

    const stage = <T extends Record<string, unknown>>(config: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      prepare: (input: T) => Promise<{ summary: string; preview: ToolPreview }>;
      commit: (input: T) => Promise<string>;
    }) => {
      // Shared commit path: the agent's `commit_<name>` tool AND the review
      // panel's Approve button both land here. Every outcome — success or
      // failure — is written to the ledger (non-negotiable #5).
      const doCommit = async (input: T): Promise<string> => {
        try {
          const result = await config.commit(input);
          activityLog.add({
            kind: "commit",
            tool: `commit_${config.name}`,
            args: input,
            summary: result,
          });
          return result;
        } catch (e) {
          activityLog.add({
            kind: "denied",
            tool: `commit_${config.name}`,
            args: input,
            summary: `Commit failed: ${msg(e)}`,
          });
          throw e;
        }
      };
      registerCommit(config.name, doCommit as (i: Record<string, unknown>) => Promise<string>);

      add(
        registerStagedTool<T>(
          {
            name: config.name,
            description: config.description,
            inputSchema: config.inputSchema as never,
            prepare: async (input) => {
              try {
                const { summary, preview } = await config.prepare(input);
                activityLog.add({
                  kind: "propose",
                  tool: `propose_${config.name}`,
                  args: input,
                  summary,
                });
                return { summary, preview };
              } catch (e) {
                // A blocked/invalid propose must not be invisible — an agent
                // probing malformed payloads should leave a trail.
                activityLog.add({
                  kind: "denied",
                  tool: `propose_${config.name}`,
                  args: input,
                  summary: `Rejected: ${msg(e)}`,
                });
                throw e;
              }
            },
            commit: (input) => doCommit(input),
          },
          {
            mc: mc ?? undefined,
            audit: (ev) => {
              // webmcp-staged fires this for commit-attempts on an
              // unapproved/rejected/unknown proposal, and for the agent's own
              // reject_<name> tool — paths the UI never sees.
              if (ev.type === "denied_commit") {
                activityLog.add({
                  kind: "denied",
                  tool: `commit_${config.name}`,
                  args: { proposalId: ev.proposalId },
                  summary: ev.reason,
                  proposalId: ev.proposalId,
                });
              } else if (ev.type === "rejected") {
                activityLog.add({
                  kind: "reject",
                  tool: `reject_${config.name}`,
                  args: { proposalId: ev.proposalId },
                  summary: "Withdrawn by the agent.",
                  proposalId: ev.proposalId,
                });
              }
            },
          }
        )
      );
    };

    stage<{ expression: string; label?: string }>({
      name: "add_filter",
      description:
        "Filter the active dataset to rows matching a SQL boolean expression, e.g. \"base_salary > 150000\" or \"department = 'Engineering'\". Stacks with existing filters (AND).",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "SQL boolean expression over the base columns." },
          label: { type: "string", description: "Short human label for the chip (optional)." },
        },
        required: ["expression"],
      },
      prepare: async ({ expression, label }) => {
        assertExpression(expression);
        const store = activeStore();
        const st = store.getState();
        const rowsBefore = st.totalRows;
        const inner = store.buildViewSql();
        const after = await runQuery(
          `SELECT count(*) AS n FROM (${inner}) WHERE (${expression})`
        );
        const rowsAfter = Number(after.rows[0]?.n ?? 0);
        return {
          summary: `Filter: ${label ?? expression} — keeps ${rowsAfter.toLocaleString()} of ${rowsBefore.toLocaleString()} rows`,
          preview: {
            kind: "add_filter",
            expression,
            label: label ?? expression,
            rowsBefore,
            rowsAfter,
          },
        };
      },
      commit: async ({ expression, label }) => {
        const c = await activeStore().addFilter(expression, label, "agent");
        return `Applied filter "${c.label}".`;
      },
    });

    stage<{ filter: string }>({
      name: "remove_filter",
      description:
        "Remove an active filter from the dataset, identified by its label or its exact expression.",
      inputSchema: {
        type: "object",
        properties: { filter: { type: "string", description: "Filter label or expression." } },
        required: ["filter"],
      },
      prepare: async ({ filter }) => {
        const store = activeStore();
        const st = store.getState();
        const target = st.filters.find(
          (f) => f.label === filter || f.expression === filter
        );
        if (!target) throw new Error(`No active filter matching "${filter}".`);
        const rowsBefore = st.totalRows;
        const remaining = st.filters.filter((f) => f.id !== target.id);
        const base = `SELECT * FROM ${q(st.tableName)}`;
        const where =
          remaining.length > 0
            ? " WHERE " + remaining.map((f) => `(${f.expression})`).join(" AND ")
            : "";
        const after = await runQuery(`SELECT count(*) AS n FROM (${base}${where})`);
        return {
          summary: `Remove filter "${target.label}"`,
          preview: {
            kind: "remove_filter",
            label: target.label,
            expression: target.expression,
            rowsBefore,
            rowsAfter: Number(after.rows[0]?.n ?? 0),
          },
        };
      },
      commit: async ({ filter }) => {
        const store = activeStore();
        const target = store
          .getState()
          .filters.find((f) => f.label === filter || f.expression === filter);
        if (!target) throw new Error(`No active filter matching "${filter}".`);
        await store.removeFilter(target.id);
        return `Removed filter "${target.label}".`;
      },
    });

    stage<Record<string, never>>({
      name: "clear_filters",
      description: "Remove every active filter from the dataset at once.",
      inputSchema: { type: "object", properties: {} },
      prepare: async () => {
        const store = activeStore();
        const st = store.getState();
        const full = await runQuery(
          `SELECT count(*) AS n FROM ${q(st.tableName)}`
        );
        return {
          summary: `Clear all ${st.filters.length} filter(s)`,
          preview: {
            kind: "clear_filters",
            count: st.filters.length,
            rowsBefore: st.totalRows,
            rowsAfter: Number(full.rows[0]?.n ?? 0),
          },
        };
      },
      commit: async () => {
        await activeStore().clearFilters();
        return "Cleared all filters.";
      },
    });

    stage<{ name: string; expression: string }>({
      name: "add_derived_column",
      description:
        "Add a computed column to the view from a SQL expression over the base columns, e.g. name=\"comp_ratio\", expression=\"base_salary / market_median\". The base table is never modified.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          expression: { type: "string", description: "SQL scalar expression." },
        },
        required: ["name", "expression"],
      },
      prepare: async ({ name, expression }) => {
        assertExpression(expression);
        const store = activeStore();
        const st = store.getState();
        if (st.columns.includes(name))
          throw new Error(`"${name}" already exists as a base column.`);
        const probe = await runQuery(
          `SELECT *, (${expression}) AS ${q(name)} FROM ${q(st.tableName)} LIMIT 3`
        );
        const samples = probe.rows.map((row) => {
          const slim: Record<string, unknown> = {};
          for (const c of st.columns.slice(0, 3)) slim[c] = row[c];
          return { row: slim, value: row[name] };
        });
        return {
          summary: `New column ${name} = ${expression}`,
          preview: { kind: "add_derived_column", name, expression, samples },
        };
      },
      commit: async ({ name, expression }) => {
        await activeStore().addDerivedColumn(name, expression, "agent");
        return `Added derived column "${name}".`;
      },
    });

    stage<{ name: string }>({
      name: "remove_derived_column",
      description: "Remove a previously-added derived column by name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      prepare: async ({ name }) => {
        const d = activeStore().getState().derived.find((x) => x.name === name);
        if (!d) throw new Error(`No derived column "${name}".`);
        return {
          summary: `Remove derived column ${name}`,
          preview: { kind: "remove_derived_column", name, expression: d.expression },
        };
      },
      commit: async ({ name }) => {
        await activeStore().removeDerivedColumn(name);
        return `Removed derived column "${name}".`;
      },
    });

    stage<{ from: string; to: string }>({
      name: "rename_column",
      description:
        "Rename a column in the view (display only — the base table keeps its original name, so this is fully reversible).",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
      prepare: async ({ from, to }) => {
        const st = activeStore().getState();
        const base =
          st.columns.find((c) => c === from) ??
          st.columns.find((c) => (st.renames[c] ?? c) === from);
        if (!base) throw new Error(`No column "${from}".`);
        return {
          summary: `Rename ${from} → ${to}`,
          preview: {
            kind: "rename_column",
            from: st.renames[base] ?? base,
            to,
            type: st.columnTypes[base] ?? "?",
          },
        };
      },
      commit: async ({ from, to }) => {
        const st = activeStore().getState();
        const base =
          st.columns.find((c) => c === from) ??
          st.columns.find((c) => (st.renames[c] ?? c) === from);
        if (!base) throw new Error(`No column "${from}".`);
        await activeStore().renameColumn(base, to, "agent");
        return `Renamed ${from} → ${to}.`;
      },
    });

    stage<{ title: string; kind: "bar" | "line"; sql: string }>({
      name: "add_chart",
      description:
        "Add a bar or line chart. `sql` must return exactly two columns: a label and a numeric value, e.g. \"SELECT department, avg(base_salary) FROM dataset GROUP BY 1 ORDER BY 2 DESC\".",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["bar", "line"] },
          sql: { type: "string" },
        },
        required: ["title", "kind", "sql"],
      },
      prepare: async ({ title, kind, sql }) => {
        const safe = assertSelectOnly(sql);
        const res = await runQuery(`SELECT * FROM (${safe}) LIMIT 50`);
        if (res.columns.length < 2)
          throw new Error("Chart query must return two columns: [label, value].");
        const [l, v] = res.columns;
        const data = res.rows.map((r) => ({
          label: String(r[l]),
          value: Number(r[v]),
        }));
        return {
          summary: `${kind} chart: ${title} (${data.length} points)`,
          preview: { kind: "add_chart", title, chartKind: kind, sql, data },
        };
      },
      commit: async ({ title, kind, sql }) => {
        await activeStore().addChart({ title, kind, sql }, "agent");
        uiStore.setTab("charts");
        return `Added chart "${title}".`;
      },
    });

    stage<{ where: string; reason: string }>({
      name: "flag_rows",
      description:
        "Flag rows matching a SQL boolean expression for the human's attention, with a reason, e.g. where=\"base_salary < market_median * 0.8\", reason=\"paid >20% below market\". Does not delete anything.",
      inputSchema: {
        type: "object",
        properties: { where: { type: "string" }, reason: { type: "string" } },
        required: ["where", "reason"],
      },
      prepare: async ({ where, reason }) => {
        assertExpression(where);
        const st = activeStore().getState();
        const cnt = await runQuery(
          `SELECT count(*) AS n FROM ${q(st.tableName)} WHERE (${where})`
        );
        const sample = await runQuery(
          `SELECT * FROM ${q(st.tableName)} WHERE (${where}) LIMIT 5`
        );
        return {
          summary: `Flag ${Number(cnt.rows[0]?.n ?? 0)} row(s): ${reason}`,
          preview: {
            kind: "flag_rows",
            expression: where,
            reason,
            count: Number(cnt.rows[0]?.n ?? 0),
            sample: sample.rows,
          },
        };
      },
      commit: async ({ where, reason }) => {
        const f = await activeStore().addFlagSet(where, reason, "agent");
        return `Flagged ${f.count} row(s): ${reason}.`;
      },
    });

    stage<{
      right: string;
      on: { left: string; right: string }[];
      type?: "inner" | "left";
    }>({
      name: "join_datasets",
      description:
        "Join the active dataset (left) to another loaded dataset (right) on one or more key pairs, producing a new dataset. Use list_datasets to get dataset ids or file names.",
      inputSchema: {
        type: "object",
        properties: {
          right: { type: "string", description: "id or file name of the dataset to join in." },
          type: { type: "string", enum: ["inner", "left"] },
          on: {
            type: "array",
            items: {
              type: "object",
              properties: { left: { type: "string" }, right: { type: "string" } },
              required: ["left", "right"],
            },
          },
        },
        required: ["right", "on"],
      },
      prepare: async ({ right, on, type }) => {
        const left = workspaceStore.getActive();
        if (!left) throw new Error("No active dataset to join from.");
        const rightHandle =
          workspaceStore.get(right) ??
          workspaceStore.list().find((h) => h.store.getState().fileName === right);
        if (!rightHandle) throw new Error(`No dataset "${right}".`);
        const jt = type ?? "inner";
        const p = await workspaceStore.previewJoin({
          leftId: left.id,
          rightId: rightHandle.id,
          on,
          type: jt,
        });
        return {
          summary: `Join to "${rightHandle.store.getState().fileName}" → ${p.rowCount.toLocaleString()} rows`,
          preview: {
            kind: "join_datasets",
            leftName: left.store.getState().fileName,
            rightName: rightHandle.store.getState().fileName,
            on,
            type: jt,
            rowCount: p.rowCount,
            columns: p.columns,
          },
        };
      },
      commit: async ({ right, on, type }) => {
        const left = workspaceStore.getActive()!;
        const rightHandle =
          workspaceStore.get(right) ??
          workspaceStore.list().find((h) => h.store.getState().fileName === right)!;
        const h = await workspaceStore.commitJoin({
          leftId: left.id,
          rightId: rightHandle.id,
          on,
          type: type ?? "inner",
          origin: "agent",
        });
        return `Created joined dataset "${h.store.getState().fileName}" (${h.store.getState().totalRows} rows).`;
      },
    });

    stage<{ filename?: string }>({
      name: "export_view",
      description:
        "Export the current transformed view of the active dataset (filters + derived columns + renames applied) as a CSV download. This is the one action that moves data out of the browser — into the user's own Downloads folder, on their approval.",
      inputSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
      },
      prepare: async ({ filename }) => {
        const store = activeStore();
        const st = store.getState();
        const res = await runQuery(store.buildViewSql());
        const transforms = [
          ...st.filters.map((f) => `filter: ${f.label}`),
          ...st.derived.map((d) => `+column: ${d.name}`),
          ...Object.entries(st.renames).map(([a, b]) => `rename: ${a}→${b}`),
        ];
        return {
          summary: `Export ${res.rowCount.toLocaleString()} rows × ${res.columns.length} cols to CSV`,
          preview: {
            kind: "export_view",
            filename: filename || `${st.fileName.replace(/\.[^.]+$/, "")}-airlock.csv`,
            rows: res.rowCount,
            columns: res.columns,
            appliedTransforms: transforms.length ? transforms : ["(raw view, no transforms)"],
          },
        };
      },
      commit: async ({ filename }) => {
        const store = activeStore();
        const st = store.getState();
        const res = await runQuery(store.buildViewSql());
        const name = filename || `${st.fileName.replace(/\.[^.]+$/, "")}-airlock.csv`;
        downloadText(name, rowsToCsv(res.columns, res.rows), "text/csv;charset=utf-8");
        return `Exported ${res.rowCount} rows to ${name}.`;
      },
    });

    stage<{ title: string; markdown: string }>({
      name: "write_report",
      description:
        "Write an insight report — a markdown findings document about the data — for the human to review, keep and export. Use headings, short paragraphs and bullet points. " +
        "Cite every concrete number with a [cite:<id>] marker, where <id> is the `id` field of the get_activity_log / read-tool entry that produced it " +
        "(e.g. \"paid 8% below market [cite:3fa85f64-...]\"). Uncited numeric claims are shown to the human as unverified before they approve.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          markdown: { type: "string", description: "The report body in Markdown." },
        },
        required: ["title", "markdown"],
      },
      prepare: async ({ title, markdown }) => {
        const words = markdown.trim().split(/\s+/).filter(Boolean).length;
        const entries = activityLog.list();
        const citations = citationStats(markdown, entries);
        // Broken citations don't block the proposal — the human still needs
        // to see the report to judge it — but they must leave a trail, same
        // as any other refused/suspect input (non-negotiable #5).
        if (citations.brokenCitations > 0) {
          const broken = extractCitations(markdown, entries).filter((c) => !c.valid);
          activityLog.add({
            kind: "denied",
            tool: "propose_write_report",
            args: { title },
            summary: `${citations.brokenCitations} citation(s) reference a missing or non-read ledger entry: ${broken.map((c) => c.id).join(", ")}`,
          });
        }
        return {
          summary:
            `Insight report: "${title}" (${words} words, ${citations.citedClaims} cited / ${citations.uncitedClaims} uncited claim(s)` +
            `${citations.brokenCitations ? `, ${citations.brokenCitations} broken citation(s)` : ""})`,
          preview: { kind: "write_report", title, markdown, words, citations },
        };
      },
      commit: async ({ title, markdown }) => {
        reportStore.add(title, markdown, "agent");
        uiStore.setTab("report");
        return `Saved report "${title}".`;
      },
    });

    return () => {
      for (const d of disposers) d();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
