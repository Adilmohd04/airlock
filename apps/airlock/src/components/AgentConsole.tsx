import { useEffect, useMemo, useState } from "react";
import { uiStore } from "../engine/uiStore";
import { LocalAgentConsole } from "./LocalAgentConsole";
import { ByoAgentConsole } from "./ByoAgentConsole";

/**
 * The Agent console — a developer / demo surface, NOT a hidden LLM.
 *
 * It lists the WebMCP tools this page has registered and lets you invoke one
 * with a JSON argument object, using the polyfill's testing shim
 * (`navigator.modelContextTesting`) or the Chrome preview's equivalent. It's how
 * you exercise the full propose → approve → commit loop without ChatGPT, and
 * it's what the demo video drives.
 */

interface TestingShim {
  listTools: () => { name: string; description?: string }[];
  executeTool: (name: string, argsJson: string) => Promise<unknown>;
}

function getShim(): TestingShim | null {
  const n = navigator as unknown as { modelContextTesting?: TestingShim };
  return n.modelContextTesting ?? null;
}

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
  const shim = useMemo(getShim, []);
  const [tools, setTools] = useState<string[]>([]);
  const [tool, setTool] = useState("get_dataset_summary");
  const [args, setArgs] = useState("{}");
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // The console has three faces: the local agent (drives the on-device
  // model), the BYO agent (drives the user's own endpoint), and the manual
  // tool caller (developer/demo surface). Default to the local agent — it's
  // the headline.
  const [view, setView] = useState<"agent" | "byo" | "manual">("agent");

  useEffect(() => {
    if (shim) {
      try {
        setTools(shim.listTools().map((t) => t.name).sort());
      } catch {
        /* ignore */
      }
    }
  }, [shim]);

  const run = async (t = tool, a = args) => {
    if (!shim) return;
    setBusy(true);
    setOut("");
    try {
      const res = await shim.executeTool(t, a);
      setOut(
        typeof res === "string" ? res : JSON.stringify(res, null, 2)
      );
    } catch (e) {
      setOut(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-80 shrink-0 border-t border-ink-700 bg-ink-950">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="panel-title">Agent console</span>
          <div className="ml-2 flex overflow-hidden rounded border border-ink-700 text-[11px]">
            <button
              className={`px-2 py-0.5 ${view === "agent" ? "bg-ink-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
              onClick={() => setView("agent")}
            >
              Local agent
            </button>
            <button
              className={`px-2 py-0.5 ${view === "byo" ? "bg-ink-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
              onClick={() => setView("byo")}
            >
              BYO agent
            </button>
            <button
              className={`px-2 py-0.5 ${view === "manual" ? "bg-ink-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
              onClick={() => setView("manual")}
            >
              Manual tools
              <span className="ml-1.5 font-normal text-slate-600">
                {shim ? tools.length : "—"}
              </span>
            </button>
          </div>
        </div>
        <button
          className="text-xs text-slate-500 hover:text-slate-300"
          onClick={() => uiStore.toggleConsole()}
        >
          close  (Ctrl/Cmd + `)
        </button>
      </div>

      {view === "agent" ? (
        <div className="h-[calc(100%-33px)]">
          <LocalAgentConsole />
        </div>
      ) : view === "byo" ? (
        <div className="h-[calc(100%-33px)]">
          <ByoAgentConsole />
        </div>
      ) : (
      <div className="grid h-[calc(100%-33px)] grid-cols-[200px_1fr_1fr]">
        <div className="overflow-y-auto border-r border-ink-800 p-2">
          <p className="panel-title mb-1">Quick calls</p>
          {SNIPPETS.map((s) => (
            <button
              key={s.label}
              className="mb-1 block w-full rounded px-2 py-1 text-left text-[11px] text-slate-400 hover:bg-ink-800 hover:text-slate-200"
              onClick={() => {
                setTool(s.tool);
                setArgs(JSON.stringify(s.args, null, 2));
                void run(s.tool, JSON.stringify(s.args));
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 border-r border-ink-800 p-2">
          <select
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs text-slate-200"
          >
            {(tools.length ? tools : [tool]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <textarea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-md border border-ink-700 bg-ink-900 p-2 font-mono text-[11px] text-slate-200 focus:border-airlock-600 focus:outline-none"
          />
          <button
            className="btn btn-primary text-xs"
            onClick={() => run()}
            disabled={busy || !shim}
          >
            {busy ? "Running…" : "Execute"}
          </button>
        </div>

        <pre className="overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] text-slate-400">
          {out || "result appears here"}
        </pre>
      </div>
      )}
    </div>
  );
}
