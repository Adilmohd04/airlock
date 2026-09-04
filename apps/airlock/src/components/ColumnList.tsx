import { useActiveDataset } from "../engine/useDataset";
import { Sparkline } from "./Sparkline";
import { useJustAdded } from "./useJustAdded";
import { num, pct } from "../lib/format";

export function ColumnList() {
  const { state, store } = useActiveDataset();
  // Same "agent's touch" motif as FilterBar: a spark glyph for agent-originated
  // rows, one commit-green flash the moment a derived column lands.
  const flashing = useJustAdded(state?.derived.map((d) => d.id) ?? []);
  if (!state || !store) return null;

  const redacted = new Set(state.redactedColumns);
  const suggested = new Set(
    state.piiSuggestions.filter((c) => !redacted.has(c))
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <p className="panel-title mb-2">
        Columns · {state.columns.length}
        {state.derived.length > 0 && (
          <span className="text-airlock-500"> +{state.derived.length}</span>
        )}
        {redacted.size > 0 && (
          <span className="text-danger"> · {redacted.size} redacted</span>
        )}
      </p>
      <div className="space-y-0.5">
        {state.columns.map((base) => {
          const shown = state.renames[base] ?? base;
          const p = state.profiles[base];
          const focused = state.focusedColumn === base;
          const isRedacted = redacted.has(base);
          const isSuggested = suggested.has(base);
          return (
            <div
              key={base}
              className={`group rounded-md px-2 py-1.5 transition-colors ${
                focused ? "bg-ink-800" : "hover:bg-ink-850"
              } ${isRedacted ? "opacity-70" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <button
                  onClick={() => store.setFocusedColumn(focused ? null : base)}
                  className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
                >
                  {isRedacted && (
                    <span title="Redacted — hidden from the agent" className="text-danger">
                      ●
                    </span>
                  )}
                  <span
                    className={`truncate font-mono text-xs ${
                      isRedacted ? "text-danger/80" : "text-slate-200"
                    }`}
                  >
                    {shown}
                    {state.renames[base] && (
                      <span className="ml-1 text-[10px] text-slate-600 line-through">
                        {base}
                      </span>
                    )}
                  </span>
                </button>
                <span className="shrink-0 text-[10px] uppercase text-slate-600">
                  {abbrevType(state.columnTypes[base])}
                </span>
              </div>

              {/* Redaction control — human-only. Redact is also agent-proposable
                  (propose_redact_column); un-redact is never. */}
              <div className="mt-1 flex items-center gap-2">
                {isRedacted ? (
                  <button
                    onClick={() => store.unredactColumn(base)}
                    className="text-[10px] font-medium text-danger hover:text-danger/70"
                    title="Only you can lift a redaction"
                  >
                    ✕ un-redact
                  </button>
                ) : (
                  <button
                    onClick={() => store.redactColumn(base)}
                    className={`text-[10px] ${
                      isSuggested
                        ? "font-medium text-pending hover:text-pending/70"
                        : "text-slate-600 opacity-0 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    {isSuggested ? "⚠ redact (looks like PII)" : "redact"}
                  </button>
                )}
              </div>

              {/* Collapsed: a glanceable shape only. Full stats are one click
                  away (the same click that focuses the column) — showing
                  every number for every column at once is the density the
                  redesign asks to cut. */}
              {p && !isRedacted && (
                <div className="mt-1">
                  {p.histogram ? (
                    <Sparkline bins={p.histogram} />
                  ) : (
                    <div className="h-1 rounded-full bg-ink-700">
                      <div
                        className="h-1 rounded-full bg-airlock-600"
                        style={{
                          width: `${Math.min(100, (p.distinctCount / Math.max(1, p.count)) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {focused ? (
                    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-slate-500">
                      <span>{num(p.distinctCount)} distinct values</span>
                      {p.nullCount > 0 ? (
                        <span className="text-pending/80">{pct(p.nullCount, p.count + p.nullCount)} null</span>
                      ) : (
                        <span className="text-slate-600">0% null</span>
                      )}
                      {p.mean !== undefined && <span className="col-span-2">mean {num(p.mean)}</span>}
                    </div>
                  ) : (
                    <p className="mt-1 font-mono text-[10px] text-slate-600">
                      {num(p.distinctCount)} distinct
                      {p.nullCount > 0 && ` · ${pct(p.nullCount, p.count + p.nullCount)} null`}
                    </p>
                  )}
                </div>
              )}

              {isRedacted && (
                <p className="mt-1 font-mono text-[10px] text-danger/60">
                  agent sees: shape only ({p ? num(p.distinctCount) : "?"} distinct)
                </p>
              )}
            </div>
          );
        })}

        {state.derived.map((d) => (
          <div
            key={d.id}
            className={`rounded-md px-2 py-1.5 ${
              d.origin === "agent" ? "chip-agent" : ""
            } ${flashing.has(d.id) ? "agent-committed" : ""}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-xs text-airlock-300">
                {d.origin === "agent" && (
                  <span className="mr-1 text-airlock-400" title="Added by the agent">
                    ✦
                  </span>
                )}
                {d.name}
              </span>
              <button
                onClick={() => void store.removeDerivedColumn(d.name).catch(() => {})}
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

      {(redacted.size > 0 || suggested.size > 0) && (
        <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
          Redaction is a hard blindfold: a redacted column is unreadable to the
          agent by every path — rows, profiles, <em>and aggregates</em> like
          avg/min/max. Only you can un-redact. Suggestions come from a name/shape
          heuristic and are not exhaustive.
        </p>
      )}

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
