import { useState } from "react";
import { useActiveDataset } from "../engine/useDataset";
import { useJustAdded } from "./useJustAdded";

/** The active filters + a quick add box. Human edits here; agent edits via staged tools. */
export function FilterBar() {
  const { state, store } = useActiveDataset();
  const [expr, setExpr] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const flashing = useJustAdded(state?.filters.map((f) => f.id) ?? []);
  if (!state || !store) return null;

  const submit = async () => {
    const v = expr.trim();
    if (!v) return;
    setErr(null);
    try {
      await store.addFilter(v, undefined, "human");
      setExpr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-1.5">
      {state.filters.map((f) => (
        <span
          key={f.id}
          className={`chip ${f.origin === "agent" ? "chip-agent" : ""} ${
            flashing.has(f.id) ? "agent-committed" : ""
          }`}
        >
          {f.origin === "agent" && <Spark />}
          <span className="max-w-[220px] truncate">{f.label}</span>
          <button
            type="button"
            onClick={() => void store.removeFilter(f.id)}
            aria-label={`Remove filter ${f.label}`}
            className="text-slate-500 hover:text-danger"
          >
            ✕
          </button>
        </span>
      ))}

      <input
        value={expr}
        onChange={(e) => setExpr(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        aria-label="Add a filter expression"
        placeholder="+ filter  e.g.  base_salary > 150000"
        className="min-w-[240px] flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-airlock-600 focus:outline-none focus-visible:outline-airlock-400"
      />
      {state.filters.length > 0 && (
        <button
          type="button"
          onClick={() => void store.clearFilters()}
          className="text-[11px] text-slate-500 hover:text-slate-300"
        >
          clear all
        </button>
      )}
      {err && (
        <span role="alert" className="w-full font-mono text-[11px] text-danger">
          {err}
        </span>
      )}
    </div>
  );
}

function Spark() {
  return (
    <span className="text-airlock-400" title="Added by the agent">
      ✦
    </span>
  );
}
