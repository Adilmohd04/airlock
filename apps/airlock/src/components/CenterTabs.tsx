import { useActiveDataset } from "../engine/useDataset";
import { useUI, uiStore, type CenterTab } from "../engine/uiStore";
import { useReports } from "../agent/hooks";
import { FilterBar } from "./FilterBar";

export function CenterTabs() {
  const ui = useUI();
  const { state } = useActiveDataset();
  const reports = useReports();

  const tabs: { id: CenterTab; label: string; badge?: number }[] = [
    { id: "grid", label: "Grid" },
    { id: "charts", label: "Charts", badge: state?.charts.length || undefined },
    { id: "report", label: "Report", badge: reports.length || undefined },
  ];

  return (
    <div className="shrink-0 border-b border-ink-800 bg-ink-900">
      <div className="flex items-center gap-1 px-3 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => uiStore.setTab(t.id)}
            className={`relative rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors ${
              ui.tab === t.id
                ? "bg-ink-950 text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {t.label}
            {t.badge ? (
              <span className="ml-1.5 rounded-full bg-ink-700 px-1.5 text-[10px] text-slate-300">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {ui.tab === "grid" && <FilterBar />}
    </div>
  );
}
