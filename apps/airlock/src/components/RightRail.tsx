import { ReviewPanel } from "./ReviewPanel";
import { ActivityLog } from "./ActivityLog";
import { useUI } from "../engine/uiStore";

export function RightRail() {
  const ui = useUI();
  return (
    <aside className="flex w-96 shrink-0 flex-col bg-ink-900">
      <div className={ui.activityOpen ? "flex min-h-0 flex-[3] flex-col" : "flex min-h-0 flex-1 flex-col"}>
        <ReviewPanel />
      </div>
      <div className={ui.activityOpen ? "flex min-h-0 flex-[2] flex-col" : "shrink-0"}>
        <ActivityLog />
      </div>
    </aside>
  );
}
