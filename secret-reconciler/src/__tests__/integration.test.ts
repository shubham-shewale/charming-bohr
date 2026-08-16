import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "csv-parse/sync";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";

describe("End-to-End TruffleHog Pipeline Integration Test", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-e2e-test-"));
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
    githubPat: "dummy-github-pat",
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 5,
    cleanupTempFiles: true,
  };

  it("processes CSV through mock fetcher and mock TruffleHog runner to output CSV", async () => {
    const inputCsvPath = path.join(tmpDir, "findings.csv");
    const outputCsvPath = path.join(tmpDir, "results.csv");

    const sha = "1234567890abcdef1234567890abcdef12345678";
    const csvContent = `Rule ID,SCM Link,Severity
rule-aws,https://github.com/my-org/my-repo/blob/${sha}/src/aws.js#L10-L20,high
rule-clean,https://github.com/my-org/my-repo/blob/${sha}/src/aws.js#L100-L110,low
rule-bad,https://github.com/invalid-link,medium
`;
    fs.writeFileSync(inputCsvPath, csvContent, "utf-8");

    let fetchCount = 0;
    const mockFetchProvider = async () => {
      fetchCount++;
      return `
// line 1 to 9
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // line 15
// line 16 to 120
`;
    };

    const mockTruffleHogExec = async () => {
      return {
        stdout: `{"DetectorName": "AWS", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 15}}}}`,
        stderr: "",
      };
    };

    const summary = await runPipeline([inputCsvPath], {
      config: mockConfig,
      output: outputCsvPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.completed).toBe(2);
    expect(summary.verified).toBe(1);
    expect(summary.notFound).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);

    // GitHub fetch should have been called ONCE for both findings in src/aws.js
    expect(fetchCount).toBe(1);

    // Verify output CSV content
    expect(fs.existsSync(outputCsvPath)).toBe(true);
    const outputContent = fs.readFileSync(outputCsvPath, "utf-8");
    const rows: Record<string, string>[] = parse(outputContent, { columns: true, skip_empty_lines: true });

    expect(rows).toHaveLength(3);

    // Row 1: rule-aws
    expect(rows[0]["Rule ID"]).toBe("rule-aws");
    expect(rows[0]["status"]).toBe("completed");
    expect(rows[0]["trufflehog_result"]).toBe("verified");
    expect(rows[0]["trufflehog_detector"]).toBe("AWS");
    expect(rows[0]["error"]).toBe("");

    // Row 2: rule-clean
    expect(rows[1]["Rule ID"]).toBe("rule-clean");
    expect(rows[1]["status"]).toBe("completed");
    expect(rows[1]["trufflehog_result"]).toBe("not_found");
    expect(rows[1]["trufflehog_detector"]).toBe("");
    expect(rows[1]["error"]).toBe("");

    // Row 3: rule-bad
    expect(rows[2]["Rule ID"]).toBe("rule-bad");
    expect(rows[2]["status"]).toBe("skipped");
    expect(rows[2]["error"]).toContain('URL path does not contain "/blob/"');
  });
});
