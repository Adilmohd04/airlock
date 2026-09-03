/**
 * The system prompt + the response grammar for the local agent loop (T1-b).
 *
 * ── Why this file is separate ───────────────────────────────────────────────
 * The prompt IS the contract that makes a 1-3B model a reliable tool caller.
 * None of the catalog models support WebLLM's native `tools` path
 * (`supportsNativeToolCalls: false`), so every turn is constrained with
 * `response_format: { type: "json_object", schema }`. The schema below is what
 * the grammar engine masks logits against — the model literally cannot emit a
 * token that leaves it. That is the mechanism, not a hope, and it is why the
 * prompt can be short: the shape is enforced, so the words only have to explain
 * intent and the rules a schema can't express.
 *
 * ── The one decision baked in here ──────────────────────────────────────────
 * The model is given the READ tools and the PROPOSE tools, and told that
 * proposing is the end of its turn for that change — a human approves it, out
 * of band. It is NOT given `commit_*` / `reject_*`. Committing is a human act
 * in Airlock (see reviewController.ts), and handing the model a commit verb it
 * can call would be exactly the "write that skips the review queue" the whole
 * product forbids (BUILD_PROMPT guardrail #2). So we shape the toolset the
 * model sees, in the prompt, to the honest half.
 */

/** A tool as the model should see it: name, description, and its input shape. */
export interface PromptTool {
  name: string;
  description: string;
  /** JSON-Schema-ish object, already parsed from the model-context string. */
  inputSchema: unknown;
}

/**
 * The single JSON object the model must emit every turn. One of `call` or
 * `final` — never both, never neither. Kept deliberately flat: nested unions
 * confuse small models and blow up the grammar.
 *
 * Serialized (as a string) and handed to WebLLM as `response_format.schema`.
 */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // A short, plain-language note. First so the model "thinks" before it acts,
    // which measurably improves small-model tool choice.
    reasoning: {
      type: "string",
      description: "One sentence: what you are doing and why.",
    },
    // Exactly one of the next two is filled. The prompt explains the rule the
    // schema can't: pick one.
    tool: {
      type: "string",
      description:
        "The name of the tool to call this turn. Omit (empty) if you are done.",
    },
    arguments: {
      type: "object",
      description: "Arguments for the tool, matching its input schema.",
      additionalProperties: true,
    },
    final_answer: {
      type: "string",
      description:
        "Your final summary to the user. Fill this ONLY when the goal is complete and you are calling no tool.",
    },
  },
  required: ["reasoning"],
  additionalProperties: false,
} as const;

/** The schema, serialized the way WebLLM's `response_format.schema` wants it. */
export const RESPONSE_SCHEMA_JSON = JSON.stringify(RESPONSE_SCHEMA);

/** One parsed turn from the model. */
export interface AgentTurn {
  reasoning: string;
  /** Non-empty when the model wants to call a tool this turn. */
  tool?: string;
  arguments?: Record<string, unknown>;
  /** Non-empty when the model is finishing. */
  finalAnswer?: string;
}

// Field-name aliases a 1-3B model reaches for when it doesn't follow the schema
// exactly. Order matters only for readability; first match wins.
const TOOL_KEYS = ["tool", "tool_name", "toolName", "name", "action", "function", "function_name"];
const ARG_KEYS = ["arguments", "args", "params", "parameters", "input", "tool_input", "toolInput", "function_arguments"];
const FINAL_KEYS = ["final_answer", "finalAnswer", "final", "answer", "summary", "result", "response", "output"];
const REASON_KEYS = ["reasoning", "reason", "thought", "thinking", "rationale", "plan"];
const RESERVED = new Set([...TOOL_KEYS, ...ARG_KEYS, ...FINAL_KEYS, ...REASON_KEYS]);

/**
 * Parse and normalize one model turn. Returns null only when nothing
 * object-shaped can be recovered at all — the loop turns that into a corrective
 * retry rather than a crash.
 *
 * A 1-3B model under memory pressure breaks the grammar in a handful of
 * predictable ways: it wraps the object in a ```json fence or a `<think>` block,
 * emits an array, uses `args`/`params`/`name` instead of the schema's keys, or
 * — most common — *flattens* the tool arguments to siblings of `tool` instead
 * of nesting them under `arguments`. Every one of those is recovered here so a
 * weak model still completes the demo.
 */
export function parseTurn(text: string): AgentTurn | null {
  const o = coerceObject(text);
  if (!o) return null;

  const reasoning = firstString(o, REASON_KEYS) ?? "";
  const tool = trimmedOrUndef(firstString(o, TOOL_KEYS));
  const finalAnswer = trimmedOrUndef(firstString(o, FINAL_KEYS));

  // Arguments: an explicit wrapper object (under any alias), or — when the
  // model flattened them — every key that isn't one of ours.
  let args: Record<string, unknown> | undefined;
  for (const k of ARG_KEYS) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      args = v as Record<string, unknown>;
      break;
    }
    if (typeof v === "string") {
      // Some models stringify the args object. Try to recover it.
      try {
        const p = JSON.parse(v);
        if (p && typeof p === "object" && !Array.isArray(p)) {
          args = p as Record<string, unknown>;
          break;
        }
      } catch {
        /* not JSON — ignore, fall through to flattened recovery */
      }
    }
  }
  if (!args && tool) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!RESERVED.has(k)) rest[k] = v;
    if (Object.keys(rest).length > 0) args = rest;
  }

  // A turn with neither a tool nor a final answer isn't actionable. Reject so
  // the loop nudges the model rather than spinning on an empty step.
  if (!tool && !finalAnswer) return null;

  return {
    reasoning,
    tool,
    arguments: tool ? (args ?? {}) : undefined,
    finalAnswer,
  };
}

/** Recover the one JSON object from a model turn, tolerating the usual noise. */
function coerceObject(text: string): Record<string, unknown> | null {
  let t = String(text ?? "").trim();
  // Chain-of-thought tags some instruct models still emit despite the grammar.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // A leading ```json / ``` fence and its close.
  t = t.replace(/^`{3,}(?:json|js)?\s*/i, "").replace(/\s*`{3,}\s*$/i, "").trim();

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) {
        const first = v.find((x) => x && typeof x === "object" && !Array.isArray(x));
        return (first as Record<string, unknown>) ?? null;
      }
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  return (
    tryParse(t) ??
    tryParse(extractFirstObject(t) ?? "") ??
    // Last resort: a truncated object (hit the token cap mid-value). Close the
    // open strings/braces and retry — a partial `get_dataset_summary` call is
    // still worth salvaging.
    tryParse(repairTruncated(extractFirstOpenObject(t) ?? ""))
  );
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}
function trimmedOrUndef(s: string | undefined): string | undefined {
  const v = s?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** Like extractFirstObject but returns from the first `{` even if never closed. */
function extractFirstOpenObject(text: string): string | null {
  const start = text.indexOf("{");
  return start < 0 ? null : text.slice(start);
}

/** Close dangling strings and braces on a truncated JSON object. Best-effort. */
function repairTruncated(s: string): string {
  if (!s) return "";
  let inStr = false;
  let esc = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  let out = s.replace(/,\s*$/, "");
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "").replace(/:\s*$/, ': ""');
  while (depth-- > 0) out += "}";
  return out;
}

/** Pull the first balanced `{...}` out of a string. Cheap brace counter. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Build the system prompt from the tools the model may actually use (read +
 * propose only — the caller filters out commit/reject before this).
 *
 * The prompt is written for a small model: short sentences, the rules that
 * matter first, one worked example of the exact JSON shape. It never claims a
 * privacy guarantee (that is the app's job, and the ledger's) — it only tells
 * the model how to behave.
 */
export function buildSystemPrompt(tools: PromptTool[]): string {
  const toolLines = tools
    .map((t) => {
      const schema = summarizeSchema(t.inputSchema);
      return `- ${t.name}${schema ? `(${schema})` : "()"}: ${firstLine(t.description)}`;
    })
    .join("\n");

  return [
    "You are Airlock's local data analyst. You run entirely inside the user's browser and help them analyze a dataset by calling tools. You cannot see the data except through the tools.",
    "",
    "HOW YOU WORK",
    "- Every turn, respond with a single JSON object and nothing else.",
    "- To use a tool: set \"tool\" to its name and \"arguments\" to its inputs. Leave \"final_answer\" empty.",
    "- When the goal is fully done: leave \"tool\" empty and put your summary in \"final_answer\".",
    '- Always fill "reasoning" with one short sentence.',
    "",
    "RULES",
    "- Start by understanding the data: call get_dataset_summary ONCE, then at most one or two more reads (profile_column, run_sql) to get the numbers you need.",
    "- Never call the same read tool twice — its result is already in this conversation. Re-reading wastes your turns and the loop will block it.",
    "- After 2-3 reads, ACT. Call a propose_* tool: propose_add_filter, propose_flag_rows, propose_add_chart, or propose_write_report. Reading forever is a failure.",
    "- If the dataset cannot answer the goal (a needed column is missing — e.g. the goal asks about gender or salary and there is no such column), do not keep searching. Say so plainly in final_answer.",
    "- propose_* tools do NOT change anything by themselves. They stage a change for the human to approve. After you call a propose_* tool, that change is out of your hands. Do not try to commit it; you have no commit tool.",
    "- Propose one change at a time. Wait for its result before proposing the next.",
    "- If a column is redacted you cannot read or name it; work around it.",
    "- If a tool returns an error, read the message, fix your input, and try again. Do not repeat the same failing call.",
    "- Keep going until the goal is met, then give your final_answer.",
    "",
    "TOOLS YOU CAN CALL",
    toolLines || "(none available yet — tell the user no dataset is loaded)",
    "",
    "EXACT OUTPUT SHAPE (one JSON object per turn):",
    '{"reasoning":"I need to see the columns first","tool":"get_dataset_summary","arguments":{}}',
    "or, when finished:",
    '{"reasoning":"The analysis is complete","final_answer":"I found 3 employees paid >15% below market and flagged them; a chart and report are staged for your approval."}',
  ].join("\n");
}

/** First line of a possibly-multiline tool description, trimmed for the prompt. */
function firstLine(s: string): string {
  const line = s.split("\n")[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Compact one-line rendering of a tool's required inputs, e.g. `expression,
 * label?`. Small models follow a terse signature better than a nested schema
 * dump, and the full schema is still enforced by the executor's own validation.
 */
function summarizeSchema(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "";
  const s = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  if (!s.properties) return "";
  const required = new Set(
    Array.isArray(s.required) ? s.required.filter((x) => typeof x === "string") : []
  );
  return Object.keys(s.properties)
    .map((k) => (required.has(k) ? k : `${k}?`))
    .join(", ");
}
