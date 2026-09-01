/**
 * Typed diff previews. Every staged tool's `prepare()` returns one of these as
 * its `preview`, and `ProposalCard` renders it as a structured diff — not a
 * paragraph of prose. The shape IS the review experience.
 */

export type ToolPreview =
  | {
      kind: "add_filter";
      expression: string;
      label: string;
      rowsBefore: number;
      rowsAfter: number;
    }
  | {
      kind: "remove_filter";
      label: string;
      expression: string;
      rowsBefore: number;
      rowsAfter: number;
    }
  | { kind: "clear_filters"; count: number; rowsBefore: number; rowsAfter: number }
  | {
      kind: "add_derived_column";
      name: string;
      expression: string;
      samples: { row: Record<string, unknown>; value: unknown }[];
    }
  | { kind: "remove_derived_column"; name: string; expression: string }
  | { kind: "rename_column"; from: string; to: string; type: string }
  | {
      kind: "redact_column";
      column: string;
      type: string;
      suggestedByHeuristic: boolean;
    }
  | {
      kind: "add_chart";
      title: string;
      chartKind: "bar" | "line";
      sql: string;
      data: { label: string; value: number }[];
    }
  | {
      kind: "flag_rows";
      expression: string;
      reason: string;
      count: number;
      sample: Record<string, unknown>[];
    }
  | {
      kind: "join_datasets";
      leftName: string;
      rightName: string;
      on: { left: string; right: string }[];
      type: "inner" | "left";
      rowCount: number;
      columns: string[];
    }
  | {
      kind: "export_view";
      filename: string;
      rows: number;
      columns: string[];
      appliedTransforms: string[];
    }
  | { kind: "write_report"; title: string; markdown: string; words: number };
