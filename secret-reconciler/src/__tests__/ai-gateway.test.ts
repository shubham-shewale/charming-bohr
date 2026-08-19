import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleGatewayClient } from "../ai-gateway/client.js";

describe("OpenAiCompatibleGatewayClient", () => {
  it("sends a forced tool request and parses structured tool calls", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "gateway-request-1",
      model: "security-model-v1",
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "submit_context_assessments",
              arguments: JSON.stringify({ assessments: [] }),
            },
          }],
        },
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new OpenAiCompatibleGatewayClient({
      baseUrl: "https://gateway.internal/",
      authToken: "secret-auth-token",
      timeoutMs: 1000,
      fetchFn,
    });

    const result = await client.complete({
      model: "security-model-v1",
      messages: [{ role: "system", content: "policy" }],
      tools: [{
        type: "function",
        function: { name: "submit_context_assessments", description: "final", parameters: {} },
      }],
      toolChoice: "required",
      maxTokens: 1000,
      promptCacheKey: "secret-reconciler:context-v2",
      promptCacheRetention: "in_memory",
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://gateway.internal/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer secret-auth-token");
    const requestBody = JSON.parse(init.body);
    expect(requestBody.tool_choice).toBe("required");
    expect(requestBody.prompt_cache_key).toBe("secret-reconciler:context-v2");
    expect(requestBody.prompt_cache_retention).toBe("in_memory");
    expect(result).toMatchObject({
      requestId: "gateway-request-1",
      model: "security-model-v1",
      usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5 },
      toolCalls: [{ name: "submit_context_assessments", arguments: { assessments: [] } }],
    });
  });

  it("rejects malformed tool arguments instead of passing unvalidated text downstream", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call-bad",
            function: { name: "submit_context_assessments", arguments: "not-json" },
          }],
        },
      }],
    }), { status: 200 }));
    const client = new OpenAiCompatibleGatewayClient({
      baseUrl: "https://gateway.internal",
      timeoutMs: 1000,
      fetchFn,
    });

    await expect(client.complete({
      model: "model",
      messages: [],
      tools: [],
      toolChoice: "required",
      maxTokens: 100,
    })).rejects.toThrow(/invalid JSON arguments/);
  });

  it("does not invent zero token usage when the gateway omits token counts", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "done" } }],
      usage: {},
    }), { status: 200 }));
    const client = new OpenAiCompatibleGatewayClient({
      baseUrl: "https://gateway.internal",
      timeoutMs: 1000,
      fetchFn,
    });

    const result = await client.complete({
      model: "model",
      messages: [],
      tools: [],
      toolChoice: "auto",
      maxTokens: 100,
    });

    expect(result.usage).toBeUndefined();
  });

  it("rejects tool calls that were not explicitly declared by the application", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "unexpected",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      }],
    }), { status: 200 }));
    const client = new OpenAiCompatibleGatewayClient({
      baseUrl: "https://gateway.internal",
      timeoutMs: 1000,
      fetchFn,
    });

    await expect(client.complete({
      model: "model",
      messages: [],
      tools: [],
      toolChoice: "required",
      maxTokens: 100,
    })).rejects.toThrow(/undeclared tool web_search/);
  });

  it("aborts an in-flight gateway request when the caller cancels it", async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const client = new OpenAiCompatibleGatewayClient({
      baseUrl: "https://gateway.internal",
      timeoutMs: 10_000,
      fetchFn,
    });
    const controller = new AbortController();
    const request = client.complete({
      model: "model",
      messages: [],
      tools: [],
      toolChoice: "required",
      maxTokens: 100,
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toThrow("AI Gateway request aborted");
  });
});
