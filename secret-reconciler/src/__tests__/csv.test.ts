import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFindingsCsv, groupFindingsByContentIdentity } from "../csv/reader.js";
import { writeResultsCsv } from "../csv/writer.js";
import type { FindingResult } from "../types.js";

describe("CSV Reader & Writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-csv-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads CSV and discovers SCM Link header dynamically", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const content = `Rule ID,SCM Link,Severity
rule-01,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/src/index.js#L10-L20,high
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.headers).toEqual(["Rule ID", "SCM Link", "Severity"]);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.initialStatus).toBe("pending");
    expect(finding.canonicalSource).toEqual({
      provider: "github",
      org: "my-org",
      repo: "my-repo",
      revision: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      filePath: "src/index.js",
      lineStart: 10,
      lineEnd: 20,
    });
  });

  it("marks rows with unparseable SCM link as skipped", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const content = `Rule ID,URL
rule-02,https://invalid-url.com/some/path
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.initialStatus).toBe("skipped");
    expect(finding.parseError?.kind).toBe("unsupported-host");
  });

  it("respects existing status column for resume logic (ADR 0002)", async () => {
    const csvPath = path.join(tmpDir, "resume.csv");
    const content = `Rule ID,SCM Link,status
rule-01,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file1.js#L10,completed
rule-02,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file2.js#L10,failed
rule-03,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file3.js#L10,pending
`;
    fs.writeFileSync(csvPath, content);

    // Default: retryFailed=false
    const resultDefault = await readFindingsCsv(csvPath);
    expect(resultDefault.findings[0]!.initialStatus).toBe("completed");
    expect(resultDefault.findings[1]!.initialStatus).toBe("failed");
    expect(resultDefault.findings[2]!.initialStatus).toBe("pending");

    // With retryFailed=true
    const resultRetry = await readFindingsCsv(csvPath, { retryFailed: true });
    expect(resultRetry.findings[0]!.initialStatus).toBe("completed");
    expect(resultRetry.findings[1]!.initialStatus).toBe("pending"); // retried
    expect(resultRetry.findings[2]!.initialStatus).toBe("pending");
  });

  it("groups pending findings by Content Identity", async () => {
    const csvPath = path.join(tmpDir, "input.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `SCM Link
https://github.com/org1/repo1/blob/${sha}/file1.js#L5
https://github.com/org1/repo1/blob/${sha}/file1.js#L50
https://github.com/org1/repo1/blob/${sha}/file2.js#L5
`;
    fs.writeFileSync(csvPath, content);

    const { findings } = await readFindingsCsv(csvPath);
    const workMap = groupFindingsByContentIdentity(findings);

    expect(workMap.size).toBe(2);
    const file1Key = `github::org1/repo1::${sha}::file1.js`;
    expect(workMap.has(file1Key)).toBe(true);
    expect(workMap.get(file1Key)!.findings).toHaveLength(2);
  });

  it("writes output CSV preserving original headers and adding result columns", () => {
    const outputPath = path.join(tmpDir, "output.csv");
    const originalHeaders = ["Rule ID", "SCM Link"];

    const mockFinding: FindingResult = {
      findingRef: {
        rowIndex: 0,
        sourceFile: "input.csv",
        rawRow: {
          "Rule ID": "rule-123",
          "SCM Link": "https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/f.js#L1",
        },
        initialStatus: "pending",
      },
      status: "completed",
      trufflehogResult: "verified",
      trufflehogDetector: "AWS",
      error: "",
    };

    writeResultsCsv(outputPath, [mockFinding], originalHeaders);

    const writtenContent = fs.readFileSync(outputPath, "utf-8");
    expect(writtenContent).toContain("Rule ID,SCM Link,source_file,status,trufflehog_result,trufflehog_detector,error");
    expect(writtenContent).toContain("rule-123");
    expect(writtenContent).toContain("completed");
    expect(writtenContent).toContain("verified");
    expect(writtenContent).toContain("AWS");
  });
});
