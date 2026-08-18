import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";
import { readFindingsCsv } from "../csv/reader.js";

describe("Pipeline — Check ID Filtering and Finding Limits", () => {
  let tmpDir: string;

  const mockConfig: AppConfig = {
    flow: "trufflehog-only",
    anthropicApiKey: "test-key",
    anthropicModel: "claude-3-5-sonnet-20241022",
    maxTokensPerRequest: 4096,
    maxLlmCallsPerFile: 3,
    githubPats: ["ghp_mock_pat"],
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 10,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-filter-limit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const dummyFetchProvider = async () => {
    return "const apiKey = 'AKIA1111111111111111';\n";
  };

  const dummyTrufflehogExec = async () => {
    return {
      stdout: JSON.stringify({
        DetectorName: "AWS",
        Verified: true,
        SourceMetadata: {
          Data: {
            Filesystem: {
              line: 1,
            },
          },
        },
        Raw: "AKIA1111111111111111",
      }),
      stderr: "",
    };
  };

  it("filters findings by single Check ID (case-insensitive) and preserves non-matching rows as pending", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Check ID,SCM Link
CKV_SECRET_6,https://github.com/org/repo/blob/${sha}/file1.js#L1
ckv_secret_1,https://github.com/org/repo/blob/${sha}/file2.js#L1
CKV_SECRET_6,https://github.com/org/repo/blob/${sha}/file3.js#L1
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "output.csv");

    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, checkIds: ["ckv_secret_6"] },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.matchedCheckIds).toBe(2);
    expect(summary.selectedFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.pending).toBe(1);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("completed");
    expect(reRead.findings[1]!.initialStatus).toBe("pending"); // non-matching preserved as pending
    expect(reRead.findings[2]!.initialStatus).toBe("completed");
  });

  it("filters findings by multiple Check IDs", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Rule ID,SCM Link
CKV_SECRET_6,https://github.com/org/repo/blob/${sha}/file1.js#L1
CKV_AWS_1,https://github.com/org/repo/blob/${sha}/file2.js#L1
CKV_GCP_2,https://github.com/org/repo/blob/${sha}/file3.js#L1
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "output.csv");

    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, checkIds: ["CKV_SECRET_6", "CKV_AWS_1"] },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(3);
    expect(summary.matchedCheckIds).toBe(2);
    expect(summary.selectedFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.pending).toBe(1);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("completed");
    expect(reRead.findings[1]!.initialStatus).toBe("completed");
    expect(reRead.findings[2]!.initialStatus).toBe("pending");
  });

  it("bounds execution to LIMIT pending findings and preserves unreached rows as pending", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Check ID,SCM Link
CKV_1,https://github.com/org/repo/blob/${sha}/file1.js#L1
CKV_2,https://github.com/org/repo/blob/${sha}/file2.js#L1
CKV_3,https://github.com/org/repo/blob/${sha}/file3.js#L1
CKV_4,https://github.com/org/repo/blob/${sha}/file4.js#L1
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "output.csv");

    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, limit: 2 },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(4);
    expect(summary.matchedCheckIds).toBe(4);
    expect(summary.selectedFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.pending).toBe(2);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("completed");
    expect(reRead.findings[1]!.initialStatus).toBe("completed");
    expect(reRead.findings[2]!.initialStatus).toBe("pending");
    expect(reRead.findings[3]!.initialStatus).toBe("pending");
  });

  it("applies Check ID filter FIRST and then limits the matched subset (filter-then-limit)", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Check ID,SCM Link
OTHER,https://github.com/org/repo/blob/${sha}/file0.js#L1
TARGET,https://github.com/org/repo/blob/${sha}/file1.js#L1
OTHER,https://github.com/org/repo/blob/${sha}/file2.js#L1
TARGET,https://github.com/org/repo/blob/${sha}/file3.js#L1
TARGET,https://github.com/org/repo/blob/${sha}/file4.js#L1
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "output.csv");

    // Filter TARGET (3 matches) and limit to 2 -> should process file1 and file3
    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, checkIds: ["TARGET"], limit: 2 },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(5);
    expect(summary.matchedCheckIds).toBe(3);
    expect(summary.selectedFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.pending).toBe(3);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("pending"); // OTHER
    expect(reRead.findings[1]!.initialStatus).toBe("completed"); // TARGET 1
    expect(reRead.findings[2]!.initialStatus).toBe("pending"); // OTHER
    expect(reRead.findings[3]!.initialStatus).toBe("completed"); // TARGET 2
    expect(reRead.findings[4]!.initialStatus).toBe("pending"); // TARGET 3 (excluded by limit)
  });

  it("does not consume LIMIT budget on pre-existing completed rows when resuming (User Story 8)", async () => {
    const csvPath = path.join(tmpDir, "resume_input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Check ID,SCM Link,status
CKV_1,https://github.com/org/repo/blob/${sha}/file1.js#L1,completed
CKV_1,https://github.com/org/repo/blob/${sha}/file2.js#L1,completed
CKV_1,https://github.com/org/repo/blob/${sha}/file3.js#L1,pending
CKV_1,https://github.com/org/repo/blob/${sha}/file4.js#L1,pending
CKV_1,https://github.com/org/repo/blob/${sha}/file5.js#L1,pending
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "resume_output.csv");

    // limit: 2 should process the first 2 pending rows (file3, file4), not the completed rows
    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, limit: 2 },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(5);
    expect(summary.matchedCheckIds).toBe(5);
    expect(summary.selectedFindings).toBe(2);
    expect(summary.completed).toBe(4); // 2 pre-existing + 2 newly completed
    expect(summary.pending).toBe(1); // 1 remaining pending

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("completed");
    expect(reRead.findings[1]!.initialStatus).toBe("completed");
    expect(reRead.findings[2]!.initialStatus).toBe("completed");
    expect(reRead.findings[3]!.initialStatus).toBe("completed");
    expect(reRead.findings[4]!.initialStatus).toBe("pending");
  });

  it("applies filtering and limits globally across multiple input CSV files in argument order (User Story 6)", async () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const csv1Path = path.join(tmpDir, "file1.csv");
    const csv2Path = path.join(tmpDir, "file2.csv");

    const content1 = `Check ID,SCM Link
TARGET,https://github.com/org/repo/blob/${sha}/file1.js#L1
OTHER,https://github.com/org/repo/blob/${sha}/file2.js#L1
TARGET,https://github.com/org/repo/blob/${sha}/file3.js#L1
`;
    const content2 = `Check ID,SCM Link
TARGET,https://github.com/org/repo/blob/${sha}/file4.js#L1
TARGET,https://github.com/org/repo/blob/${sha}/file5.js#L1
`;
    fs.writeFileSync(csv1Path, content1);
    fs.writeFileSync(csv2Path, content2);
    const outputPath = path.join(tmpDir, "multi_output.csv");

    // TARGET matches 4 findings across the two files (2 in file1, 2 in file2).
    // limit: 3 should select the 2 from file1 and the first 1 from file2.
    const summary = await runPipeline([csv1Path, csv2Path], {
      config: { ...mockConfig, checkIds: ["TARGET"], limit: 3 },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(5);
    expect(summary.matchedCheckIds).toBe(4);
    expect(summary.selectedFindings).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.pending).toBe(2);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("completed"); // file1 TARGET 1
    expect(reRead.findings[1]!.initialStatus).toBe("pending"); // file1 OTHER
    expect(reRead.findings[2]!.initialStatus).toBe("completed"); // file1 TARGET 2
    expect(reRead.findings[3]!.initialStatus).toBe("completed"); // file2 TARGET 1
    expect(reRead.findings[4]!.initialStatus).toBe("pending"); // file2 TARGET 2 (excluded by limit)
  });

  it("treats findings without Check ID column as non-matching when Check ID filter is active", async () => {
    const csvPath = path.join(tmpDir, "no_check_id.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `SCM Link
https://github.com/org/repo/blob/${sha}/file1.js#L1
https://github.com/org/repo/blob/${sha}/file2.js#L1
`;
    fs.writeFileSync(csvPath, content);
    const outputPath = path.join(tmpDir, "output.csv");

    const summary = await runPipeline([csvPath], {
      config: { ...mockConfig, checkIds: ["CKV_SECRET_6"] },
      output: outputPath,
      fetchProvider: dummyFetchProvider,
      trufflehogExecFn: dummyTrufflehogExec,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.matchedCheckIds).toBe(0);
    expect(summary.selectedFindings).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.pending).toBe(2);

    const reRead = await readFindingsCsv(outputPath);
    expect(reRead.findings[0]!.initialStatus).toBe("pending");
    expect(reRead.findings[1]!.initialStatus).toBe("pending");
  });
});
