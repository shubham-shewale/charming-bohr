import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "csv-parse/sync";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";

describe("SIGINT & Graceful Cancellation Integration Tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-sigint-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const baseConfig: AppConfig = {
    flow: "trufflehog-only",
    anthropicApiKey: "dummy-key",
    anthropicModel: "claude-3-5-sonnet",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 3,
    githubPat: "dummy-github-pat",
    concurrency: 1, // Concurrency 1 so files execute sequentially
    maxFileSizeKb: 500,
    surroundingLines: 5,
    cleanupTempFiles: true,
  };

  it("handles abort signal: stops accepting new work, flushes completed and pending results to CSV without corruption", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const outputCsvPath = path.join(tmpDir, "results.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-file1,https://github.com/my-org/my-repo/blob/${sha}/src/file1.js#L1-L5,high
rule-file2,https://github.com/my-org/my-repo/blob/${sha}/src/file2.js#L1-L5,medium
rule-file3,https://github.com/my-org/my-repo/blob/${sha}/src/file3.js#L1-L5,low
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    const abortController = new AbortController();
    let file1Processed = false;
    let file2Started = false;
    let file3Started = false;

    const mockFetchProvider = async (source: { filePath: string }) => {
      if (source.filePath.includes("file1.js")) {
        file1Processed = true;
        return "const KEY1 = 'key1';";
      }
      if (source.filePath.includes("file2.js")) {
        file2Started = true;
        // Trigger abort while file 2 is being processed
        abortController.abort();
        // Delay to test in-flight completion within timeout
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "const KEY2 = 'key2';";
      }
      if (source.filePath.includes("file3.js")) {
        file3Started = true;
        return "const KEY3 = 'key3';";
      }
      return "";
    };

    const mockTruffleHogExec = async () => {
      return {
        stdout: `{"DetectorName": "Generic", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 1}}}}`,
        stderr: "",
      };
    };

    const summary = await runPipeline([inputCsvPath], {
      config: baseConfig,
      output: outputCsvPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
      signal: abortController.signal,
      sigintTimeoutMs: 500,
    });

    expect(summary.interrupted).toBe(true);
    expect(file1Processed).toBe(true);
    expect(file2Started).toBe(true);
    // File 3 should NOT have started because new work was stopped
    expect(file3Started).toBe(false);

    // Verify output CSV exists and is uncorrupted
    expect(fs.existsSync(outputCsvPath)).toBe(true);
    const outputContent = fs.readFileSync(outputCsvPath, "utf-8");
    const rows: Record<string, string>[] = parse(outputContent, {
      columns: true,
      skip_empty_lines: true,
    });

    expect(rows).toHaveLength(3);

    // File 1: completed
    expect(rows[0]["Rule ID"]).toBe("rule-file1");
    expect(rows[0]["status"]).toBe("completed");

    // File 2: finished within in-flight timeout -> completed
    expect(rows[1]["Rule ID"]).toBe("rule-file2");
    expect(rows[1]["status"]).toBe("completed");

    // File 3: not started -> marked pending
    expect(rows[2]["Rule ID"]).toBe("rule-file3");
    expect(rows[2]["status"]).toBe("pending");

    // Resume run: re-feed output CSV to verify it resumes cleanly from pending
    const resumeOutputCsvPath = path.join(tmpDir, "results-resumed.csv");
    let file3FetchedOnResume = false;

    const resumeFetchProvider = async (source: { filePath: string }) => {
      if (source.filePath.includes("file3.js")) {
        file3FetchedOnResume = true;
        return "const KEY3 = 'key3';";
      }
      return "";
    };

    const resumeSummary = await runPipeline([outputCsvPath], {
      config: baseConfig,
      output: resumeOutputCsvPath,
      fetchProvider: resumeFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(resumeSummary.interrupted).toBe(false);
    expect(resumeSummary.totalFindings).toBe(3);
    expect(resumeSummary.completed).toBe(3);
    expect(file3FetchedOnResume).toBe(true);

    const resumedRows: Record<string, string>[] = parse(
      fs.readFileSync(resumeOutputCsvPath, "utf-8"),
      { columns: true, skip_empty_lines: true }
    );
    expect(resumedRows[0]["status"]).toBe("completed");
    expect(resumedRows[1]["status"]).toBe("completed");
    expect(resumedRows[2]["status"]).toBe("completed");
  });

  it("marks in-flight work that exceeds sigintTimeoutMs as pending and cleans up", async () => {
    const inputCsvPath = path.join(tmpDir, "findings-timeout.csv");
    const outputCsvPath = path.join(tmpDir, "results-timeout.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-fast,https://github.com/my-org/my-repo/blob/${sha}/src/fast.js#L1-L5,high
rule-slow,https://github.com/my-org/my-repo/blob/${sha}/src/slow.js#L1-L5,medium
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    const abortController = new AbortController();

    const mockFetchProvider = async (source: { filePath: string }) => {
      if (source.filePath.includes("fast.js")) {
        return "fast content";
      }
      if (source.filePath.includes("slow.js")) {
        // Abort right when slow starts, and sleep longer than sigintTimeoutMs
        abortController.abort();
        await new Promise((resolve) => setTimeout(resolve, 800));
        return "slow content";
      }
      return "";
    };

    const mockTruffleHogExec = async () => ({
      stdout: `{"DetectorName": "Generic", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 1}}}}`,
      stderr: "",
    });

    const summary = await runPipeline([inputCsvPath], {
      config: { ...baseConfig, concurrency: 1 },
      output: outputCsvPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
      signal: abortController.signal,
      sigintTimeoutMs: 100, // Short timeout (100ms) while fetch takes 800ms
    });

    expect(summary.interrupted).toBe(true);

    const rows: Record<string, string>[] = parse(
      fs.readFileSync(outputCsvPath, "utf-8"),
      { columns: true, skip_empty_lines: true }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]["Rule ID"]).toBe("rule-fast");
    expect(rows[0]["status"]).toBe("completed");

    // The slow file was in flight but exceeded timeout -> status=pending
    expect(rows[1]["Rule ID"]).toBe("rule-slow");
    expect(rows[1]["status"]).toBe("pending");
  });
});
