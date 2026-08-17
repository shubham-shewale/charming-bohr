import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "csv-parse/sync";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";

describe("Two-CSV Merge and Resume Integration Tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-merge-resume-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockConfig: AppConfig = {
    flow: "trufflehog-only",
    anthropicApiKey: "dummy-key",
    anthropicModel: "claude-3-5-sonnet",
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

  it("merges two CSVs with different columns into one output, tagging source_file and unioning headers", async () => {
    const csv1Path = path.join(tmpDir, "unsuppressed.csv");
    const csv2Path = path.join(tmpDir, "suppressed.csv");
    const outputPath = path.join(tmpDir, "merged_output.csv");

    const sha1 = "1111111111111111111111111111111111111111";
    const sha2 = "2222222222222222222222222222222222222222";

    // File 1 has 3 columns
    const csv1Content = `Rule ID,SCM Link,Severity
rule-aws,https://github.com/my-org/my-repo/blob/${sha1}/src/aws.js#L10-L20,high
rule-shared,https://github.com/my-org/my-repo/blob/${sha2}/src/shared.js#L5-L15,medium
`;
    // File 2 has 5 columns (adds Suppressed By and Reason)
    const csv2Content = `Rule ID,SCM Link,Severity,Suppressed By,Reason
rule-shared-2,https://github.com/my-org/my-repo/blob/${sha2}/src/shared.js#L30-L40,medium,alice,wontfix
rule-azure,https://github.com/my-org/my-repo/blob/${sha1}/src/aws.js#L50-L60,low,bob,false positive
`;
    fs.writeFileSync(csv1Path, csv1Content, "utf-8");
    fs.writeFileSync(csv2Path, csv2Content, "utf-8");

    const fetchedFiles = new Set<string>();
    const mockFetchProvider = async (source: { filePath: string; revision: string }) => {
      const key = `${source.revision}::${source.filePath}`;
      fetchedFiles.add(key);
      return `
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // line 15
const SHARED_KEY = "ghp_123456789012345678901234567890123456"; // line 35
`;
    };

    const mockTruffleHogExec = async () => {
      return {
        stdout: `{"DetectorName": "AWS", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 15}}}}
{"DetectorName": "GitHub", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 35}}}}`,
        stderr: "",
      };
    };

    const summary = await runPipeline([csv1Path, csv2Path], {
      config: mockConfig,
      output: outputPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(4);
    expect(summary.completed).toBe(4);

    // sha1/src/aws.js and sha2/src/shared.js should each only be fetched once despite findings across both CSVs
    expect(fetchedFiles.size).toBe(2);

    expect(fs.existsSync(outputPath)).toBe(true);
    const outputContent = fs.readFileSync(outputPath, "utf-8");
    const rows: Record<string, string>[] = parse(outputContent, { columns: true, skip_empty_lines: true });

    expect(rows).toHaveLength(4);

    // Union of headers should be present
    expect(Object.keys(rows[0]!)).toEqual([
      "Rule ID",
      "SCM Link",
      "Severity",
      "Suppressed By",
      "Reason",
      "source_file",
      "status",
      "trufflehog_result",
      "trufflehog_detector",
      "llm_classification",
      "llm_reason",
      "llm_confidence",
      "error",
    ]);

    // Check row 0 (from unsuppressed.csv)
    expect(rows[0]!["Rule ID"]).toBe("rule-aws");
    expect(rows[0]!["source_file"]).toBe("unsuppressed.csv");
    expect(rows[0]!["Suppressed By"]).toBe("");
    expect(rows[0]!["Reason"]).toBe("");
    expect(rows[0]!["status"]).toBe("completed");
    expect(rows[0]!["trufflehog_result"]).toBe("verified");

    // Check row 1 (from unsuppressed.csv)
    expect(rows[1]!["Rule ID"]).toBe("rule-shared");
    expect(rows[1]!["source_file"]).toBe("unsuppressed.csv");
    expect(rows[1]!["Suppressed By"]).toBe("");
    expect(rows[1]!["Reason"]).toBe("");
    expect(rows[1]!["status"]).toBe("completed");

    // Check row 2 (from suppressed.csv)
    expect(rows[2]!["Rule ID"]).toBe("rule-shared-2");
    expect(rows[2]!["source_file"]).toBe("suppressed.csv");
    expect(rows[2]!["Suppressed By"]).toBe("alice");
    expect(rows[2]!["Reason"]).toBe("wontfix");
    expect(rows[2]!["status"]).toBe("completed");
    expect(rows[2]!["trufflehog_result"]).toBe("verified");

    // Check row 3 (from suppressed.csv)
    expect(rows[3]!["Rule ID"]).toBe("rule-azure");
    expect(rows[3]!["source_file"]).toBe("suppressed.csv");
    expect(rows[3]!["Suppressed By"]).toBe("bob");
    expect(rows[3]!["Reason"]).toBe("false positive");
    expect(rows[3]!["status"]).toBe("completed");
  });

  it("re-feeds output: skips completed rows, processes pending rows, and preserves existing result columns", async () => {
    const refeedCsvPath = path.join(tmpDir, "refeed_input.csv");
    const outputPath = path.join(tmpDir, "refeed_output.csv");

    const sha = "3333333333333333333333333333333333333333";
    const csvContent = `Rule ID,SCM Link,source_file,status,trufflehog_result,trufflehog_detector,llm_classification,llm_reason,llm_confidence,error
rule-done,https://github.com/my-org/my-repo/blob/${sha}/src/done.js#L10-L20,orig_unsuppressed.csv,completed,verified,AWS,likely_secret,cached reason,0.98,
rule-pending,https://github.com/my-org/my-repo/blob/${sha}/src/pending.js#L10-L20,orig_unsuppressed.csv,pending,,,,,,
rule-skipped,https://github.com/my-org/my-repo/blob/${sha}/src/skipped.js#L10-L20,orig_suppressed.csv,skipped,,,,,,
`;
    fs.writeFileSync(refeedCsvPath, csvContent, "utf-8");

    const fetchedFiles: string[] = [];
    const mockFetchProvider = async (source: { filePath: string }) => {
      fetchedFiles.push(source.filePath);
      return `const FOO = "ghp_123456789012345678901234567890123456"; // line 15`;
    };

    const mockTruffleHogExec = async () => {
      return {
        stdout: `{"DetectorName": "GitHub", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 15}}}}`,
        stderr: "",
      };
    };

    const summary = await runPipeline([refeedCsvPath], {
      config: mockConfig,
      output: outputPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.completed).toBe(3);

    // Only pending and skipped files should have been fetched! Completed file should NOT have been fetched.
    expect(fetchedFiles).toContain("src/pending.js");
    expect(fetchedFiles).toContain("src/skipped.js");
    expect(fetchedFiles).not.toContain("src/done.js");

    const outputContent = fs.readFileSync(outputPath, "utf-8");
    const rows: Record<string, string>[] = parse(outputContent, { columns: true, skip_empty_lines: true });

    expect(rows).toHaveLength(3);

    // Row 0 (completed) should preserve verbatim existing columns including source_file, result, detector, llm info
    expect(rows[0]!["Rule ID"]).toBe("rule-done");
    expect(rows[0]!["source_file"]).toBe("orig_unsuppressed.csv");
    expect(rows[0]!["status"]).toBe("completed");
    expect(rows[0]!["trufflehog_result"]).toBe("verified");
    expect(rows[0]!["trufflehog_detector"]).toBe("AWS");
    expect(rows[0]!["llm_classification"]).toBe("likely_secret");
    expect(rows[0]!["llm_reason"]).toBe("cached reason");
    expect(rows[0]!["llm_confidence"]).toBe("0.98");

    // Row 1 (pending) should now be completed
    expect(rows[1]!["Rule ID"]).toBe("rule-pending");
    expect(rows[1]!["source_file"]).toBe("orig_unsuppressed.csv");
    expect(rows[1]!["status"]).toBe("completed");
    expect(rows[1]!["trufflehog_result"]).toBe("verified");
    expect(rows[1]!["trufflehog_detector"]).toBe("GitHub");

    // Row 2 (skipped) was re-evaluated and is now completed
    expect(rows[2]!["Rule ID"]).toBe("rule-skipped");
    expect(rows[2]!["source_file"]).toBe("orig_suppressed.csv");
    expect(rows[2]!["status"]).toBe("completed");
    expect(rows[2]!["trufflehog_result"]).toBe("verified");
    expect(rows[2]!["trufflehog_detector"]).toBe("GitHub");
  });

  it("handles --retry-failed: reprocesses failed rows when set, skips them when not set, keeping completed skipped in both cases", async () => {
    const csvPath = path.join(tmpDir, "failed_input.csv");
    const sha = "4444444444444444444444444444444444444444";

    const csvContent = `Rule ID,SCM Link,source_file,status,trufflehog_result,trufflehog_detector,error
rule-completed,https://github.com/my-org/my-repo/blob/${sha}/src/completed.js#L10,input.csv,completed,verified,AWS,
rule-failed,https://github.com/my-org/my-repo/blob/${sha}/src/failed.js#L10,input.csv,failed,,,Rate limit exceeded
`;
    fs.writeFileSync(csvPath, csvContent, "utf-8");

    const mockTruffleHogExec = async () => {
      return {
        stdout: `{"DetectorName": "AWS", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 10}}}}`,
        stderr: "",
      };
    };

    // ── Run 1: without retryFailed (retryFailed: false) ─────────────────────
    let fetchedFiles: string[] = [];
    const mockFetchProvider = async (source: { filePath: string }) => {
      fetchedFiles.push(source.filePath);
      return `const AWS = "AKIAIOSFODNN7EXAMPLE"; // line 10`;
    };

    const output1 = path.join(tmpDir, "output_no_retry.csv");
    const summary1 = await runPipeline([csvPath], {
      config: mockConfig,
      output: output1,
      retryFailed: false,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary1.totalFindings).toBe(2);
    expect(summary1.completed).toBe(1);
    expect(summary1.failed).toBe(1);
    // Neither completed nor failed should be fetched when retryFailed is false
    expect(fetchedFiles).toHaveLength(0);

    const rows1: Record<string, string>[] = parse(fs.readFileSync(output1, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
    });
    expect(rows1[0]!["status"]).toBe("completed");
    expect(rows1[1]!["status"]).toBe("failed");
    expect(rows1[1]!["error"]).toBe("Rate limit exceeded");

    // ── Run 2: with retryFailed: true ──────────────────────────────────────
    fetchedFiles = [];
    const output2 = path.join(tmpDir, "output_with_retry.csv");
    const summary2 = await runPipeline([csvPath], {
      config: mockConfig,
      output: output2,
      retryFailed: true,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary2.totalFindings).toBe(2);
    expect(summary2.completed).toBe(2);
    expect(summary2.failed).toBe(0);
    // failed.js should have been fetched and processed, completed.js still skipped
    expect(fetchedFiles).toEqual(["src/failed.js"]);

    const rows2: Record<string, string>[] = parse(fs.readFileSync(output2, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
    });
    expect(rows2[0]!["status"]).toBe("completed");
    expect(rows2[0]!["trufflehog_result"]).toBe("verified");
    expect(rows2[1]!["status"]).toBe("completed");
    expect(rows2[1]!["trufflehog_result"]).toBe("verified");
    expect(rows2[1]!["error"]).toBe("");
  });
});
