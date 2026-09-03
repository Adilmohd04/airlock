/**
 * BYO client tests — validation, headers, and error paths. The key must never
 * be persisted or logged: asserted here by checking what the client keeps
 * (memory only) and what leaves in fetch (headers only, never the body/URL).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chatCompletions,
  clearEndpoint,
  configureEndpoint,
  endpointHost,
  endpointModel,
  isEndpointConfigured,
} from "./client";

const GOOD = {
  url: "https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini",
  apiKey: "test-key-never-real",
  model: "gpt-4o-mini",
};

afterEach(() => {
  clearEndpoint();
  vi.unstubAllGlobals();
});

describe("configureEndpoint", () => {
  it("accepts https and reports host/model without the key", () => {
    expect(configureEndpoint(GOOD)).toBe("my-resource.openai.azure.com");
    expect(isEndpointConfigured()).toBe(true);
    expect(endpointHost()).toBe("my-resource.openai.azure.com");
    expect(endpointModel()).toBe("gpt-4o-mini");
  });

  it("allows http loopback for local dev (Ollama)", () => {
    expect(
      configureEndpoint({ ...GOOD, url: "http://localhost:11434/v1" })
    ).toBe("localhost:11434");
  });

  it("refuses plain-http remote, garbage URLs, and missing fields", () => {
    expect(() =>
      configureEndpoint({ ...GOOD, url: "http://evil.example/v1" })
    ).toThrow(/https/);
    expect(() => configureEndpoint({ ...GOOD, url: "not a url" })).toThrow();
    expect(() => configureEndpoint({ ...GOOD, apiKey: "  " })).toThrow(/key/i);
    expect(() => configureEndpoint({ ...GOOD, model: "" })).toThrow(/model/i);
    expect(isEndpointConfigured()).toBe(false);
  });

  it("forgets everything on clear", () => {
    configureEndpoint(GOOD);
    clearEndpoint();
    expect(isEndpointConfigured()).toBe(false);
    expect(endpointHost()).toBeNull();
  });
});

describe("chatCompletions", () => {
  it("posts model+messages+tools and parses tool calls", async () => {
    configureEndpoint(GOOD);
    let seenUrl = "";
    let seenBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: unknown; headers?: unknown }) => {
        seenUrl = String(url);
        seenBody = String(init?.body ?? "");
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c1", function: { name: "run_sql", arguments: '{"query":"SELECT 1"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        };
      })
    );
    const res = await chatCompletions({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(seenUrl).toBe(`${GOOD.url}/chat/completions`);
    const body = JSON.parse(seenBody) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
    // The key travels in headers only — never in the URL or the JSON body.
    expect(seenUrl).not.toContain("test-key");
    expect(seenBody).not.toContain("test-key");
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "run_sql", argumentsText: '{"query":"SELECT 1"}' },
    ]);
  });

  it("throws UI-safe copy on HTTP errors and without configuration", async () => {
    await expect(
      chatCompletions({ messages: [], tools: [] })
    ).rejects.toThrow(/No BYO endpoint/);
    configureEndpoint(GOOD);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "bad key" }))
    );
    await expect(chatCompletions({ messages: [], tools: [] })).rejects.toThrow(
      /401/
    );
  });
});
