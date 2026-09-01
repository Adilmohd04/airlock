import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useActiveDataset } from "../engine/useDataset";
import type { ChartSpec } from "../engine/datasetStore";

export function ChartPanel() {
  const { state, store } = useActiveDataset();
  const [showAdd, setShowAdd] = useState(false);
  if (!state || !store) return null;

  return (
    <div className="h-full overflow-y-auto p-4">
      {state.charts.length === 0 && !showAdd && (
        <div className="grid h-full place-items-center text-center text-sm text-slate-500">
          <div>
            <p>No charts yet.</p>
            <p className="mt-1 text-xs">
              Ask the agent for one, or{" "}
              <button
                className="text-airlock-400 underline"
                onClick={() => setShowAdd(true)}
              >
                add one yourself
              </button>
              .
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {state.charts.map((c) => (
          <ChartCard key={c.id} spec={c} onRemove={() => store.removeChart(c.id)} />
        ))}
      </div>

      {(state.charts.length > 0 || showAdd) && (
        <div className="mt-4">
          {showAdd ? (
            <AddChartForm
              onCancel={() => setShowAdd(false)}
              onAdd={async (t, k, sql) => {
                await store.addChart({ title: t, kind: k, sql }, "human");
                setShowAdd(false);
              }}
            />
          ) : (
            <button className="btn btn-ghost text-xs" onClick={() => setShowAdd(true)}>
              + Add chart
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChartCard({
  spec,
  onRemove,
}: {
  spec: ChartSpec;
  onRemove: () => void;
}) {
  const data = spec.data ?? [];
  return (
    <div
      className={`rounded-lg border border-ink-800 bg-ink-900 p-3 ${
        spec.origin === "agent" ? "chip-agent !bg-airlock-700/[0.06]" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-200">
            {spec.origin === "agent" && (
              <span className="mr-1 text-airlock-400">✦</span>
            )}
            {spec.title}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-slate-600">
            {spec.sql}
          </p>
        </div>
        <button
          onClick={onRemove}
          aria-label={`Remove chart ${spec.title}`}
          title="Remove chart"
          className="text-xs text-slate-600 hover:text-danger"
        >
          ✕
        </button>
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          {spec.kind === "bar" ? (
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#1e2430" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#6b7688", fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#6b7688", fontSize: 10 }} width={44} />
              <Tooltip
                contentStyle={{
                  background: "#0f1219",
                  border: "1px solid #1e2430",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                cursor={{ fill: "#ffffff08" }}
              />
              <Bar dataKey="value" fill="#17b3a3" radius={[3, 3, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#1e2430" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#6b7688", fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#6b7688", fontSize: 10 }} width={44} />
              <Tooltip
                contentStyle={{
                  background: "#0f1219",
                  border: "1px solid #1e2430",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line type="monotone" dataKey="value" stroke="#3dd7c4" strokeWidth={2} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AddChartForm({
  onAdd,
  onCancel,
}: {
  onAdd: (title: string, kind: "bar" | "line", sql: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"bar" | "line">("bar");
  const [sql, setSql] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-3">
      <div className="flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Chart title"
          className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-airlock-600 focus:outline-none"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "bar" | "line")}
          className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-slate-200"
        >
          <option value="bar">bar</option>
          <option value="line">line</option>
        </select>
      </div>
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        placeholder="SELECT department, avg(base_salary) FROM dataset GROUP BY 1 ORDER BY 2 DESC"
        rows={2}
        className="mt-2 w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-airlock-600 focus:outline-none"
      />
      {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}
      <div className="mt-2 flex gap-2">
        <button
          className="btn btn-primary text-xs"
          onClick={async () => {
            setErr(null);
            try {
              await onAdd(title || "Chart", kind, sql);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Add
        </button>
        <button className="btn btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
