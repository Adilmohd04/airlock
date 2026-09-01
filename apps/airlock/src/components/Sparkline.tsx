/** A tiny inline histogram bar-strip for numeric column profiles. */
export function Sparkline({
  bins,
  className = "",
}: {
  bins: number[];
  className?: string;
}) {
  const max = Math.max(1, ...bins);
  return (
    <div className={`flex h-6 items-end gap-px ${className}`}>
      {bins.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-airlock-500/70"
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
