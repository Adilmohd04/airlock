import { useActiveDataset } from "../engine/useDataset";
import { Sparkline } from "./Sparkline";
import { num, pct } from "../lib/format";

export function ColumnList() {
  const { state, store } = useActiveDataset();
  if (!state || !store) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <p className="panel-title mb-2">
        Columns · {state.columns.length}
        {state.derived.length > 0 && (
          <span className="text-airlock-500"> +{state.derived.length}</span>
        )}
      </p>
      <div className="space-y-0.5">
        {state.columns.map((base) => {
          const shown = state.renames[base] ?? base;
          const p = state.profiles[base];
          const focused = state.focusedColumn === base;
          return (
            <button
              key={base}
              onClick={() => store.setFocusedColumn(focused ? null : base)}
              className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                focused ? "bg-ink-800" : "hover:bg-ink-850"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs text-slate-200">
                  {shown}
                  {state.renames[base] && (
                    <span className="ml-1 text-[10px] text-slate-600 line-through">
                      {base}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] uppercase text-slate-600">
                  {abbrevType(state.columnTypes[base])}
                </span>
              </div>
              {p && (
                <div className="mt-1">
                  {p.histogram ? (
                    <Sparkline bins={p.histogram} />
                  ) : (
                    <div className="h-1 rounded-full bg-ink-700">
                      <div
                        className="h-1 rounded-full bg-airlock-600"
                        style={{
                          width: `${Math.min(
                            100,
                            (p.distinctCount / Math.max(1, p.count)) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                  <div className="mt-1 flex gap-2 font-mono text-[10px] text-slate-600">
                    <span>{num(p.distinctCount)} distinct</span>
                    {p.nullCount > 0 && (
                      <span className="text-pending/80">
                        {pct(p.nullCount, p.count + p.nullCount)} null
                      </span>
                    )}
                    {p.mean !== undefined && <span>μ {num(p.mean)}</span>}
                  </div>
                </div>
              )}
            </button>
          );
        })}

        {state.derived.map((d) => (
          <div
            key={d.id}
            className={`rounded-md px-2 py-1.5 ${
              d.origin === "agent" ? "chip-agent" : ""
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-xs text-airlock-300">
                {d.name}
              </span>
              <button
                onClick={() => void store.removeDerivedColumn(d.name)}
                className="text-[10px] text-slate-600 hover:text-danger"
              >
                remove
              </button>
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
              = {d.expression}
            </p>
          </div>
        ))}
      </div>

      {state.derived.length > 0 && (
        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          Derived columns are view-only. The base table is never modified.
        </p>
      )}
    </div>
  );
}

function abbrevType(t?: string): string {
  if (!t) return "?";
  const u = t.toUpperCase();
  if (/INT|HUGEINT/.test(u)) return "int";
  if (/DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC/.test(u)) return "num";
  if (/VARCHAR|TEXT|STRING/.test(u)) return "str";
  if (/BOOL/.test(u)) return "bool";
  if (/DATE|TIME/.test(u)) return "date";
  return u.slice(0, 4).toLowerCase();
}
