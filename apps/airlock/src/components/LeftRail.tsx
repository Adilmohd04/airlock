import { DatasetSwitcher } from "./DatasetSwitcher";
import { ColumnList } from "./ColumnList";
import { FileDrop } from "./FileDrop";
import { useState } from "react";

export function LeftRail() {
  const [adding, setAdding] = useState(false);
  return (
    <aside className="flex w-72 shrink-0 flex-col bg-ink-900">
      <DatasetSwitcher />
      <ColumnList />
      <div className="border-t border-ink-800 p-3">
        {adding ? (
          <div className="space-y-2">
            <FileDrop compact />
            <button
              className="w-full text-center text-[11px] text-slate-500 hover:text-slate-300"
              onClick={() => setAdding(false)}
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            className="btn btn-ghost w-full text-xs"
            onClick={() => setAdding(true)}
          >
            + Add dataset
          </button>
        )}
      </div>
    </aside>
  );
}
