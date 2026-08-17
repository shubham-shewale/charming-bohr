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
    flow: "trufflehog-only",
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

  it("marks all findings for a file exceeding MAX_FILE_SIZE_KB as status=skipped with error and skips analysis", async () => {
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

    let truffleHogCalledForLarge = false;
    let truffleHogCalledForSmall = false;

    const mockFetchProvider = async (source: { filePath: string }) => {
      if (source.filePath.includes("large.js")) {
        return largeContent;
      }
      return smallContent;
    };

    const mockTruffleHogExec = async (_cmd: string, args: string[]) => {
      const fullArgs = args.join(" ");
      if (fullArgs.includes("large")) {
        truffleHogCalledForLarge = true;
      }
      if (fullArgs.includes("small")) {
        truffleHogCalledForSmall = true;
      }
      return {
        stdout: `{"DetectorName": "Generic", "Verified": false, "SourceMetadata": {"Data": {"Filesystem": {"line": 1}}}}`,
        stderr: "",
      };
    };

    const summary = await runPipeline([inputCsvPath], {
      config: baseConfig,
      output: outputCsvPath,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHogExec as any,
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.skipped).toBe(2); // Both findings in large.js skipped
    expect(summary.completed).toBe(1); // Finding in small.js completed

    // TruffleHog should NOT have been called on the large file
    expect(truffleHogCalledForLarge).toBe(false);
    expect(truffleHogCalledForSmall).toBe(true);

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
});
