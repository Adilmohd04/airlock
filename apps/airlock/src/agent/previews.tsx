/**
 * Typed diff-preview renderers. Each staged tool's `prepare()` returns a
 * `ToolPreview`; this turns it into a structured diff the human reads at a
 * glance — never a paragraph of prose.
 */

import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
} from "recharts";
import type { ToolPreview } from "./previewTypes";
import type { CitationStats } from "./citations";
import { Markdown } from "../lib/markdown";
import { num } from "../lib/format";

export function PreviewBody({ preview }: { preview: ToolPreview }) {
  switch (preview.kind) {
    case "add_filter":
    case "remove_filter":
      return (
        <RowDelta
          code={preview.expression}
          before={preview.rowsBefore}
          after={preview.rowsAfter}
          removing={preview.kind === "remove_filter"}
        />
      );

    case "clear_filters":
      return (
        <RowDelta
          code={`clearing ${preview.count} filter(s)`}
          before={preview.rowsBefore}
          after={preview.rowsAfter}
          removing
        />
      );

    case "add_derived_column":
      return (
        <div className="space-y-2">
          <Code>
            {preview.name} = {preview.expression}
          </Code>
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {preview.samples.map((s, i) => (
                <tr key={i} className="border-t border-ink-800">
                  <td className="py-1 pr-2 text-slate-500">
                    {Object.values(s.row).map(String).join(" · ")}
                  </td>
                  <td className="py-1 text-right text-airlock-300">
                    → {fmtVal(s.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "remove_derived_column":
      return (
        <Code className="line-through opacity-70">
          {preview.name} = {preview.expression}
        </Code>
      );

    case "rename_column":
      return (
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-slate-400 line-through">
            {preview.from}
          </span>
          <span className="text-slate-600">→</span>
          <span className="rounded bg-airlock-700/20 px-1.5 py-0.5 text-airlock-300">
            {preview.to}
          </span>
          <span className="text-[10px] text-slate-600">({preview.type})</span>
        </div>
      );

    case "redact_column":
      return (
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2 font-mono">
            <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">
              redact {preview.column}
            </span>
            <span className="text-[10px] text-slate-600">({preview.type})</span>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">
            The agent will lose all access to this column — values, samples,
            aggregates and any derived column built from it. Only you can undo this.
          </p>
          {preview.suggestedByHeuristic && (
            <p className="text-[10px] text-pending">
              Flagged by the pre-flight PII heuristic.
            </p>
          )}
        </div>
      );

    case "add_chart":
      return (
        <div>
          <Code className="mb-2">{preview.sql}</Code>
          <div className="h-24 rounded-md border border-ink-800 bg-ink-950 p-1">
            <ResponsiveContainer width="100%" height="100%">
              {preview.chartKind === "bar" ? (
                <BarChart data={preview.data}>
                  <Bar dataKey="value" fill="#17b3a3" radius={[2, 2, 0, 0]} />
                </BarChart>
              ) : (
                <LineChart data={preview.data}>
                  <Line
                    dataKey="value"
                    stroke="#3dd7c4"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10px] text-slate-600">
            {preview.data.length} points
          </p>
        </div>
      );

    case "flag_rows":
      return (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold text-pending">
              {num(preview.count)}
            </span>
            <span className="text-xs text-slate-400">rows · {preview.reason}</span>
          </div>
          <Code>{preview.expression}</Code>
          {preview.sample.length > 0 && (
            <p className="font-mono text-[10px] text-slate-600">
              e.g. {Object.values(preview.sample[0]).slice(0, 4).map(String).join(" · ")}
            </p>
          )}
        </div>
      );

    case "join_datasets":
      return (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5 font-mono">
            <span className="rounded bg-ink-800 px-1.5 py-0.5">{preview.leftName}</span>
            <span className="text-slate-600">
              {preview.type === "left" ? "⟕" : "⋈"}
            </span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">{preview.rightName}</span>
          </div>
          <div className="font-mono text-[11px] text-slate-500">
            on {preview.on.map((p) => `${p.left} = ${p.right}`).join(", ")}
          </div>
          <div className="flex gap-4 border-t border-ink-800 pt-2">
            <Stat label="result rows" value={num(preview.rowCount)} />
            <Stat label="columns" value={String(preview.columns.length)} />
          </div>
        </div>
      );

    case "export_view":
      return (
        <div className="space-y-2 text-xs">
          <div className="rounded-md border border-pending/30 bg-pending/5 px-2 py-1.5 text-[11px] text-pending">
            This writes a file to your Downloads folder — the one action that
            takes data out of the browser.
          </div>
          <Code>{preview.filename}</Code>
          <div className="flex gap-4">
            <Stat label="rows" value={num(preview.rows)} />
            <Stat label="columns" value={String(preview.columns.length)} />
          </div>
          <ul className="font-mono text-[10px] text-slate-500">
            {preview.appliedTransforms.map((t, i) => (
              <li key={i}>· {t}</li>
            ))}
          </ul>
        </div>
      );

    case "write_report":
      return (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
            <span className="text-slate-600">{preview.words} words · preview</span>
            <CitationSummary citations={preview.citations} />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border border-ink-800 bg-ink-950 px-3 py-2">
            <Markdown source={preview.markdown} />
          </div>
        </div>
      );

    default:
      return null;
  }
}

function RowDelta({
  code,
  before,
  after,
  removing,
}: {
  code: string;
  before: number;
  after: number;
  removing?: boolean;
}) {
  const delta = after - before;
  return (
    <div className="space-y-2">
      <Code>{code}</Code>
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="text-slate-500">{num(before)}</span>
        <span className="text-slate-600">→</span>
        <span className="text-slate-200">{num(after)} rows</span>
        <span
          className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${
            delta === 0
              ? "bg-ink-800 text-slate-500"
              : (delta > 0) === !removing
                ? "bg-commit/15 text-commit"
                : "bg-danger/15 text-danger"
          }`}
        >
          {delta > 0 ? "+" : ""}
          {num(delta)}
        </span>
      </div>
    </div>
  );
}

function Code({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-md border border-ink-800 bg-ink-950 px-2 py-1.5 font-mono text-[11px] text-slate-300 ${className}`}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-sm text-slate-200">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </div>
    </div>
  );
}

// Evidence-quality summary the human reads BEFORE approving — cited claims in
// commit green, uncited in pending amber, broken citations in danger red, so
// the three counts read at the same glance as the row-delta chips above.
function CitationSummary({ citations }: { citations: CitationStats }) {
  const { citedClaims, uncitedClaims, brokenCitations } = citations;
  if (citedClaims === 0 && uncitedClaims === 0 && brokenCitations === 0) {
    return <span className="text-slate-600">no numeric claims detected</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone="commit">{citedClaims} cited</Badge>
      <Badge tone={uncitedClaims > 0 ? "pending" : "muted"}>
        {uncitedClaims} uncited
      </Badge>
      {brokenCitations > 0 && (
        <Badge tone="danger">
          {brokenCitations} broken citation{brokenCitations === 1 ? "" : "s"}
        </Badge>
      )}
    </span>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "commit" | "pending" | "danger" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "commit"
      ? "bg-commit/15 text-commit"
      : tone === "pending"
        ? "bg-pending/15 text-pending"
        : tone === "danger"
          ? "bg-danger/15 text-danger"
          : "bg-ink-800 text-slate-500";
  return <span className={`rounded px-1.5 py-0.5 font-mono ${cls}`}>{children}</span>;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
