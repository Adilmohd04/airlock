import { useCallback, useRef, useState } from "react";
import {
  loadDemo as loadDemoDataset,
  loadFile as loadFileDataset,
  loadPastedText,
  pickLocalFile,
  xlsxSheetNames,
} from "../engine/loadFile";
import { sniffDelimiter } from "../lib/importFormats";

const DEMOS = [
  { url: "/demo/compensation.csv", name: "compensation.csv", label: "Compensation review (812 employees)" },
  { url: "/demo/headcount.csv", name: "headcount.csv", label: "Headcount & managers (for the join demo)" },
];

const ACCEPT = ".csv,.tsv,.json,.xlsx,.parquet,text/csv";

/** A multi-sheet workbook waiting for the human to pick a sheet. */
interface PendingWorkbook {
  file: File;
  sheets: string[];
}

export function FileDrop({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<PendingWorkbook | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const runLoad = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadOneFile = useCallback(
    async (f: File, sheet?: string): Promise<"loaded" | "needs-sheet"> => {
      // A multi-sheet .xlsx stops here so the human chooses which sheet — it is
      // never silently truncated to the first one.
      if (!sheet) {
        const sheets = await xlsxSheetNames(f).catch(() => null);
        if (sheets && sheets.length > 1) {
          setPending({ file: f, sheets });
          return "needs-sheet";
        }
      }
      await loadFileDataset(f, sheet ? { sheet } : {});
      return "loaded";
    },
    []
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setPending(null);
      await runLoad(async () => {
        for (const f of Array.from(files)) {
          // Stop the batch on the first workbook that needs a sheet choice;
          // the rest can be re-dropped after.
          if ((await loadOneFile(f)) === "needs-sheet") break;
        }
      });
    },
    [runLoad, loadOneFile]
  );

  const chooseSheet = useCallback(
    (sheet: string) => {
      const wb = pending;
      if (!wb) return;
      setPending(null);
      void runLoad(() => loadFileDataset(wb.file, { sheet }));
    },
    [pending, runLoad]
  );

  const importPaste = useCallback(
    (text: string) => {
      if (!text.trim()) {
        setErr("Nothing to import — the pasted text was empty.");
        return;
      }
      setPasteOpen(false);
      setPasteText("");
      void runLoad(() => loadPastedText(text));
    },
    [runLoad]
  );

  const loadDemo = useCallback(
    (url: string, name: string) => runLoad(() => loadDemoDataset(url, name)),
    [runLoad]
  );

  const pasteGuess = pasteText.trim() ? sniffDelimiter(pasteText) : null;

  if (pending) {
    return (
      <div className={compact ? "" : "w-full max-w-lg"}>
        <p className="text-sm font-medium text-slate-200">
          {pending.file.name} has {pending.sheets.length} sheets
        </p>
        <p className="mt-1 text-xs text-slate-500">Pick one to import.</p>
        <div className="mt-3 space-y-1.5">
          {pending.sheets.map((s) => (
            <button
              key={s}
              onClick={() => chooseSheet(s)}
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-40"
            >
              <span className="font-mono text-xs text-airlock-400">{s}</span>
            </button>
          ))}
        </div>
        <button
          className="mt-2 text-[11px] text-slate-500 hover:text-slate-300"
          onClick={() => setPending(null)}
        >
          cancel
        </button>
        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
      </div>
    );
  }

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
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (text.trim()) {
            e.preventDefault();
            importPaste(text);
          }
        }}
        onClick={() => inputRef.current?.click()}
        tabIndex={0}
        className={`cursor-pointer rounded-xl border border-dashed px-6 text-center outline-none transition-colors focus-visible:border-airlock-400 ${
          compact ? "py-4" : "py-10"
        } ${over ? "border-airlock-400 bg-airlock-700/10" : "border-ink-600 hover:border-ink-500 hover:bg-ink-900"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {busy ? (
          <p className="text-sm text-airlock-300">Loading — locally…</p>
        ) : (
          <>
            <p className={`font-medium text-slate-200 ${compact ? "text-sm" : ""}`}>
              Drop a CSV, TSV, JSON, Excel or Parquet file
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Or click to browse, or paste table data. Read in this tab. Never uploaded.
            </p>
          </>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px]">
        <button
          className="text-slate-500 hover:text-slate-300"
          onClick={() =>
            void runLoad(async () => {
              const f = await pickLocalFile();
              if (f) await loadOneFile(f);
            })
          }
          disabled={busy}
        >
          Browse local file…
        </button>
        <span className="text-ink-700">·</span>
        <button
          className="text-slate-500 hover:text-slate-300"
          onClick={() => {
            setErr(null);
            setPasteOpen((v) => !v);
          }}
          disabled={busy}
        >
          {pasteOpen ? "Hide paste box" : "Paste data"}
        </button>
      </div>

      {pasteOpen && (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste rows copied from a spreadsheet or a CSV…"
            rows={compact ? 3 : 5}
            className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-[11px] text-slate-300 outline-none focus:border-airlock-500"
          />
          <div className="flex items-center justify-between text-[10px] text-slate-500">
            <span>
              {pasteGuess
                ? `Detected ${pasteGuess.label}-separated, ${pasteGuess.columns} column(s)${
                    pasteGuess.consistent ? "" : " — rows vary, check the result"
                  }`
                : "Delimiter auto-detected on import"}
            </span>
            <button
              className="btn btn-ghost text-[11px]"
              onClick={() => importPaste(pasteText)}
              disabled={busy || !pasteText.trim()}
            >
              Import pasted data
            </button>
          </div>
        </div>
      )}

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
