import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildNonPendingFindingResult,
  readFindingsCsv,
  groupFindingsByContentIdentity,
  mergeHeaders,
} from "../csv/reader.js";
import { RESULT_COLUMNS, writeResultsCsv } from "../csv/writer.js";
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
    expect(result.headers).toEqual(["Rule ID", "SCM Link"]);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.initialStatus).toBe("pending");
    expect(finding.rawRow).not.toHaveProperty("Severity");
    expect(finding.rawRow).toHaveProperty("Rule ID", "rule-01");
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

  it("normalizes legacy not_found results when resuming older output", async () => {
    const csvPath = path.join(tmpDir, "legacy-resume.csv");
    const content = `Rule ID,SCM Link,status,trufflehog_result
rule-01,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file1.js#L10,completed,not_found
`;
    fs.writeFileSync(csvPath, content);

    const { findings } = await readFindingsCsv(csvPath);
    const result = buildNonPendingFindingResult(findings[0]!);
    expect(result.trufflehogResult).toBe("not_detected");
  });

  it("always re-processes findings with status=skipped, status=pending, or empty status", async () => {
    const csvPath = path.join(tmpDir, "resume_skipped.csv");
    const content = `Rule ID,SCM Link,status
rule-01,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file1.js#L10,skipped
rule-02,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file2.js#L10,pending
rule-03,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file3.js#L10,
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.findings[0]!.initialStatus).toBe("pending");
    expect(result.findings[1]!.initialStatus).toBe("pending");
    expect(result.findings[2]!.initialStatus).toBe("pending");
  });

  it("tags findings with source_file as basename of input path and preserves existing source_file if present", async () => {
    const csvPath1 = path.join(tmpDir, "unsuppressed.csv");
    const content1 = `Rule ID,SCM Link
rule-01,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file1.js#L10
`;
    fs.writeFileSync(csvPath1, content1);

    const result1 = await readFindingsCsv(csvPath1);
    expect(result1.findings[0]!.sourceFile).toBe("unsuppressed.csv");

    // CSV with existing source_file header from previous run
    const csvPath2 = path.join(tmpDir, "refeed_output.csv");
    const content2 = `Rule ID,SCM Link,source_file,status
rule-02,https://github.com/my-org/my-repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/file2.js#L10,original_suppressed.csv,completed
`;
    fs.writeFileSync(csvPath2, content2);

    const result2 = await readFindingsCsv(csvPath2);
    expect(result2.findings[0]!.sourceFile).toBe("original_suppressed.csv");
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
      llmClassification: "likely_secret",
      llmReason: "Found key",
      llmConfidence: 0.95,
      error: "",
    };

    writeResultsCsv(outputPath, [mockFinding], originalHeaders);

    const writtenContent = fs.readFileSync(outputPath, "utf-8");
    expect(writtenContent.split("\n")[0]).toBe(
      ["Rule ID", "SCM Link", ...RESULT_COLUMNS].join(",")
    );
    expect(writtenContent).toContain("rule-123");
    expect(writtenContent).toContain("completed");
    expect(writtenContent).toContain("verified");
    expect(writtenContent).toContain("AWS");
  });

  it("writes output CSV with union of headers filling missing row columns with empty string", () => {
    const outputPath = path.join(tmpDir, "union_output.csv");
    const unionHeaders = ["Rule ID", "SCM Link", "Suppressed By", "Reason"];

    const mockFinding1: FindingResult = {
      findingRef: {
        rowIndex: 0,
        sourceFile: "unsuppressed.csv",
        rawRow: {
          "Rule ID": "rule-01",
          "SCM Link": "https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/f.js#L1",
        },
        initialStatus: "pending",
      },
      status: "completed",
      trufflehogResult: "verified",
      trufflehogDetector: "AWS",
      llmClassification: "likely_secret",
      llmReason: "Found key",
      llmConfidence: 0.95,
      error: "",
    };

    const mockFinding2: FindingResult = {
      findingRef: {
        rowIndex: 0,
        sourceFile: "suppressed.csv",
        rawRow: {
          "Rule ID": "rule-02",
          "SCM Link": "https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/f.js#L1",
          "Suppressed By": "alice",
          "Reason": "test secret",
        },
        initialStatus: "pending",
      },
      status: "completed",
      trufflehogResult: "verified",
      trufflehogDetector: "AWS",
      llmClassification: "likely_secret",
      llmReason: "Found key",
      llmConfidence: 0.95,
      error: "",
    };

    writeResultsCsv(outputPath, [mockFinding1, mockFinding2], unionHeaders);

    const writtenContent = fs.readFileSync(outputPath, "utf-8");
    const lines = writtenContent.trim().split("\n");
    expect(lines[0]).toBe(
      ["Rule ID", "SCM Link", "Suppressed By", "Reason", ...RESULT_COLUMNS].join(",")
    );
    // Row 1 should have empty Suppressed By and Reason
    expect(lines[1]).toContain("rule-01,https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/f.js#L1,,,unsuppressed.csv,completed,verified,AWS,likely_secret,Found key,0.95,");
    // Row 2 should have alice and test secret
    expect(lines[2]).toContain("rule-02,https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/f.js#L1,alice,test secret,suppressed.csv,completed,verified,AWS,likely_secret,Found key,0.95,");
  });

  it("round-trips contextual and detector-gap audit fields for resume", async () => {
    const outputPath = path.join(tmpDir, "contextual-output.csv");
    const target: FindingResult = {
      findingRef: {
        rowIndex: 0,
        sourceFile: "input.csv",
        rawRow: {
          "Rule ID": "internal-token",
          "SCM Link": "https://github.com/org/repo/blob/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/deploy/prod.yaml#L8",
        },
        initialStatus: "pending",
      },
      status: "completed",
      trufflehogResult: "not_detected",
      llmClassification: "probable_secret",
      llmReason: "Production deployment credential field",
      llmConfidence: 0.91,
      contextAssessment: {
        classification: "probable_secret",
        fileRole: "deployment_manifest",
        environment: "production",
        exposureScope: "internal",
        principalScope: "service_account",
        secretKind: "api_token",
        evidenceStrength: "strong",
        confidence: 0.91,
        evidence: [{ source: "content", description: "service account token", line: 8 }],
        benignSignals: [],
        riskSignals: ["production marker"],
        missingEvidence: ["live verification"],
        reason: "Production deployment credential field",
      },
      detectorGapAssessment: {
        status: "new_detector_candidate",
        proposedName: "InternalToken",
        keywords: ["internal_token"],
        regexTemplate: "INT_[A-Za-z0-9]{24}",
        exclusionSuggestions: ["test fixtures"],
        evidence: ["not detected"],
        reason: "Generalized token shape was not detected",
      },
      llmModel: "security-context-v1",
      llmPromptVersion: "context-classifier-v1+detector-advisor-v1",
      error: "",
    };

    writeResultsCsv(outputPath, [target], ["Rule ID", "SCM Link"]);
    const { findings } = await readFindingsCsv(outputPath);
    const resumed = buildNonPendingFindingResult(findings[0]!);

    expect(resumed.contextAssessment).toMatchObject({
      classification: "probable_secret",
      fileRole: "deployment_manifest",
      evidenceStrength: "strong",
    });
    expect(resumed.detectorGapAssessment).toMatchObject({
      status: "new_detector_candidate",
      proposedName: "InternalToken",
    });
    expect(resumed.llmPromptVersion).toContain("detector-advisor-v1");
  });

  it("mergeHeaders combines multiple header arrays with normalized deduplication", () => {
    const list1 = ["Rule ID", "SCM Link", "status"];
    const list2 = ["scm_link", "Severity", "STATUS", "Notes"];
    const merged = mergeHeaders(list1, list2);
    expect(merged).toEqual(["Rule ID", "SCM Link", "status", "Severity", "Notes"]);
  });

  it("drops all redundant scanner columns from headers and rawRow at ingestion", async () => {
    const csvPath = path.join(tmpDir, "all_dropped.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `title,severity,repository,file path,lines,first seen,resource,policy names,Rule ID,SCM Link,Custom Col
My Secret,high,my-org/my-repo,src/index.js,10-20,2023-01-01,res-1,Default Policy,rule-01,https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20,custom-val
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.headers).toEqual(["Rule ID", "SCM Link", "Custom Col"]);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.rawRow).toEqual({
      "Rule ID": "rule-01",
      "SCM Link": `https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20`,
      "Custom Col": "custom-val",
    });
  });

  it("drops header variants with different casing, underscores, and spacing", async () => {
    const csvPath = path.join(tmpDir, "variants.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `Title,SEVERITY,Repository,file_path,FILE PATH,filePath,Line,LINES,first_seen,FIRST_SEEN,Resource,policy_name,Policy Names,policy_names,SCM Link,Account ID
T,H,R,p1,p2,p3,1,10,2023,2024,res,pol,pols,pols2,https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20,acc-123
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.headers).toEqual(["SCM Link", "Account ID"]);
    expect(result.findings).toHaveLength(1);

    const finding = result.findings[0]!;
    expect(finding.rawRow).toEqual({
      "SCM Link": `https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20`,
      "Account ID": "acc-123",
    });
  });

  it("ingests minimal CSVs missing all dropped columns without error", async () => {
    const csvPath = path.join(tmpDir, "minimal.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `SCM Link
https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.headers).toEqual(["SCM Link"]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.initialStatus).toBe("pending");
    expect(result.findings[0]!.canonicalSource).toBeDefined();
  });

  it("preserves custom metadata columns verbatim in headers and rawRow", async () => {
    const csvPath = path.join(tmpDir, "custom.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const content = `SCM Link,Account ID,Owner,Environment,Notes,Suppressed By
https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20,123456,sec-team,prod,valid ignore,alice
`;
    fs.writeFileSync(csvPath, content);

    const result = await readFindingsCsv(csvPath);
    expect(result.headers).toEqual(["SCM Link", "Account ID", "Owner", "Environment", "Notes", "Suppressed By"]);
    expect(result.findings[0]!.rawRow).toEqual({
      "SCM Link": `https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L10-L20`,
      "Account ID": "123456",
      "Owner": "sec-team",
      "Environment": "prod",
      "Notes": "valid ignore",
      "Suppressed By": "alice",
    });
  });

  it("extracts Check ID across multiple header variants (Check ID, Rule ID, Policy ID, check_id, rule_name)", async () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const testCases = [
      { header: "Check ID", value: "CKV_SECRET_6" },
      { header: "check_id", value: "CKV_AWS_1" },
      { header: "Rule ID", value: "rule-123" },
      { header: "rule_id", value: "rule-456" },
      { header: "Policy ID", value: "POL-001" },
      { header: "policy_id", value: "POL-002" },
      { header: "check_name", value: "CKV_GCP_1" },
      { header: "Rule Name", value: "rule_name_test" },
      { header: "policy_name", value: "pol_name_test" },
    ];

    for (const { header, value } of testCases) {
      const csvPath = path.join(tmpDir, `check_id_${header.replace(/\s+/g, "_")}.csv`);
      const content = `${header},SCM Link\n  ${value}  ,https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L1\n`;
      fs.writeFileSync(csvPath, content);

      const result = await readFindingsCsv(csvPath);
      expect(result.findings[0]!.checkId).toBe(value);
    }
  });

  it("sets checkId to undefined when Check ID column is missing or empty", async () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvPath1 = path.join(tmpDir, "no_check_id.csv");
    fs.writeFileSync(csvPath1, `SCM Link\nhttps://github.com/my-org/my-repo/blob/${sha}/src/index.js#L1\n`);
    const result1 = await readFindingsCsv(csvPath1);
    expect(result1.findings[0]!.checkId).toBeUndefined();

    const csvPath2 = path.join(tmpDir, "empty_check_id.csv");
    fs.writeFileSync(csvPath2, `Check ID,SCM Link\n"   ",https://github.com/my-org/my-repo/blob/${sha}/src/index.js#L1\n`);
    const result2 = await readFindingsCsv(csvPath2);
    expect(result2.findings[0]!.checkId).toBeUndefined();
  });
});
