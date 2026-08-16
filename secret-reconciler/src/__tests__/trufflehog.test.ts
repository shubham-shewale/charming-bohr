import { describe, it, expect } from "vitest";
import { parseTruffleHogOutput, runTruffleHog } from "../trufflehog/runner.js";
import { matchDetectionsToFindings, produceErrorResultsForWorkItem } from "../trufflehog/matcher.js";
import type { FileWorkItem, FindingRef } from "../types.js";

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
});
