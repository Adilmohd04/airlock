/** Rows -> RFC-4180-ish CSV string, entirely in the browser. */
export function rowsToCsv(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(esc).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}

/**
 * Trigger a client-side download. This is the one place bytes intentionally
 * leave the page — into the user's own Downloads folder, on their explicit
 * approval, never over the network.
 */
export function downloadText(
  filename: string,
  text: string,
  mime = "text/plain;charset=utf-8"
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
