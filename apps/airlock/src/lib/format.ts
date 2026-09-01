const nf = new Intl.NumberFormat("en-US");
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function num(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? nf.format(n) : nf2.format(n);
}

export function pct(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return p < 1 && p > 0 ? "<1%" : `${Math.round(p)}%`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(s: string, max = 48): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function relativeTime(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}
