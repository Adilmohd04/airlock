import { useCallback, useRef, useState } from "react";
import { loadDemo as loadDemoDataset, loadFile as loadFileDataset } from "../engine/loadFile";

const DEMOS = [
  { url: "/demo/compensation.csv", name: "compensation.csv", label: "Compensation review (812 employees)" },
  { url: "/demo/headcount.csv", name: "headcount.csv", label: "Headcount & managers (for the join demo)" },
];

export function FileDrop({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) await loadFileDataset(f);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadDemo = useCallback(async (url: string, name: string) => {
    setBusy(true);
    setErr(null);
    try {
      await loadDemoDataset(url, name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className={compact ? "" : "w-full max-w-lg"}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border border-dashed px-6 text-center transition-colors ${
          compact ? "py-4" : "py-10"
        } ${over ? "border-airlock-400 bg-airlock-700/10" : "border-ink-600 hover:border-ink-500 hover:bg-ink-900"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.json,text/csv"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {busy ? (
          <p className="text-sm text-airlock-300">Loading — locally…</p>
        ) : (
          <>
            <p className={`font-medium text-slate-200 ${compact ? "text-sm" : ""}`}>
              Drop a CSV or JSON file
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Read in this tab. Never uploaded.
            </p>
          </>
        )}
      </div>

      {!compact && (
        <div className="mt-4">
          <p className="panel-title mb-2">Or load a demo</p>
          <div className="space-y-1.5">
            {DEMOS.map((d) => (
              <button
                key={d.url}
                onClick={() => void loadDemo(d.url, d.name)}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-40"
              >
                <span className="font-mono text-xs text-airlock-400">{d.name}</span>
                <span className="text-xs text-slate-500">{d.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {err && <p className="mt-3 text-xs text-danger">{err}</p>}
    </div>
  );
}
