/**
 * BYO endpoint client — talk to the user's own OpenAI-compatible model
 * (their company's Azure OpenAI, a personal key, a local Ollama) from the
 * browser tab.
 *
 * Honesty rules for this file:
 * - The API key lives in module memory ONLY. Never localStorage, never the
 *   ledger, never the receipt, never a URL. `clearEndpoint()` drops it.
 * - Traffic to the endpoint is EXTERNAL by definition. It flows through the
 *   normal `fetch`, so the egress monitor counts it and the Seal shows it —
 *   Local mode's "0 bytes out" can never appear while this is driving.
 * - https everywhere, except http loopback (Ollama-style local dev). Anything
 *   else is refused before a byte moves.
 */

export interface ByoEndpointInput {
  /** Base URL, e.g. https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini */
  url: string;
  /** Secret key. Memory-only — see above. */
  apiKey: string;
  /** Model/chat-deployment name sent as `model`. */
  model: string;
}

export interface ByoChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ByoOutboundToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ByoFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ByoInboundToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface ByoChatResult {
  content: string | null;
  toolCalls: ByoInboundToolCall[];
  finishReason: string | null;
}

export interface ByoOutboundToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface StoredEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  host: string;
}

let endpoint: StoredEndpoint | null = null;

/** True when an endpoint + key are configured (memory-only). */
export function isEndpointConfigured(): boolean {
  return endpoint !== null;
}

/** The endpoint host for badges/receipts. Never the key, never the full URL. */
export function endpointHost(): string | null {
  return endpoint?.host ?? null;
}

/** The configured model name, for labels. */
export function endpointModel(): string | null {
  return endpoint?.model ?? null;
}

function normalizeBaseUrl(url: string): { baseUrl: string; host: string } {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That endpoint URL could not be parsed — include https:// and the full path.");
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Endpoint must be https — plain http is refused (localhost http is allowed for local dev).");
  }
  return { baseUrl: trimmed, host: parsed.host };
}

/**
 * Configure the endpoint. Throws UI-safe copy on anything wrong. Stores the
 * key in memory only.
 */
export function configureEndpoint(input: ByoEndpointInput): string {
  const label = input.model.trim();
  if (!label) throw new Error("Name the model (or deployment) to use.");
  if (!input.apiKey.trim()) throw new Error("Paste an API key — it stays in this tab's memory only.");
  const { baseUrl, host } = normalizeBaseUrl(input.url);
  endpoint = { baseUrl, apiKey: input.apiKey, host, model: label };
  return host;
}

/** Forget everything, including the key. */
export function clearEndpoint(): void {
  endpoint = null;
}

/**
 * One Chat Completions call with tools. `signal` aborts (per-step deadline or
 * user stop); `timeoutMs` is the backstop when the host hangs silently.
 */
export async function chatCompletions(opts: {
  messages: ByoChatMessage[];
  tools: ByoFunctionTool[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ByoChatResult> {
  const ep = endpoint;
  if (!ep) throw new Error("No BYO endpoint configured.");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 120_000
  );
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // Never log these headers: the key travels here and nowhere else.
        "api-key": ep.apiKey,
        authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({
        model: ep.model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: "auto",
      }),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `Endpoint answered ${res.status}${snippet ? ` — ${snippet}` : ""}. Check the URL, model name and key.`
      );
    }
    const body = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string | null;
      }[];
    };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error("Endpoint returned no message.");
    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        argumentsText: c.function?.arguments ?? "{}",
      })),
      finishReason: body.choices?.[0]?.finish_reason ?? null,
    };
  } catch (err) {
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new Error("Endpoint timed out — is the URL reachable from this browser?");
    }
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
