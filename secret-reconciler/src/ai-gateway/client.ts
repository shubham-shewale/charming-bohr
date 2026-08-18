import type {
  AiGatewayClientLike,
  AiGatewayMessage,
  AiGatewayRequest,
  AiGatewayResponse,
  AiGatewayToolCall,
} from "./types.js";

export interface OpenAiCompatibleGatewayOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

interface OpenAiToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiGatewayPayload {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

function toOpenAiMessage(message: AiGatewayMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCallId) mapped.tool_call_id = message.toolCallId;
  if (message.toolCalls) {
    mapped.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    }));
  }
  return mapped;
}

function parseToolCall(call: OpenAiToolCall, index: number): AiGatewayToolCall {
  const name = call.function?.name;
  if (!name) throw new Error("AI Gateway returned a tool call without a name");

  let args: unknown = {};
  try {
    args = JSON.parse(call.function?.arguments ?? "{}");
  } catch {
    throw new Error(`AI Gateway returned invalid JSON arguments for tool ${name}`);
  }

  return {
    id: call.id ?? `tool-call-${index}`,
    name,
    arguments: args,
  };
}

/**
 * Provider-neutral adapter for an OpenAI-compatible, self-hosted AI Gateway.
 * The rest of the application depends only on AiGatewayClientLike.
 */
export class OpenAiCompatibleGatewayClient implements AiGatewayClientLike {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiCompatibleGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async complete(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authToken
            ? { authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toOpenAiMessage),
          tools: request.tools,
          tool_choice: request.toolChoice,
          max_tokens: request.maxTokens,
          ...(request.promptCacheKey
            ? { prompt_cache_key: request.promptCacheKey }
            : {}),
          ...(request.promptCacheRetention
            ? { prompt_cache_retention: request.promptCacheRetention }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`AI Gateway request failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as OpenAiGatewayPayload;
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error("AI Gateway response did not contain a message");
      const usage = payload.usage;
      const hasTokenUsage =
        typeof usage?.prompt_tokens === "number" &&
        typeof usage.completion_tokens === "number";
      const toolCalls = (message.tool_calls ?? []).map(parseToolCall);
      const declaredTools = new Set(request.tools.map((tool) => tool.function.name));
      const undeclaredTool = toolCalls.find((toolCall) => !declaredTools.has(toolCall.name));
      if (undeclaredTool) {
        throw new Error(`AI Gateway returned undeclared tool ${undeclaredTool.name}`);
      }

      return {
        toolCalls,
        content: message.content ?? undefined,
        model: payload.model,
        requestId: payload.id,
        usage: hasTokenUsage
          ? {
              inputTokens: usage.prompt_tokens!,
              outputTokens: usage.completion_tokens!,
              cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
            }
          : undefined,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`AI Gateway request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
