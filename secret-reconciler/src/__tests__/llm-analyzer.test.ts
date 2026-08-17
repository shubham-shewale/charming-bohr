import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ClaudeAnalyzer, type AnthropicClientLike } from "../llm/analyzer.js";
import { CostTracker } from "../llm/cost-tracker.js";
import type { AppConfig } from "../config.js";
import type { FileWorkItem, FindingRef } from "../types.js";

describe("ClaudeAnalyzer", () => {
  let tmpDir: string;
  let sampleFilePath: string;

  const defaultConfig: AppConfig = {
    flow: "llm-only",
    anthropicApiKey: "test-key",
    anthropicModel: "claude-3-haiku-20240307",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 5,
    githubPats: ["test-pat"],
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 2,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyzer-test-"));
    sampleFilePath = path.join(tmpDir, "sample.js");
    const content = Array.from({ length: 100 }, (_, i) => `const var_${i + 1} = "val_${i + 1}";`).join("\n");
    fs.writeFileSync(sampleFilePath, content);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockWorkItem(count: number): FileWorkItem {
    const findings: FindingRef[] = Array.from({ length: count }, (_, i) => ({
      rowIndex: i,
      sourceFile: "input.csv",
      rawRow: { "Rule ID": `rule-${i}` },
      initialStatus: "pending",
      canonicalSource: {
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        filePath: "sample.js",
        lineStart: i * 2 + 1,
        lineEnd: i * 2 + 1,
      },
    }));

    return {
      contentIdentity: "github::my-org/my-repo::a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0::sample.js",
      provider: "github",
      org: "my-org",
      repo: "my-repo",
      revision: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      filePath: "sample.js",
      findings,
    };
  }

  it("analyzes work item and returns classifications for valid LLM response", async () => {
    const mockClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "likely_secret",
                    confidence: 0.95,
                    reason: "Hardcoded secret string detected",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 150, output_tokens: 50 },
        }),
      },
    };

    const costTracker = new CostTracker();
    const analyzer = new ClaudeAnalyzer({
      config: defaultConfig,
      anthropicClient: mockClient,
      costTracker,
    });

    const workItem = createMockWorkItem(1);
    const results = await analyzer.analyzeWorkItem(workItem, sampleFilePath);

    expect(results).toHaveLength(1);
    const res = results[0]!;
    expect(res.status).toBe("completed");
    expect(res.llmClassification).toBe("likely_secret");
    expect(res.llmConfidence).toBe(0.95);
    expect(res.llmReason).toBe("Hardcoded secret string detected");
    expect(res.error).toBe("");

    const usage = costTracker.getUsage();
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(50);
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("handles partial batch failure correctly: keeps valid findings and marks missing/invalid ones as llm_invalid_output", async () => {
    const mockClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "false_positive",
                    confidence: 0.99,
                    reason: "Test variable",
                  },
                  {
                    findingIndex: 1,
                    classification: "invalid_enum_val", // Malformed enum!
                    confidence: 0.8,
                    reason: "Some reason",
                  },
                  // findingIndex 2 is missing from response array!
                ],
              }),
            },
          ],
          usage: { input_tokens: 200, output_tokens: 60 },
        }),
      },
    };

    const analyzer = new ClaudeAnalyzer({
      config: defaultConfig,
      anthropicClient: mockClient,
    });

    const workItem = createMockWorkItem(3);
    const results = await analyzer.analyzeWorkItem(workItem, sampleFilePath);

    expect(results).toHaveLength(3);
    // Finding 0: valid
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.llmClassification).toBe("false_positive");
    expect(results[0]!.llmConfidence).toBe(0.99);

    // Finding 1: malformed classification enum
    expect(results[1]!.status).toBe("failed");
    expect(results[1]!.error).toBe("llm_invalid_output");

    // Finding 2: missing from response
    expect(results[2]!.status).toBe("failed");
    expect(results[2]!.error).toBe("llm_invalid_output");
  });

  it("batches findings when there are > 15 findings in a file", async () => {
    const createFn = vi.fn().mockImplementation((params) => {
      // Find how many findings were sent in user prompt
      const matches = (params.messages[0].content as string).match(/Finding index/g);
      const count = matches ? matches.length : 0;
      const classifications = Array.from({ length: count }, (_, idx) => ({
        findingIndex: idx,
        classification: "uncertain",
        confidence: 0.5,
        reason: `Batch evaluation ${idx}`,
      }));

      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify({ classifications }) }],
        usage: { input_tokens: 300, output_tokens: 100 },
      });
    });

    const mockClient: AnthropicClientLike = {
      messages: { create: createFn },
    };

    const analyzer = new ClaudeAnalyzer({
      config: defaultConfig,
      anthropicClient: mockClient,
    });

    const workItem = createMockWorkItem(20); // 20 findings > 15
    const results = await analyzer.analyzeWorkItem(workItem, sampleFilePath);

    expect(results).toHaveLength(20);
    expect(createFn).toHaveBeenCalledTimes(2); // 15 + 5
  });

  it("enforces maxLlmCallsPerFile cap", async () => {
    const mockClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: Array.from({ length: 15 }, (_, idx) => ({
                  findingIndex: idx,
                  classification: "false_positive",
                  confidence: 1,
                  reason: "ok",
                })),
              }),
            },
          ],
        }),
      },
    };

    const analyzer = new ClaudeAnalyzer({
      config: { ...defaultConfig, maxLlmCallsPerFile: 1 },
      anthropicClient: mockClient,
    });

    const workItem = createMockWorkItem(20); // 2 batches (15 + 5), maxLlmCallsPerFile = 1
    const results = await analyzer.analyzeWorkItem(workItem, sampleFilePath);

    expect(results).toHaveLength(20);
    // First 15 findings completed
    for (let i = 0; i < 15; i++) {
      expect(results[i]!.status).toBe("completed");
    }
    // Remaining 5 findings capped
    for (let i = 15; i < 20; i++) {
      expect(results[i]!.status).toBe("failed");
      expect(results[i]!.error).toBe("max_llm_calls_exceeded");
    }
  });
});
