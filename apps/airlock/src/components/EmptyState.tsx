import { useEffect, useState } from "react";
import { getDb } from "../engine/duckdb";
import { uiStore } from "../engine/uiStore";
import { FileDrop } from "./FileDrop";

const PROOF_POINTS = [
  { label: "Zero egress", detail: "queried entirely in this tab, by DuckDB-WebAssembly" },
  { label: "Human-gated", detail: "every change is staged as a diff you approve" },
  { label: "Logged", detail: "every read the agent makes is in the activity ledger" },
];

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
      <div className="grid w-full max-w-5xl gap-12 md:grid-cols-2 md:gap-16">
        <div className="flex flex-col justify-center">
          <span className="badge badge-teal mb-4 w-fit">Private by construction</span>
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight text-white">
            An AI agent that analyzes your data
            <br />
            <span className="bg-gradient-to-r from-airlock-300 to-airlock-500 bg-clip-text text-transparent">
              without your data leaving your browser.
            </span>
          </h1>
          <p className="mt-4 max-w-md text-[13.5px] leading-relaxed text-slate-400">
            Load a spreadsheet you&apos;d never paste into a chat window. Airlock
            queries it locally and exposes it to an AI agent — on-device or
            connected over WebMCP — through tools it can read from freely, but
            can only change with your explicit approval.
          </p>

          <dl className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PROOF_POINTS.map((p) => (
              <div key={p.label} className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
                <dt className="text-xs font-medium text-airlock-300">{p.label}</dt>
                <dd className="mt-1 text-[11px] leading-snug text-slate-500">{p.detail}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-6 text-xs text-slate-500">
            Pick the compensation demo →{" "}
            <button
              type="button"
              className="text-airlock-300 hover:underline"
              onClick={() => uiStore.toggleConsole()}
            >
              ask Airlock a question
            </button>{" "}
            → approve what it proposes with Enter.
          </p>

          <p className="mt-5 flex items-center gap-2 font-mono text-[11px] text-slate-600">
            <span
              className={`badge-dot ${
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
