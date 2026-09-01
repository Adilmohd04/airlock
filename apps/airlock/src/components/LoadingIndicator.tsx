/**
 * A small, unobtrusive loading indicator surfaced while a dataset is being read
 * and registered into the in-browser query engine. Rendered as a centered pill
 * so it reads the same whether the empty state or the full workspace is behind
 * it. Uses only existing Tailwind semantic tokens (ink / airlock / pending) and
 * the pre-defined `pending-pulse` animation — no new colors are introduced.
 */
export function LoadingIndicator({ name }: { name: string | null }): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-8">
      <div className="flex items-center gap-2.5 rounded-full bg-ink-800/90 px-4 py-2 shadow-lg">
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-pending animate-pending-pulse" />
        <span className="font-mono text-xs text-airlock-300">
          {name ? `Loading ${name}…` : "Loading…"}
        </span>
      </div>
    </div>
  );
}
