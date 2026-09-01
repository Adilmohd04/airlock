/**
 * Shown only below ~720px (CSS-driven, see `.airlock-mobile-gate`). Airlock is a
 * two-rail review workspace with a data grid — there is no honest small-screen
 * layout, so we ask for a wider window instead of shipping a broken one.
 */
export function MobileGate() {
  return (
    <div className="airlock-mobile-gate" role="alertdialog" aria-label="Wider screen required">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-airlock-500 text-ink-950">
        <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
          <path d="M8 1a4 4 0 0 0-4 4v2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-1V5a4 4 0 0 0-4-4Zm2 6H6V5a2 2 0 1 1 4 0v2Z" />
        </svg>
      </div>
      <p className="text-base font-semibold text-white">Airlock needs a wider screen</p>
      <p className="max-w-xs text-sm leading-relaxed text-slate-400">
        The data grid, the diff review queue, and the activity ledger sit
        side by side. Open this on a screen at least 720px wide.
      </p>
      <p className="font-mono text-[11px] text-slate-600">
        your data still never leaves the browser
      </p>
    </div>
  );
}
