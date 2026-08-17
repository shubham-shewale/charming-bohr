import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";
import type { AnthropicClientLike } from "../llm/analyzer.js";
import { parse } from "csv-parse/sync";

describe("End-to-End LLM Pipeline Integration Test", () => {
  let tmpDir: string;

  const mockConfig: AppConfig = {
    flow: "llm-only",
    anthropicApiKey: "test-anthropic-key",
    anthropicModel: "claude-3-haiku-20240307",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 5,
    githubPat: "test-github-pat",
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 2,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-llm-integration-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("processes CSV through mock fetcher and mock Anthropic SDK to output CSV with LLM classifications", async () => {
    const inputCsv = path.join(tmpDir, "input.csv");
    const outputCsv = path.join(tmpDir, "output.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link,Severity
rule-aws,https://github.com/my-org/my-repo/blob/${sha}/src/config.js#L5-L7,high
rule-test,https://github.com/my-org/my-repo/blob/${sha}/src/config.js#L12-L14,medium
`;
    fs.writeFileSync(inputCsv, csvContent);

    // Mock fetchProvider
    const fetchProvider = vi.fn().mockImplementation(async () => {
      return `// Line 1
// Line 2
// Line 3
// Line 4
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
// Line 6
// Line 7
// Line 8
// Line 9
// Line 10
// Line 11
const TEST_TOKEN = "dummy_token_for_tests";
// Line 13
// Line 14
`;
    });

    // Mock Anthropic client
    const mockAnthropicClient: AnthropicClientLike = {
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
                    confidence: 0.98,
                    reason: "Found valid AWS Access Key format",
                  },
                  {
                    findingIndex: 1,
                    classification: "false_positive",
                    confidence: 0.95,
                    reason: "Dummy test token in test code",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 250, output_tokens: 75 },
        }),
      },
    };

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider,
      anthropicClient: mockAnthropicClient,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.likelySecret).toBe(1);
    expect(summary.falsePositive).toBe(1);
    expect(summary.tokenUsage).toBeDefined();
    expect(summary.tokenUsage?.inputTokens).toBe(250);
    expect(summary.tokenUsage?.outputTokens).toBe(75);

    // Read and verify written output CSV
    const writtenRaw = fs.readFileSync(outputCsv, "utf-8");
    const records = parse(writtenRaw, { columns: true });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      "Rule ID": "rule-aws",
      status: "completed",
      llm_classification: "likely_secret",
      llm_reason: "Found valid AWS Access Key format",
      llm_confidence: "0.98",
    });
    expect(records[1]).toMatchObject({
      "Rule ID": "rule-test",
      status: "completed",
      llm_classification: "false_positive",
      llm_reason: "Dummy test token in test code",
      llm_confidence: "0.95",
    });
  });

  it("handles malformed LLM response and partial batch failure in end-to-end flow", async () => {
    const inputCsv = path.join(tmpDir, "input.csv");
    const outputCsv = path.join(tmpDir, "output.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link
rule-01,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L2
rule-02,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L10
`;
    fs.writeFileSync(inputCsv, csvContent);

    const fetchProvider = vi.fn().mockResolvedValue(`line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10`);

    // Mock LLM returning partial valid output (only findingIndex 0, findingIndex 1 missing)
    const mockAnthropicClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "uncertain",
                    confidence: 0.5,
                    reason: "Need more context",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        }),
      },
    };

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider,
      anthropicClient: mockAnthropicClient,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.uncertain).toBe(1);
    expect(summary.llmInvalidOutput).toBe(1);

    const writtenRaw = fs.readFileSync(outputCsv, "utf-8");
    const records = parse(writtenRaw, { columns: true });

    expect(records[0]).toMatchObject({
      "Rule ID": "rule-01",
      status: "completed",
      llm_classification: "uncertain",
    });
    expect(records[1]).toMatchObject({
      "Rule ID": "rule-02",
      status: "failed",
      llm_classification: "llm_invalid_output",
      error: "llm_invalid_output",
    });
  });
});
