import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateDefaultOutputFilename, runPipeline, type PipelineProgress } from "../pipeline.js";
import type { AppConfig } from "../config.js";

describe("Polish: Progress, Filename & Cleanup Tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-polish-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const baseConfig: AppConfig = {
    flow: "trufflehog-only",
    anthropicApiKey: "dummy-key",
    anthropicModel: "claude-3-5-sonnet",
    aiGatewayInputCostPerMillionUsd: 1,
    aiGatewayOutputCostPerMillionUsd: 2,
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 3,
    githubPats: ["dummy-github-pat"],
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 5,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
  };

  it("generateDefaultOutputFilename produces results-{YYYYMMDD}T{HHMM}.csv in cwd", () => {
    const fixedDate = new Date(2026, 7, 17, 14, 30); // Aug 17, 2026 14:30
    const generated = generateDefaultOutputFilename("/test/dir", fixedDate);
    expect(generated).toBe(path.join("/test/dir", "results-20260817T1430.csv"));
  });

  it("auto-generates output filename when options.output is not specified", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-test,https://github.com/my-org/my-repo/blob/${sha}/src/test.js#L1-L5,high
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    const summary = await runPipeline([inputCsvPath], {
      config: baseConfig,
      fetchProvider: async () => "const A = 1;",
      trufflehogExecFn: async () => ({ stdout: "", stderr: "" }),
    });

    expect(summary.outputPath).toMatch(/results-\d{8}T\d{4}\.csv$/);
    expect(fs.existsSync(summary.outputPath)).toBe(true);

    // Cleanup generated file in cwd
    try {
      fs.unlinkSync(summary.outputPath);
    } catch {
      // ignore
    }
  });

  it("emits periodic progress updates with files, findings, tokens, and cost", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const outputCsvPath = path.join(tmpDir, "results.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-1,https://github.com/my-org/my-repo/blob/${sha}/src/file1.js#L1-L5,high
rule-2,https://github.com/my-org/my-repo/blob/${sha}/src/file2.js#L1-L5,medium
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    const progressReports: PipelineProgress[] = [];

    const mockAnthropicClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  { findingIndex: 0, classification: "false_positive", confidence: 0.9, reason: "test" },
                ],
              }),
            },
          ],
          usage: { input_tokens: 150, output_tokens: 50 },
        }),
      },
    };

    const summary = await runPipeline([inputCsvPath], {
      config: { ...baseConfig, flow: "llm-only" },
      output: outputCsvPath,
      tempDir: path.join(tmpDir, "temp_files"),
      anthropicClient: mockAnthropicClient as any,
      fetchProvider: async () => "content",
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(summary.completed).toBe(2);
    // At least initial progress report + 2 per file completion
    expect(progressReports.length).toBeGreaterThanOrEqual(3);

    const lastProgress = progressReports[progressReports.length - 1]!;
    expect(lastProgress.filesProcessed).toBe(2);
    expect(lastProgress.totalFiles).toBe(2);
    expect(lastProgress.findingsCompleted).toBe(2);
    expect(lastProgress.findingsProcessed).toBe(2);
    expect(lastProgress.findingsSkipped).toBe(0);
    expect(lastProgress.findingsFailed).toBe(0);
    expect(lastProgress.llmCalls).toBe(2);
    expect(lastProgress.cachedInputTokens).toBe(0);
    expect(lastProgress.cacheReportedCalls).toBe(0);
    expect(lastProgress.totalFindings).toBe(2);
    expect(lastProgress.tokensUsed).toBe(400); // 2 files * (150 in + 50 out)
    expect(lastProgress.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("preserves temp files and populates tempDirKept when keepFiles=true", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const outputCsvPath = path.join(tmpDir, "results.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-1,https://github.com/my-org/my-repo/blob/${sha}/src/file1.js#L1-L5,high
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    const summary = await runPipeline([inputCsvPath], {
      config: baseConfig,
      output: outputCsvPath,
      keepFiles: true,
      fetchProvider: async () => "file content",
      trufflehogExecFn: async () => ({ stdout: "", stderr: "" }),
    });

    expect(summary.tempDirKept).toBeDefined();
    expect(fs.existsSync(summary.tempDirKept!)).toBe(true);

    // Clean up manually for the test
    fs.rmSync(summary.tempDirKept!, { recursive: true, force: true });
  });
});
