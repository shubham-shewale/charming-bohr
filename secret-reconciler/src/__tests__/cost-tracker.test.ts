import { describe, expect, it } from "vitest";
import { CostTracker } from "../llm/cost-tracker.js";

describe("CostTracker", () => {
  it("uses gateway-reported cache tokens and configured model prices", () => {
    const tracker = new CostTracker({
      inputCostPerMillionUsd: 2,
      outputCostPerMillionUsd: 10,
      cachedInputCostPerMillionUsd: 0.5,
    });

    tracker.addUsage(1_000_000, 100_000, 250_000);

    expect(tracker.getUsage()).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 250_000,
      llmCalls: 1,
      usageReportedCalls: 1,
      cacheReportedCalls: 1,
      estimatedCostUsd: 2.625,
    });
  });

  it("does not invent usage or cost when the gateway omits it", () => {
    const tracker = new CostTracker();

    tracker.addUsage();

    expect(tracker.getUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      llmCalls: 1,
      usageReportedCalls: 0,
      cacheReportedCalls: 0,
      estimatedCostUsd: undefined,
    });
  });
});
