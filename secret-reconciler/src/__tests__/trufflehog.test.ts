import { describe, it, expect } from "vitest";
import {
  assertSupportedTruffleHogVersion,
  parseTruffleHogOutput,
  runTruffleHog,
  SUPPORTED_TRUFFLEHOG_VERSION,
} from "../trufflehog/runner.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "../trufflehog/matcher.js";
import type { FileWorkItem, FindingRef, TruffleHogDetection } from "../types.js";

const finding = (rowIndex: number, lineStart: number, lineEnd = lineStart): FindingRef => ({
  rowIndex,
  sourceFile: "input.csv",
  rawRow: { ID: `f${rowIndex + 1}` },
  initialStatus: "pending",
  canonicalSource: {
    provider: "github",
    org: "org",
    repo: "repo",
    revision: "sha",
    filePath: "index.js",
    lineStart,
    lineEnd,
  },
});

describe("TruffleHog Runner", () => {
  it("parses verified, unverified, and unknown JSONL results without retaining raw secrets", () => {
    const jsonOutput = [
      { DetectorName: "AWS", Verified: true, Raw: "must-not-survive", SourceMetadata: { Data: { Filesystem: { line: 15 } } } },
      { DetectorName: "SlackToken", Verified: false, SourceMetadata: { Data: { Filesystem: { line: 40 } } } },
      { DetectorName: "GitHub", Verified: false, VerificationError: "upstream timeout", SourceMetadata: { Data: { Filesystem: { line: 60 } } } },
    ].map((record) => JSON.stringify(record)).join("\n");

    expect(parseTruffleHogOutput(jsonOutput)).toEqual([
      { detectorName: "AWS", verificationStatus: "verified", lineStart: 15, lineEnd: 15 },
      { detectorName: "SlackToken", verificationStatus: "unverified", lineStart: 40, lineEnd: 40 },
      { detectorName: "GitHub", verificationStatus: "unknown", lineStart: 60, lineEnd: 60 },
    ]);
  });

  it("preserves missing location metadata instead of inventing a file-wide range", () => {
    expect(parseTruffleHogOutput('{"DetectorName":"AWS","Verified":true}')).toEqual([
      { detectorName: "AWS", verificationStatus: "verified", lineStart: undefined, lineEnd: undefined },
    ]);
  });

  it("fails closed on malformed or incomplete JSONL records", () => {
    expect(() => parseTruffleHogOutput("not-json")).toThrow("Invalid TruffleHog JSON output at line 1");
    expect(() => parseTruffleHogOutput('{"Verified":true}')).toThrow("missing detector name");
    expect(() => parseTruffleHogOutput('{"DetectorName":"AWS"}')).toThrow("missing boolean Verified field");
  });

  it("uses the pinned filesystem CLI contract", async () => {
    const mockExec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual([
        "filesystem",
        "/tmp/test.js",
        "--json",
        "--results=verified,unverified,unknown",
        "--no-update",
        "--fail-on-scan-errors",
      ]);
      return {
        stdout: '{"DetectorName":"GitHubToken","Verified":true,"SourceMetadata":{"Data":{"Filesystem":{"line":5}}}}',
        stderr: "",
      };
    };

    const detections = await runTruffleHog("/tmp/test.js", { execFn: mockExec });
    expect(detections[0]!.verificationStatus).toBe("verified");
  });

  it("passes verification, custom detector, user-agent, and timeout options", async () => {
    const mockExec = async (cmd: string, args: string[], options: { timeout?: number }) => {
      expect(cmd).toBe("trufflehog");
      expect(args).toEqual([
        "filesystem",
        "/tmp/test.js",
        "--json",
        "--results=verified,unverified,unknown",
        "--no-update",
        "--fail-on-scan-errors",
        "--no-verification",
        "--config=/etc/trufflehog/custom.yaml",
        "--user-agent-suffix=SecurityTeamAudit-2026",
      ]);
      expect(options.timeout).toBe(120000);
      return { stdout: "", stderr: "" };
    };

    await runTruffleHog("/tmp/test.js", {
      execFn: mockExec,
      verificationMode: "no-verification",
      configPath: "  /etc/trufflehog/custom.yaml  ",
      userAgentSuffix: "  SecurityTeamAudit-2026  ",
      timeoutMs: 120000,
    });
  });

  it("accepts the supported TruffleHog version", async () => {
    const mockExec = async () => ({
      stdout: `trufflehog ${SUPPORTED_TRUFFLEHOG_VERSION}\n`,
      stderr: "",
    });

    await expect(assertSupportedTruffleHogVersion({ execFn: mockExec })).resolves.toBeUndefined();
  });

  it("rejects a different or unreadable TruffleHog version", async () => {
    const wrongVersion = async () => ({ stdout: "trufflehog 3.96.0", stderr: "" });
    await expect(assertSupportedTruffleHogVersion({ execFn: wrongVersion })).rejects.toThrow(
      `Expected ${SUPPORTED_TRUFFLEHOG_VERSION}`
    );

    const failedVersion = async () => { throw new Error("command not found"); };
    await expect(assertSupportedTruffleHogVersion({ execFn: failedVersion })).rejects.toThrow(
      "Unable to determine TruffleHog version"
    );
  });

  it("fails closed when the process exits non-zero with partial stdout", async () => {
    const mockExec = async () => {
      const error = new Error("exit code 1") as Error & { stdout: string; stderr: string };
      error.stdout = '{"DetectorName":"AWS","Verified":true}';
      error.stderr = "scan interrupted";
      throw error;
    };

    await expect(runTruffleHog("/tmp/test.js", { execFn: mockExec })).rejects.toThrow(
      "TruffleHog execution failed: exit code 1: scan interrupted"
    );
  });

  it("formats a clear timeout error", async () => {
    const mockExec = async () => {
      const error = new Error("Command failed: trufflehog filesystem") as Error & {
        killed: boolean;
        signal: string;
        timedOut: boolean;
      };
      error.killed = true;
      error.signal = "SIGTERM";
      error.timedOut = true;
      throw error;
    };

    await expect(runTruffleHog("/tmp/test.js", { execFn: mockExec, timeoutMs: 60000 }))
      .rejects.toThrow("TruffleHog process timed out after 60s");
  });
});

describe("TruffleHog Matcher", () => {
  it("matches a unique detection by line-range overlap", () => {
    const results = matchDetectionsToFindings(
      [finding(0, 10, 20), finding(1, 30, 35)],
      [
        { detectorName: "AWS", verificationStatus: "verified", lineStart: 15, lineEnd: 15 },
        { detectorName: "Slack", verificationStatus: "unverified", lineStart: 100, lineEnd: 105 },
      ]
    );

    expect(results[0]!.trufflehogResult).toBe("verified");
    expect(results[0]!.trufflehogDetector).toBe("AWS");
    expect(results[1]!.trufflehogResult).toBe("not_detected");
  });

  it("maps verification failures to unknown", () => {
    const results = matchDetectionsToFindings(
      [finding(0, 10)],
      [{ detectorName: "AWS", verificationStatus: "unknown", lineStart: 10, lineEnd: 10 }]
    );
    expect(results[0]!.trufflehogResult).toBe("unknown");
  });

  it("marks a locationless detection as ambiguous", () => {
    const results = matchDetectionsToFindings(
      [finding(0, 10)],
      [{ detectorName: "AWS", verificationStatus: "verified" }]
    );
    expect(results[0]!.trufflehogResult).toBe("ambiguous");
    expect(results[0]!.error).toContain("missing source location metadata");
  });

  it("marks one detection overlapping multiple findings as ambiguous", () => {
    const results = matchDetectionsToFindings(
      [finding(0, 10, 12), finding(1, 12, 14)],
      [{ detectorName: "AWS", verificationStatus: "verified", lineStart: 12, lineEnd: 12 }]
    );
    expect(results.map((result) => result.trufflehogResult)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("marks multiple detections overlapping one finding as ambiguous", () => {
    const results = matchDetectionsToFindings(
      [finding(0, 10, 12)],
      [
        { detectorName: "AWS", verificationStatus: "verified", lineStart: 10, lineEnd: 10 },
        { detectorName: "Slack", verificationStatus: "unverified", lineStart: 12, lineEnd: 12 },
      ]
    );
    expect(results[0]!.trufflehogResult).toBe("ambiguous");
    expect(results[0]!.trufflehogDetector).toBe("AWS, Slack");
  });

  it("returns not_detected for a clean scan", () => {
    const results = matchDetectionsToFindings([finding(0, 10, 20)], []);
    expect(results[0]!.trufflehogResult).toBe("not_detected");
  });

  it("produces failed results for work item errors", () => {
    const workItem: FileWorkItem = {
      contentIdentity: "github::org/repo::sha::file.js",
      provider: "github",
      org: "org",
      repo: "repo",
      revision: "sha",
      filePath: "file.js",
      findings: [{ rowIndex: 0, sourceFile: "input.csv", rawRow: { ID: "f1" }, initialStatus: "pending" }],
    };

    const results = produceErrorResultsForWorkItem(workItem, "GitHub API 404 Not Found");
    expect(results[0]).toMatchObject({
      status: "failed",
      error: "GitHub API 404 Not Found",
      trufflehogResult: "",
    });
  });

  it("preserves unverified detections in no-verification mode", () => {
    const detections: TruffleHogDetection[] = [
      { detectorName: "SlackWebhook", verificationStatus: "unverified", lineStart: 12, lineEnd: 12 },
    ];
    const results = matchDetectionsToFindings([finding(0, 10, 20)], detections);
    expect(results[0]!.trufflehogResult).toBe("unverified");
  });
});
