import { useEffect, useState, type ReactNode } from "react";
import { getDb } from "../engine/duckdb";
import { uiStore } from "../engine/uiStore";
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
          <h1 className="text-[28px] font-semibold leading-[1.2] tracking-tight text-white">
            The agent analyzes your data.
            <br />
            <span className="bg-gradient-to-r from-airlock-300 to-airlock-500 bg-clip-text text-transparent">The data stays in your browser.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            Load a spreadsheet you would never paste into a chat window — CSV,
            TSV, JSON, Parquet, PDF, DOCX or an image (OCR&apos;d on-device).
            Airlock queries it locally with DuckDB-WebAssembly and exposes a set
            of WebMCP tools an AI agent can use to explore it.
          </p>
          <ol className="mt-4 space-y-2 text-sm text-slate-400">
            <Step n="1" text="Pick the Compensation demo on the right — 812 synthetic employees, nothing real." />
            <Step
              n="2"
              text="Open the Agent console and run a quick call — no ChatGPT, no setup."
              action={
                <button
                  type="button"
                  className="ml-1 text-airlock-300 hover:underline"
                  onClick={() => uiStore.toggleConsole()}
                >
                  Open console (Ctrl/`).
                </button>
              }
            />
            <Step n="3" text="Approve the staged diff with Enter — the agent proposes, you apply." />
          </ol>
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

function Step({
  n,
  text,
  action,
}: {
  n: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <li className="flex gap-2">
      <span className="font-mono text-airlock-400">{n}.</span>
      <span>
        {text}
        {action}
      </span>
    </li>
  );
}
