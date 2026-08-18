export interface TokenPricing {
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
  cachedInputCostPerMillionUsd?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  llmCalls: number;
  usageReportedCalls: number;
  cacheReportedCalls: number;
  /** Undefined when model pricing has not been configured. */
  estimatedCostUsd?: number;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private llmCalls = 0;
  private usageReportedCalls = 0;
  private cacheReportedCalls = 0;

  constructor(private readonly pricing: TokenPricing = {}) {}

  /**
   * Records one completed LLM call. Token counts remain zero when the gateway
   * did not include a usage object; the CLI reports that distinction.
   */
  public addUsage(
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number
  ): void {
    this.llmCalls++;
    if (inputTokens === undefined || outputTokens === undefined) return;

    const safeInput = Math.max(0, inputTokens);
    this.inputTokens += safeInput;
    this.outputTokens += Math.max(0, outputTokens);
    this.cachedInputTokens += Math.min(safeInput, Math.max(0, cachedInputTokens ?? 0));
    this.usageReportedCalls++;
    if (cachedInputTokens !== undefined) this.cacheReportedCalls++;
  }

  public getUsage(): TokenUsage {
    const inputRate = this.pricing.inputCostPerMillionUsd;
    const outputRate = this.pricing.outputCostPerMillionUsd;
    let estimatedCostUsd: number | undefined;

    if (inputRate !== undefined && outputRate !== undefined) {
      const regularInputTokens = Math.max(0, this.inputTokens - this.cachedInputTokens);
      const cachedInputRate = this.pricing.cachedInputCostPerMillionUsd ?? inputRate;
      estimatedCostUsd =
        (regularInputTokens / 1_000_000) * inputRate +
        (this.cachedInputTokens / 1_000_000) * cachedInputRate +
        (this.outputTokens / 1_000_000) * outputRate;
    }

    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      llmCalls: this.llmCalls,
      usageReportedCalls: this.usageReportedCalls,
      cacheReportedCalls: this.cacheReportedCalls,
      estimatedCostUsd,
    };
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cachedInputTokens = 0;
    this.llmCalls = 0;
    this.usageReportedCalls = 0;
    this.cacheReportedCalls = 0;
  }
}
