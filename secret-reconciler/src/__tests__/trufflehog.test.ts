import { describe, it, expect } from "vitest";
import { parseTruffleHogOutput, runTruffleHog } from "../trufflehog/runner.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "../trufflehog/matcher.js";
import type { FileWorkItem, FindingRef, TruffleHogDetection } from "../types.js";

describe("TruffleHog Runner & Matcher", () => {
  it("parses valid TruffleHog JSON lines output", () => {
    const jsonOutput = `
{"DetectorName": "AWS", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 15}}}}
{"DetectorName": "SlackToken", "Verified": false, "SourceMetadata": {"Data": {"Filesystem": {"line": 40}}}}
`;

    const detections = parseTruffleHogOutput(jsonOutput);
    expect(detections).toHaveLength(2);

    expect(detections[0]).toEqual({
      detectorName: "AWS",
      verified: true,
      lineStart: 15,
      lineEnd: 15,
      raw: undefined,
    });

    expect(detections[1]).toEqual({
      detectorName: "SlackToken",
      verified: false,
      lineStart: 40,
      lineEnd: 40,
      raw: undefined,
    });
  });

  it("invokes executor with correct arguments in runTruffleHog", async () => {
    const mockExec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual(["filesystem", "--file", "/tmp/test.js", "--json"]);
      return {
        stdout: `{"DetectorName": "GitHubToken", "Verified": true, "SourceMetadata": {"Data": {"Filesystem": {"line": 5}}}}`,
        stderr: "",
      };
    };

    const detections = await runTruffleHog("/tmp/test.js", { execFn: mockExec });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.detectorName).toBe("GitHubToken");
    expect(detections[0]!.verified).toBe(true);
  });

  it("invokes executor with --only-verified when verificationMode is verified-only", async () => {
    const mockExec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual(["filesystem", "--file", "/tmp/test.js", "--json", "--only-verified"]);
      return { stdout: "", stderr: "" };
    };

    await runTruffleHog("/tmp/test.js", { execFn: mockExec, verificationMode: "verified-only" });
  });

  it("invokes executor with --no-verification when verificationMode is no-verification", async () => {
    const mockExec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual(["filesystem", "--file", "/tmp/test.js", "--json", "--no-verification"]);
      return { stdout: "", stderr: "" };
    };

    await runTruffleHog("/tmp/test.js", { execFn: mockExec, verificationMode: "no-verification" });
  });

  it("invokes executor with --user-agent-suffix when userAgentSuffix is provided", async () => {
    const mockExec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual([
        "filesystem",
        "--file",
        "/tmp/test.js",
        "--json",
        "--user-agent-suffix=SecurityTeamAudit-2026",
      ]);
      return { stdout: "", stderr: "" };
    };

    await runTruffleHog("/tmp/test.js", {
      execFn: mockExec,
      userAgentSuffix: "SecurityTeamAudit-2026",
    });
  });

  it("invokes executor with combined options and passes custom timeoutMs", async () => {
    const mockExec = async (cmd: string, args: string[], options: { timeout?: number }) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual([
        "filesystem",
        "--file",
        "/tmp/test.js",
        "--json",
        "--only-verified",
        "--user-agent-suffix=SecurityTeamAudit-2026",
      ]);
      expect(options.timeout).toBe(120000);
      return { stdout: "", stderr: "" };
    };

    await runTruffleHog("/tmp/test.js", {
      execFn: mockExec,
      verificationMode: "verified-only",
      userAgentSuffix: "  SecurityTeamAudit-2026  ",
      timeoutMs: 120000,
    });
  });

  it("formats clear error message when process times out (User Story 6)", async () => {
    const mockExec = async () => {
      const timeoutErr = new Error("Command failed: trufflehog filesystem");
      (timeoutErr as unknown as { killed: boolean; signal: string; timedOut: boolean }).killed = true;
      (timeoutErr as unknown as { killed: boolean; signal: string; timedOut: boolean }).signal = "SIGTERM";
      (timeoutErr as unknown as { killed: boolean; signal: string; timedOut: boolean }).timedOut = true;
      throw timeoutErr;
    };

    await expect(
      runTruffleHog("/tmp/test.js", { execFn: mockExec, timeoutMs: 60000 })
    ).rejects.toThrow("TruffleHog process timed out after 60s");

    await expect(
      runTruffleHog("/tmp/test.js", { execFn: mockExec, timeoutMs: 120000 })
    ).rejects.toThrow("TruffleHog process timed out after 120s");
  });

  it("detects ETIMEDOUT code as timeout error", async () => {
    const mockExec = async () => {
      const timeoutErr = new Error("spawn ETIMEDOUT");
      (timeoutErr as unknown as { code: string }).code = "ETIMEDOUT";
      throw timeoutErr;
    };

    await expect(
      runTruffleHog("/tmp/test.js", { execFn: mockExec, timeoutMs: 30000 })
    ).rejects.toThrow("TruffleHog process timed out after 30s");
  });

  it("matches detections to findings by line-range overlap", () => {
    const findings: FindingRef[] = [
      {
        rowIndex: 0,
        sourceFile: "input.csv",
        rawRow: { ID: "f1" },
        initialStatus: "pending",
        canonicalSource: {
          provider: "github",
          org: "org",
          repo: "repo",
          revision: "sha",
          filePath: "index.js",
          lineStart: 10,
          lineEnd: 20,
        },
      },
      {
        rowIndex: 1,
        sourceFile: "input.csv",
        rawRow: { ID: "f2" },
        initialStatus: "pending",
        canonicalSource: {
          provider: "github",
          org: "org",
          repo: "repo",
          revision: "sha",
          filePath: "index.js",
          lineStart: 30,
          lineEnd: 35,
        },
      },
    ];

    const detections = [
      {
        detectorName: "AWS",
        verified: true,
        lineStart: 15, // Overlaps f1 (10-20)
        lineEnd: 15,
      },
      {
        detectorName: "Slack",
        verified: false,
        lineStart: 100, // No overlap
        lineEnd: 105,
      },
    ];

    const results = matchDetectionsToFindings(findings, detections);
    expect(results).toHaveLength(2);

    // f1 should match AWS verified
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.trufflehogResult).toBe("verified");
    expect(results[0]!.trufflehogDetector).toBe("AWS");

    // f2 should be not_found
    expect(results[1]!.status).toBe("completed");
    expect(results[1]!.trufflehogResult).toBe("not_found");
    expect(results[1]!.trufflehogDetector).toBe("");
  });

  it("produces failed FindingResults for work item errors", () => {
    const workItem: FileWorkItem = {
      contentIdentity: "github::org/repo::sha::file.js",
      provider: "github",
      org: "org",
      repo: "repo",
      revision: "sha",
      filePath: "file.js",
      findings: [
        {
          rowIndex: 0,
          sourceFile: "input.csv",
          rawRow: { ID: "f1" },
          initialStatus: "pending",
        },
      ],
    };

    const results = produceErrorResultsForWorkItem(workItem, "GitHub API 404 Not Found");
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.error).toBe("GitHub API 404 Not Found");
    expect(results[0]!.trufflehogResult).toBe("");
  });

  it("marks unverified findings as not_found when verified-only drops unverified detections", () => {
    const findings: FindingRef[] = [
      {
        rowIndex: 0,
        sourceFile: "input.csv",
        rawRow: { ID: "f1" },
        initialStatus: "pending",
        canonicalSource: {
          provider: "github",
          org: "org",
          repo: "repo",
          revision: "sha",
          filePath: "index.js",
          lineStart: 10,
          lineEnd: 20,
        },
      },
    ];

    // In verified-only mode, unverified detections are omitted by TruffleHog
    const detections: TruffleHogDetection[] = [];
    const results = matchDetectionsToFindings(findings, detections);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.trufflehogResult).toBe("not_found");
  });

  it("marks findings as unverified in no-verification mode when verified=false detections are returned", () => {
    const findings: FindingRef[] = [
      {
        rowIndex: 0,
        sourceFile: "input.csv",
        rawRow: { ID: "f1" },
        initialStatus: "pending",
        canonicalSource: {
          provider: "github",
          org: "org",
          repo: "repo",
          revision: "sha",
          filePath: "index.js",
          lineStart: 10,
          lineEnd: 20,
        },
      },
    ];

    // In no-verification mode, TruffleHog emits verified: false detections
    const detections: TruffleHogDetection[] = [
      {
        detectorName: "SlackWebhook",
        verified: false,
        lineStart: 12,
        lineEnd: 12,
      },
    ];
    const results = matchDetectionsToFindings(findings, detections);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.trufflehogResult).toBe("unverified");
    expect(results[0]!.trufflehogDetector).toBe("SlackWebhook");
  });
});
