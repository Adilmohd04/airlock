import { useEffect, useState } from "react";
import { uiStore } from "../engine/uiStore";
import {
  resolveConsoleShim,
  subscribeConsoleDiscovery,
  type ConsoleShim,
} from "../agent/consoleShim";
import { useRegistrationStatus } from "../agent/registrationStatus";
import { LocalAgentConsole } from "./LocalAgentConsole";
import { ByoAgentConsole } from "./ByoAgentConsole";

/**
 * The assistant panel — Airlock's conversational front, backed by the local
 * agent (T1-b) or the user's own endpoint. "Developer tools" is the same
 * manual tool-caller as before, tucked behind a toggle instead of sitting as
 * an equal third tab — it's how you exercise the propose → approve → commit
 * loop without a model at all, and it's what the demo video can drive
 * directly, but it isn't the first thing a user sees.
 *
 * Transport comes from `agent/consoleShim`: the polyfill's testing shim when
 * there is no host, the native `getTools`/`executeTool` surface when there
 * is. Either way the calls run the same registered functions the ledger
 * records.
 */

const SNIPPETS: { label: string; tool: string; args: Record<string, unknown> }[] = [
  { label: "Summarize the dataset", tool: "get_dataset_summary", args: {} },
  {
    label: "Profile base_salary",
    tool: "profile_column",
    args: { column: "base_salary" },
  },
  {
    label: "SQL: avg pay by department",
    tool: "run_sql",
    args: {
      query:
        "SELECT department, round(avg(base_salary)) AS avg_pay, count(*) AS n FROM dataset GROUP BY 1 ORDER BY 2 DESC",
    },
  },
  {
    label: "Propose: filter to underpaid",
    tool: "propose_add_filter",
    args: { expression: "base_salary < market_median * 0.9", label: "paid <90% of market" },
  },
  {
    label: "Propose: comp_ratio column",
    tool: "propose_add_derived_column",
    args: { name: "comp_ratio", expression: "round(base_salary / market_median, 3)" },
  },
  {
    label: "Propose: pay-gap chart",
    tool: "propose_add_chart",
    args: {
      title: "Avg base salary by department",
      kind: "bar",
      sql: "SELECT department, avg(base_salary) FROM dataset GROUP BY 1 ORDER BY 2 DESC",
    },
  },
  {
    label: "Propose: insight report",
    tool: "propose_write_report",
    args: {
      title: "Compensation review — first pass",
      markdown:
        "## Summary\n\nReplace me: call the read tools first, then write real findings with real numbers.",
    },
  },
];

export function AgentConsole() {
  const [shim, setShim] = useState<ConsoleShim | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [tool, setTool] = useState("get_dataset_summary");
  const [args, setArgs] = useState("{}");
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [brain, setBrain] = useState<"agent" | "byo">("agent");
  const [devTools, setDevTools] = useState(false);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [discovering, setDiscovering] = useState(true);
  const [discoveryError, setDiscoveryError] = useState("");
  const registration = useRegistrationStatus();

  useEffect(() => {
    let alive = true;
    const off = subscribeConsoleDiscovery(() => setDiscoveryVersion((v) => v + 1));
    setDiscovering(true);
    setDiscoveryError("");
    setShim(null);
    setTools([]);
    void (async () => {
      try {
        const s = await resolveConsoleShim();
        if (!s) throw new Error("Manual tool calling is unavailable: no supported discovery/execution surface. Attach a compatible host, then refresh discovery.");
        const list = (await s.listTools()).map((t) => t.name).sort();
        if (!alive) return;
        setShim(s);
        setTools(list);
        setTool((selected) => list.includes(selected) ? selected : list[0] ?? "");
      } catch (e) {
        if (alive) setDiscoveryError(`Discovery failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (alive) setDiscovering(false);
      }
    })();
    return () => {
      alive = false;
      off();
    };
  }, [discoveryVersion, devTools]);

  const unavailable = busy ? "A manual call is running." : discovering
    ? "Discovering tools..." : discoveryError || (!shim
      ? "Manual tool calling is unavailable. Refresh discovery to retry."
      : !tools.length ? "No tools discovered. Load a dataset or attach a host, then refresh discovery." : "");

  const run = async (t = tool, a = args) => {
    if (unavailable || !tools.includes(t)) {
      setOut(`Cannot execute: ${unavailable || `Tool not discovered: ${t}. Refresh discovery to retry.`}`);
      return;
    }
    setBusy(true);
    setOut("");
    try {
      const current = await resolveConsoleShim();
      if (!current) throw new Error("Manual transport is no longer available. Refresh discovery to retry.");
      const res = await current.executeTool(t, a);
      setOut(typeof res === "string" ? res : JSON.stringify(res, null, 2) ?? "Call completed without a result.");
    } catch (e) {
      setOut(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-96 max-h-[50dvh] min-h-0 min-w-0 shrink-0 flex-col overflow-auto border-t border-ink-700 bg-ink-950">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink-800 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-white">Ask Airlock</span>
          {!devTools && (
            <div className="flex overflow-hidden rounded-md border border-ink-700 text-[11px]">
              <button
                className={`px-2.5 py-1 ${brain === "agent" ? "bg-ink-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
                onClick={() => setBrain("agent")}
              >
                On-device
              </button>
              <button
                className={`px-2.5 py-1 ${brain === "byo" ? "bg-ink-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
                onClick={() => setBrain("byo")}
              >
                Your endpoint
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="text-[11px] text-slate-500 hover:text-slate-300"
            onClick={() => setDevTools((v) => !v)}
          >
            {devTools ? "← back to assistant" : `Developer tools${shim ? ` (${tools.length})` : ""}`}
          </button>
          <button
            className="text-xs text-slate-500 hover:text-slate-300"
            onClick={() => uiStore.toggleConsole()}
            aria-label="Close assistant panel"
            title="Close (Ctrl/Cmd + `)"
          >
            close
          </button>
        </div>
      </div>

      {devTools ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2 text-[11px] text-slate-400">
            <p className="min-w-0 flex-1 basis-64">Manual test calls run registered tools. They do not prove ChatGPT is connected or has received data.</p>
            <button className="btn text-xs" onClick={() => setDiscoveryVersion((v) => v + 1)}>
              Refresh discovery
            </button>
            <p className={`w-full break-words ${discoveryError ? "text-danger" : ""}`} role={discoveryError ? "alert" : "status"}>
              {unavailable || `${tools.length} tools discovered. Quick calls execute immediately; unavailable tools are marked below.`}
            </p>
            {registration.settling && !discovering && !discoveryError && (
              <p className="w-full break-words" role="status">
                Registering tools with the host…
              </p>
            )}
            {registration.issues.length > 0 && (
              <p className="w-full break-words text-danger" role="alert">
                {registration.issues.length} registration{registration.issues.length === 1 ? "" : "s"} failed
                ({registration.issues.map((i) => i.tool).join(", ")}). Those tools are missing for every
                caller — host and console alike. Details in the browser console.
              </p>
            )}
          </div>
        <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="max-h-48 min-w-0 overflow-y-auto border-b border-ink-800 p-2 lg:max-h-60 lg:border-r">
            <p className="panel-title mb-1">Quick calls</p>
            {SNIPPETS.map((s) => (
              <button
                key={s.label}
                className="mb-1 block w-full rounded px-2 py-1 text-left text-[11px] text-slate-400 hover:bg-ink-800 hover:text-slate-200 disabled:opacity-50"
                disabled={!!unavailable || !tools.includes(s.tool)}
                title={unavailable || (!tools.includes(s.tool) ? "Tool not discovered. Refresh discovery to retry." : "Execute manual test call")}
                onClick={() => {
                  setTool(s.tool);
                  setArgs(JSON.stringify(s.args, null, 2));
                  void run(s.tool, JSON.stringify(s.args));
                }}
              >
                {s.label}
                {!discovering && !discoveryError && shim && !tools.includes(s.tool) && " (not discovered)"}
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-col gap-2 border-b border-ink-800 p-2 lg:border-r">
            <select
              aria-label="Tool"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              className="min-w-0 max-w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs text-slate-200"
            >
              {!tools.length && <option value="">No tools discovered</option>}
              {tools.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Tool arguments (JSON)"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              className="h-28 min-w-0 resize-y rounded-md border border-ink-700 bg-ink-900 p-2 font-mono text-[11px] text-slate-200 focus:border-airlock-600 focus:outline-none"
            />
            <button className="btn btn-primary text-xs" onClick={() => run()} disabled={!!unavailable || !tools.includes(tool)} title={unavailable || "Execute manual test call"}>
              {busy ? "Running…" : "Execute"}
            </button>
          </div>

          <pre className="max-h-60 min-h-24 min-w-0 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] text-slate-400" aria-live="polite">
            {out || "result appears here"}
          </pre>
        </div>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {brain === "agent" ? <LocalAgentConsole /> : <ByoAgentConsole />}
        </div>
      )}
    </div>
  );
}
