/**
 * Configured accounting rates per 1M gateway tokens.
 * These defaults preserve the existing estimate until gateway-specific
 * accounting is introduced.
 */
export const HAIKU_INPUT_COST_PER_MILLION = 0.25;
export const HAIKU_OUTPUT_COST_PER_MILLION = 1.25;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;

  /**
   * Records usage from an LLM API call response.
   */
  public addUsage(inputTokens: number, outputTokens: number): void {
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
  }

  public getUsage(): TokenUsage {
    const inputCost = (this.inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_MILLION;
    const outputCost = (this.outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_MILLION;
    const totalCost = inputCost + outputCost;

    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUsd: totalCost,
    };
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
  }
}
