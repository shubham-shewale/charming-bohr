export type AiGatewayRole = "system" | "user" | "assistant" | "tool";

export interface AiGatewayMessage {
  role: AiGatewayRole;
  content: string;
  toolCallId?: string;
  toolCalls?: AiGatewayToolCall[];
}

export interface AiGatewayToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiGatewayToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AiGatewayRequest {
  model: string;
  messages: AiGatewayMessage[];
  tools: AiGatewayToolDefinition[];
  toolChoice: "auto" | "required";
  maxTokens: number;
  /** Forwarded only when the configured gateway/model supports prompt caching. */
  promptCacheKey?: string;
  promptCacheRetention?: "in_memory" | "24h";
  /** Optional hard-cancellation signal supplied by the pipeline lifecycle. */
  signal?: AbortSignal;
}

export interface AiGatewayResponse {
  toolCalls: AiGatewayToolCall[];
  content?: string;
  model?: string;
  requestId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Subset of inputTokens served from the gateway/model cache, when reported. */
    cachedInputTokens?: number;
  };
}

export interface AiGatewayClientLike {
  complete(request: AiGatewayRequest): Promise<AiGatewayResponse>;
}
