/**
 * Session menu — the human-facing control for Airlock's persistence layer
 * (`lib/persistence.ts`). Shows the current named session and drops down a list
 * you can switch between, rename, delete, or start fresh from. Autosave and the
 * one-time boot restore are wired here via `useSessionBoot()` so `App` only has
 * to mount this one component.
 *
 * When IndexedDB is unavailable (private window, blocked storage) this degrades
 * to a static "not saved" pill — the rest of the app is unaffected.
 */

import { useEffect, useRef, useState } from "react";
import {
  deleteSession,
  newSession,
  renameSession,
  switchSession,
  usePersistence,
  useSessionBoot,
} from "../lib/persistence";
import { relativeTime } from "../lib/format";

export function SessionMenu() {
  useSessionBoot();
  const p = usePersistence();
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = p.sessions.find((s) => s.id === p.currentSessionId) ?? null;

  const label = !p.available
    ? "Not saved"
    : p.busy
      ? "Restoring…"
      : current
        ? current.name
        : "Unsaved session";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title={
          p.available
            ? "Named sessions — saved in this browser (IndexedDB), never uploaded"
            : "Storage is unavailable here — this workspace will not be saved"
        }
        className="flex max-w-[13rem] shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs hover:bg-ink-800"
      >
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            !p.available
              ? "bg-ink-500"
              : p.degraded
                ? "bg-danger"
                : p.busy
                  ? "bg-pending animate-pending-pulse"
                  : "bg-commit"
          }`}
        />
        <span className="truncate font-medium text-slate-300">{label}</span>
        {p.available && <span className="shrink-0 text-slate-600">▾</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-30 w-80 animate-slide-in rounded-lg border border-ink-700 bg-ink-900 p-3 text-xs shadow-2xl">
          {!p.available ? (
            <p className="leading-relaxed text-slate-400">
              This browser blocked local storage (private window or site
              settings), so the workspace can’t be saved. Everything else works —
              your data still never leaves the tab.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="panel-title">Sessions</p>
                <button
                  type="button"
                  className="text-airlock-400 hover:underline"
                  onClick={() => {
                    void newSession();
                    setOpen(false);
                  }}
                >
                  + New
                </button>
              </div>

              {p.degraded && (
                <p className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] leading-snug text-danger">
                  A save didn’t complete (storage full or blocked). Recent
                  changes may not be persisted.
                </p>
              )}

              <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {p.sessions.length === 0 && (
                  <li className="py-3 text-center text-[11px] text-slate-600">
                    No saved sessions yet. Load a dataset and it’s saved
                    automatically.
                  </li>
                )}
                {p.sessions.map((s) => {
                  const isCurrent = s.id === p.currentSessionId;
                  return (
                    <li
                      key={s.id}
                      className={`group rounded-md px-2 py-1.5 ${
                        isCurrent ? "bg-airlock-700/15" : "hover:bg-ink-850"
                      }`}
                    >
                      {renamingId === s.id ? (
                        <RenameRow
                          initial={s.name}
                          onCancel={() => setRenamingId(null)}
                          onSave={(name) => {
                            void renameSession(s.id, name);
                            setRenamingId(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col text-left"
                            disabled={p.busy}
                            onClick={() => {
                              if (!isCurrent) void switchSession(s.id);
                              setOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                                  isCurrent ? "bg-airlock-400" : "bg-ink-600"
                                }`}
                              />
                              <span className="truncate font-mono text-slate-200">
                                {s.name}
                              </span>
                            </span>
                            <span className="ml-3 mt-0.5 text-[10px] text-slate-600">
                              {s.datasetCount} dataset
                              {s.datasetCount === 1 ? "" : "s"} ·{" "}
                              {relativeTime(s.updatedAt)}
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                            <button
                              type="button"
                              className="px-1 text-slate-500 hover:text-slate-200"
                              title="Rename"
                              onClick={() => setRenamingId(s.id)}
                            >
                              rename
                            </button>
                            <button
                              type="button"
                              className="px-1 text-slate-500 hover:text-danger"
                              title="Delete this session"
                              aria-label={`Delete session ${s.name}`}
                              onClick={() => void deleteSession(s.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              <p className="mt-2 border-t border-ink-800 pt-2 text-[10px] leading-relaxed text-slate-600">
                Saved to this browser only (IndexedDB). Nothing is uploaded — the
                Seal still reads 0 bytes out.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RenameRow({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-950 px-1.5 py-1 font-mono text-slate-200 outline-none focus:border-airlock-500"
      />
      <button type="submit" className="px-1 text-airlock-400 hover:underline">
        save
      </button>
      <button
        type="button"
        className="px-1 text-slate-500 hover:text-slate-300"
        onClick={onCancel}
      >
        cancel
      </button>
    </form>
  );
}
