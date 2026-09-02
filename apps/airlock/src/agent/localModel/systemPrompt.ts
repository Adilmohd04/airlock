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

/**
 * Parse and normalize one model turn. Returns null when the text is not the
 * object we constrained for — the loop turns that into a corrective retry
 * rather than a crash (small models occasionally break the grammar on the first
 * token under memory pressure).
 */
export function parseTurn(text: string): AgentTurn | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Some models wrap the object in prose or a ```json fence despite the
    // grammar; salvage the first balanced object before giving up.
    const salvaged = extractFirstObject(text);
    if (salvaged == null) return null;
    try {
      raw = JSON.parse(salvaged);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";
  const tool =
    typeof o.tool === "string" && o.tool.trim().length > 0
      ? o.tool.trim()
      : undefined;
  const args =
    o.arguments && typeof o.arguments === "object" && !Array.isArray(o.arguments)
      ? (o.arguments as Record<string, unknown>)
      : undefined;
  const finalAnswer =
    typeof o.final_answer === "string" && o.final_answer.trim().length > 0
      ? o.final_answer.trim()
      : undefined;

  return { reasoning, tool, arguments: args, finalAnswer };
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
    "- Start by understanding the data: call get_dataset_summary before querying.",
    "- Read tools (list_*, get_*, profile_*, preview_*, run_sql, describe_*) run immediately and return data to you.",
    "- propose_* tools do NOT change anything by themselves. They stage a change for the human to approve. After you call a propose_* tool, that change is out of your hands — the human approves or rejects it. Do not try to commit it; you have no commit tool.",
    "- Propose one change at a time. Wait for its result before proposing the next.",
    "- If a column is redacted you cannot read or name it; work around it.",
    "- If a tool returns an error, read the message, fix your input, and try again. Do not repeat the same failing call.",
    "- Keep going until the goal is met, then give your final_answer. Do not stop early to ask permission for reads.",
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
