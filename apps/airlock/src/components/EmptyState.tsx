import { useEffect, useState } from "react";
import { getDb } from "../engine/duckdb";
import { FileDrop } from "./FileDrop";

export function EmptyState() {
  // Warm DuckDB-WASM while the user reads the intro / picks a file, so the
  // ~35 MB cold start is off the critical path once they load something.
  const [engine, setEngine] = useState<"warming" | "ready" | "deferred">("warming");
  useEffect(() => {
    let alive = true;
    getDb()
      .then(() => alive && setEngine("ready"))
      .catch(() => alive && setEngine("deferred"));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="grid w-full max-w-4xl gap-10 md:grid-cols-2">
        <div className="flex flex-col justify-center">
          <h1 className="text-2xl font-semibold leading-snug text-white">
            The agent analyzes your data.
            <br />
            <span className="text-airlock-400">The data stays in your browser.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Load a spreadsheet you would never paste into a chat window. Airlock
            queries it locally with DuckDB-WebAssembly and exposes a set of
            WebMCP tools an AI agent can use to explore it.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-slate-400">
            <li className="flex gap-2">
              <Dot /> Read tools run instantly — the agent can look, never touch.
            </li>
            <li className="flex gap-2">
              <Dot /> Every change is staged as a diff you approve or reject.
            </li>
            <li className="flex gap-2">
              <Dot /> An activity ledger records every query and every payload.
            </li>
          </ul>
          <p className="mt-5 flex items-center gap-2 font-mono text-[11px] text-slate-600">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                engine === "ready"
                  ? "bg-commit"
                  : engine === "warming"
                    ? "bg-pending animate-pending-pulse"
                    : "bg-ink-500"
              }`}
            />
            {engine === "ready"
              ? "Query engine ready — loads stay local"
              : engine === "warming"
                ? "Preparing the in-browser query engine (~35 MB, one time)…"
                : "Query engine starts when you load a file"}
          </p>
        </div>
        <div className="flex items-center">
          <FileDrop />
        </div>
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-airlock-500" />
  );
}
