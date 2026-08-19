import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "csv-parse/sync";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";

describe("File-Size Limit Skip Integration Test", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-filesize-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const baseConfig: AppConfig = {
    flow: "llm-only",
    anthropicApiKey: "dummy-key",
    anthropicModel: "claude-3-5-sonnet",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 3,
    githubPats: ["dummy-github-pat"],
    concurrency: 2,
    maxFileSizeKb: 10, // 10 KB limit for testing
    surroundingLines: 5,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
  };

  it("skips oversized files before LLM analysis", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const outputCsvPath = path.join(tmpDir, "results.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-large-1,https://github.com/my-org/my-repo/blob/${sha}/src/large.js#L10-L20,high
rule-large-2,https://github.com/my-org/my-repo/blob/${sha}/src/large.js#L50-L60,medium
rule-small,https://github.com/my-org/my-repo/blob/${sha}/src/small.js#L5-L10,low
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    // large.js is 15 KB (> 10 KB limit), small.js is 1 KB
    const largeContent = "x".repeat(15 * 1024);
    const smallContent = "const API_KEY = 'secret123';\n";

    const mockFetchProvider = async (source: { filePath: string }) => {
      if (source.filePath.includes("large.js")) {
        return largeContent;
      }
      return smallContent;
    };

    const create = vi.fn().mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          classifications: [{
            findingIndex: 0,
            classification: "uncertain",
            confidence: 0.5,
            reason: "Small file analyzed",
          }],
        }),
      }],
    });

    const summary = await runPipeline([inputCsvPath], {
      config: baseConfig,
      output: outputCsvPath,
      fetchProvider: mockFetchProvider,
      anthropicClient: { messages: { create } },
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.skipped).toBe(2); // Both findings in large.js skipped
    expect(summary.completed).toBe(1); // Finding in small.js completed

    // The two findings in large.js are grouped, and only small.js reaches the LLM.
    expect(create).toHaveBeenCalledTimes(1);

    // Verify CSV output
    const outputContent = fs.readFileSync(outputCsvPath, "utf-8");
    const rows: Record<string, string>[] = parse(outputContent, {
      columns: true,
      skip_empty_lines: true,
    });

    expect(rows).toHaveLength(3);

    // Row 1 & 2 (large.js)
    expect(rows[0]["Rule ID"]).toBe("rule-large-1");
    expect(rows[0]["status"]).toBe("skipped");
    expect(rows[0]["error"]).toContain("exceeds MAX_FILE_SIZE_KB limit of 10 KB");

    expect(rows[1]["Rule ID"]).toBe("rule-large-2");
    expect(rows[1]["status"]).toBe("skipped");
    expect(rows[1]["error"]).toContain("exceeds MAX_FILE_SIZE_KB limit of 10 KB");

    // Row 3 (small.js)
    expect(rows[2]["Rule ID"]).toBe("rule-small");
    expect(rows[2]["status"]).toBe("completed");
    expect(rows[2]["error"]).toBe("");
  });

  it("still scans an oversized file in trufflehog-only mode", async () => {
    const inputCsvPath = path.join(tmpDir, "trufflehog-findings.csv");
    const outputCsvPath = path.join(tmpDir, "trufflehog-results.csv");
    const sha = "1234567890abcdef1234567890abcdef12345678";
    fs.writeFileSync(
      inputCsvPath,
      `Rule ID,SCM Link\nrule-large,https://github.com/my-org/my-repo/blob/${sha}/src/large.log#L1-L2\n`,
      "utf-8"
    );
    const trufflehogExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const summary = await runPipeline([inputCsvPath], {
      config: {
        ...baseConfig,
        flow: "trufflehog-only",
        llmIgnorePatterns: ["*.log"],
      },
      output: outputCsvPath,
      fetchProvider: async () => "x".repeat(15 * 1024),
      trufflehogExecFn,
    });

    expect(trufflehogExecFn).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ completed: 1, skipped: 0, notDetected: 1 });
  });

  it("skips an ignored path before fetching it in llm-only mode", async () => {
    const inputCsvPath = path.join(tmpDir, "ignored-findings.csv");
    const outputCsvPath = path.join(tmpDir, "ignored-results.csv");
    const sha = "1234567890abcdef1234567890abcdef12345678";
    fs.writeFileSync(
      inputCsvPath,
      `Rule ID,SCM Link\nrule-dependency,https://github.com/my-org/my-repo/blob/${sha}/web/node_modules/pkg/index.js#L1-L2\n`,
      "utf-8"
    );
    const fetchProvider = vi.fn().mockResolvedValue("dependency content");
    const create = vi.fn();

    const summary = await runPipeline([inputCsvPath], {
      config: { ...baseConfig, llmIgnorePatterns: ["node_modules/"] },
      output: outputCsvPath,
      fetchProvider,
      anthropicClient: { messages: { create } },
    });

    expect(fetchProvider).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ completed: 0, skipped: 1 });
    expect(summary.results[0]).toMatchObject({
      status: "skipped",
      error: expect.stringContaining('LLM_IGNORE_PATTERNS pattern "node_modules/"'),
    });
  });
});
