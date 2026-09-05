import { useWorkspace } from "../engine/useDataset";
import { workspaceStore } from "../engine/workspaceStore";
import { num } from "../lib/format";
import { ConfirmButton } from "./ConfirmButton";

export function DatasetSwitcher() {
  const ws = useWorkspace();
  if (ws.datasets.length === 0) return null;

  return (
    <div className="border-b border-ink-800 p-3">
      <p className="panel-title mb-2">Datasets</p>
      <div className="space-y-1">
        {ws.datasets.map((h) => {
          const st = h.store.getState();
          const active = h.id === ws.activeId;
          return (
            <div
              key={h.id}
              className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                active
                  ? "bg-airlock-700/15 text-white"
                  : "text-slate-400 hover:bg-ink-800"
              }`}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => workspaceStore.setActive(h.id)}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    active ? "bg-airlock-400" : "bg-ink-600"
                  }`}
                />
                <span className="truncate font-mono">{st.fileName}</span>
                {st.source === "join" && (
                  <span className="chip !py-0 !text-[10px] text-airlock-300">join</span>
                )}
              </button>
              <span className="shrink-0 tabular-nums text-slate-600">
                {num(st.totalRows)}
              </span>
              {ws.datasets.length > 1 && (
                <ConfirmButton
                  // Opacity (not `hidden`/display:none) so the resting ✕ stays
                  // in the tab order — a keyboard user can reach it even though
                  // a mouse user only sees it on hover.
                  className="shrink-0 text-slate-600 opacity-0 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                  onConfirm={() => void workspaceStore.removeDataset(h.id).catch(() => {})}
                  ariaLabel={`Remove dataset ${st.fileName}`}
                  confirmLabel="remove?"
                  title="Remove dataset"
                >
                  ✕
                </ConfirmButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
