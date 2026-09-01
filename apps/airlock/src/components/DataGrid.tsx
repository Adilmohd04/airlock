import { useMemo } from "react";
import { useActiveDataset } from "../engine/useDataset";

const MAX_RENDER = 500;

export function DataGrid() {
  const { state, store } = useActiveDataset();
  const view = state?.view ?? null;

  const derivedSet = useMemo(
    () => new Set(state?.derived.map((d) => d.name) ?? []),
    [state?.derived]
  );
  // Display names of redacted columns — the human still sees the values here;
  // the glyph is a reminder that the agent does not.
  const redactedSet = useMemo(
    () =>
      new Set(
        (state?.redactedColumns ?? []).map(
          (b) => state?.renames[b] ?? b
        )
      ),
    [state?.redactedColumns, state?.renames]
  );
  const flagExprs = state?.flags ?? [];

  if (!state) return null;

  // Cold start: the first query also downloads + instantiates DuckDB-WASM
  // (~35 MB, one time, in this tab). Show a real skeleton, not a spinner.
  if (state.busy && !view) return <GridSkeleton />;

  if (state.error && !view) {
    return (
      <GridError message={state.error} onRetry={() => void store?.refreshView().catch(() => {})} />
    );
  }

  if (!view) return <Centered>No data loaded.</Centered>;

  if (view.rows.length === 0) {
    const filtered = state.filters.length > 0;
    return (
      <Centered>
        <div className="space-y-2">
          <p>{filtered ? "No rows match the current filters." : "This table has no rows."}</p>
          {filtered && (
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={() => void store?.clearFilters().catch(() => {})}
            >
              Clear {state.filters.length} filter{state.filters.length > 1 ? "s" : ""}
            </button>
          )}
        </div>
      </Centered>
    );
  }

  const rows = view.rows.slice(0, MAX_RENDER);

  return (
    <div className="relative flex h-full flex-col" aria-busy={state.busy}>
      {/* In-place refresh (filter added, column derived): 1px bar, no reflow. */}
      {state.busy && <div className="refresh-bar absolute inset-x-0 top-0 z-20 h-0.5" />}

      {/* A refresh failed but the previous view still stands — say so inline. */}
      {state.error && !state.busy && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-danger/30 bg-danger/5 px-3 py-1.5 font-mono text-[11px] text-danger"
        >
          <span className="truncate">{state.error} · showing the last good result</span>
          <button
            type="button"
            className="shrink-0 underline hover:no-underline"
            onClick={() => void store?.refreshView().catch(() => {})}
          >
            retry
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <thead className="sticky top-0 z-10 bg-ink-900">
            <tr>
              <th className="border-b border-ink-700 px-2 py-1.5 text-right text-slate-600">
                #
              </th>
              {view.columns.map((c) => (
                <th
                  key={c}
                  className={`whitespace-nowrap border-b border-ink-700 px-3 py-1.5 text-left font-medium ${
                    derivedSet.has(c) ? "text-airlock-300" : "text-slate-300"
                  }`}
                >
                  {redactedSet.has(c) && (
                    <span
                      className="mr-1 text-danger"
                      title="Redacted — hidden from the agent"
                    >
                      ●
                    </span>
                  )}
                  {c}
                  {derivedSet.has(c) && (
                    <span className="ml-1 text-[9px] text-airlock-600">derived</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const flagged = flagExprs.length > 0 && rowMatchesAnyFlag(r, flagExprs);
              return (
                <tr
                  key={i}
                  className={`border-b border-ink-850 hover:bg-ink-900 ${
                    flagged ? "bg-pending/[0.06]" : ""
                  }`}
                >
                  <td className="px-2 py-1 text-right text-slate-700">
                    {flagged ? (
                      <span className="text-pending" title="Flagged for review">
                        ▲
                      </span>
                    ) : (
                      i + 1
                    )}
                  </td>
                  {view.columns.map((c) => (
                    <td
                      key={c}
                      className={`max-w-[280px] truncate px-3 py-1 ${
                        derivedSet.has(c) ? "text-airlock-200" : "text-slate-300"
                      }`}
                      title={fmt(r[c])}
                    >
                      {fmt(r[c])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-ink-800 bg-ink-900 px-3 py-1.5 text-[11px] text-slate-500">
        Showing {rows.length.toLocaleString()} of{" "}
        {state.totalRows.toLocaleString()} matching rows
        {state.totalRows > MAX_RENDER && " · scroll cap 500"}
      </div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="flex h-full flex-col p-3" aria-busy="true" aria-live="polite">
      <p className="mb-3 text-xs text-slate-500">
        Starting the in-browser query engine and running the first query. DuckDB
        (~35&nbsp;MB WebAssembly) loads once, in this tab — nothing is uploaded.
      </p>
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-4 flex-1" />
        ))}
      </div>
      <div className="mt-2 space-y-1.5">
        {Array.from({ length: 14 }).map((_, i) => (
          <div key={i} className="flex gap-2" style={{ opacity: 1 - i * 0.06 }}>
            {Array.from({ length: 5 }).map((__, j) => (
              <div key={j} className="skeleton h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function GridError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <p className="text-sm font-medium text-danger">Query failed</p>
        <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-left font-mono text-[11px] text-danger">
          {message}
        </p>
        <button type="button" className="btn btn-ghost text-xs" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Client-side flag check — the flag SQL is simple (`col op value` joined by
 * AND/OR); for the common cases we can evaluate it against the plain row so the
 * grid tints without a round-trip per row. Falls back to "not flagged" on
 * anything it can't parse (the row-count badge on the flag set is still exact).
 */
function rowMatchesAnyFlag(
  row: Record<string, unknown>,
  flags: { expression: string }[]
): boolean {
  return flags.some((f) => {
    const m = f.expression.match(
      /^\s*"?([A-Za-z_][\w]*)"?\s*(=|!=|<>|<=|>=|<|>)\s*('[^']*'|-?[\d.]+)\s*$/
    );
    if (!m) return false;
    const [, col, op, rawVal] = m;
    const lhs = row[col];
    const rhs = rawVal.startsWith("'")
      ? rawVal.slice(1, -1)
      : Number(rawVal);
    const l = typeof rhs === "number" ? Number(lhs) : String(lhs);
    switch (op) {
      case "=":
        return l == rhs;
      case "!=":
      case "<>":
        return l != rhs;
      case "<":
        return l < rhs;
      case ">":
        return l > rhs;
      case "<=":
        return l <= rhs;
      case ">=":
        return l >= rhs;
      default:
        return false;
    }
  });
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center text-sm text-slate-500">
      {children}
    </div>
  );
}
