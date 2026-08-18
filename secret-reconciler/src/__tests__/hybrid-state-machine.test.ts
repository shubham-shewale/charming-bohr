import { describe, expect, it, vi } from "vitest";
import {
  executeHybridFlow,
  transitionAfterVerification,
} from "../hybrid/state-machine.js";
import type { ClaudeAnalyzer } from "../llm/analyzer.js";
import type { FileWorkItem, FindingRef, FindingResult } from "../types.js";

const finding = (rowIndex: number, lineStart: number, lineEnd = lineStart): FindingRef => ({
  rowIndex,
  sourceFile: "findings.csv",
  rawRow: { "Rule ID": `rule-${rowIndex}` },
  initialStatus: "pending",
  canonicalSource: {
    provider: "github",
    org: "my-org",
    repo: "my-repo",
    revision: "1234567890abcdef1234567890abcdef12345678",
    filePath: "src/index.js",
    lineStart,
    lineEnd,
  },
});

const workItem = (findings: FindingRef[]): FileWorkItem => ({
  contentIdentity:
    "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
  provider: "github",
  org: "my-org",
  repo: "my-repo",
  revision: "1234567890abcdef1234567890abcdef12345678",
  filePath: "src/index.js",
  findings,
});

const verificationResult = (
  target: FindingRef,
  trufflehogResult: FindingResult["trufflehogResult"]
): FindingResult => ({
  findingRef: target,
  status: "completed",
  trufflehogResult,
  trufflehogDetector: trufflehogResult === "not_detected" ? "" : "AWS",
  error: "",
});

describe("verification-first transition function", () => {
  it.each([
    ["verified", "COMPLETE_VERIFIED"],
    ["unknown", "COMPLETE_UNKNOWN"],
    ["ambiguous", "COMPLETE_AMBIGUOUS"],
  ] as const)("makes %s terminal without LLM routing", (status, expectedAction) => {
    const result = verificationResult(finding(0, 10), status);
    expect(transitionAfterVerification(result)).toEqual({
      type: expectedAction,
      result,
    });
  });

  it.each(["unverified", "not_detected"] as const)(
    "routes %s to the LLM while retaining scanner evidence",
    (status) => {
      const target = finding(0, 10);
      const result = verificationResult(target, status);
      expect(transitionAfterVerification(result)).toEqual({
        type: "INVOKE_LLM",
        finding: target,
        verificationResult: result,
      });
    }
  );

  it("fails closed when a completed result has no verification outcome", () => {
    const result: FindingResult = {
      findingRef: finding(0, 10),
      status: "completed",
      trufflehogResult: "",
    };
    expect(transitionAfterVerification(result)).toMatchObject({
      type: "FAIL_VERIFICATION",
      result: {
        status: "failed",
        error: "missing_or_unrecognized_trufflehog_result",
      },
    });
  });
});

describe("verification-first Hybrid orchestration", () => {
  it("runs TruffleHog before the LLM and never sends verified findings to it", async () => {
    const target = finding(0, 10, 12);
    const events: string[] = [];
    const trufflehogExecFn = vi.fn().mockImplementation(async () => {
      events.push("trufflehog");
      return {
        stdout: JSON.stringify({
          DetectorName: "AWS",
          Verified: true,
          SourceMetadata: { Data: { Filesystem: { line: 11 } } },
        }),
        stderr: "",
      };
    });
    const claudeAnalyzer = {
      analyzeWorkItem: vi.fn().mockImplementation(async () => {
        events.push("llm");
        return [{
          findingRef: target,
          status: "completed",
          llmClassification: "false_positive",
          llmReason: "would incorrectly suppress verified evidence",
          llmConfidence: 1,
        }];
      }),
    } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(workItem([target]), "/tmp/file.js", {
      claudeAnalyzer,
      trufflehogExecFn,
    });

    expect(events).toEqual(["trufflehog"]);
    expect(claudeAnalyzer.analyzeWorkItem).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      status: "completed",
      trufflehogResult: "verified",
      trufflehogDetector: "AWS",
    });
    expect(results[0]!.llmClassification).toBeUndefined();
  });

  it("keeps verifier errors unknown and never translates them into false positives", async () => {
    const target = finding(0, 20);
    const trufflehogExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        DetectorName: "InternalToken",
        Verified: false,
        VerificationError: "internal verifier timed out",
        SourceMetadata: { Data: { Filesystem: { line: 20 } } },
      }),
      stderr: "",
    });
    const claudeAnalyzer = {
      analyzeWorkItem: vi.fn(),
    } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(workItem([target]), "/tmp/file.js", {
      claudeAnalyzer,
      trufflehogExecFn,
    });

    expect(claudeAnalyzer.analyzeWorkItem).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      status: "completed",
      trufflehogResult: "unknown",
      trufflehogDetector: "InternalToken",
    });
  });

  it("sends only unverified and not-detected findings to the LLM", async () => {
    const verified = finding(0, 10);
    const unverified = finding(1, 30);
    const unknown = finding(2, 50);
    const notDetected = finding(3, 70);
    const events: string[] = [];

    const trufflehogExecFn = vi.fn().mockImplementation(async () => {
      events.push("trufflehog");
      return {
        stdout: [
          { DetectorName: "AWS", Verified: true, SourceMetadata: { Data: { Filesystem: { line: 10 } } } },
          { DetectorName: "Slack", Verified: false, SourceMetadata: { Data: { Filesystem: { line: 30 } } } },
          { DetectorName: "Internal", Verified: false, VerificationError: "timeout", SourceMetadata: { Data: { Filesystem: { line: 50 } } } },
        ].map((record) => JSON.stringify(record)).join("\n"),
        stderr: "",
      };
    });

    const analyzeWorkItem = vi.fn().mockImplementation(async (llmWorkItem: FileWorkItem) => {
      events.push("llm");
      expect(llmWorkItem.findings).toEqual([unverified, notDetected]);
      return [
        {
          findingRef: unverified,
          status: "completed",
          llmClassification: "false_positive",
          llmReason: "Known test fixture",
          llmConfidence: 0.98,
          error: "",
        },
        {
          findingRef: notDetected,
          status: "completed",
          llmClassification: "likely_secret",
          llmReason: "Potential detector gap",
          llmConfidence: 0.81,
          error: "",
        },
      ];
    });
    const claudeAnalyzer = { analyzeWorkItem } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(
      workItem([verified, unverified, unknown, notDetected]),
      "/tmp/file.js",
      { claudeAnalyzer, trufflehogExecFn }
    );

    expect(events).toEqual(["trufflehog", "llm"]);
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ trufflehogResult: "verified" });
    expect(results[0]!.llmClassification).toBeUndefined();
    expect(results[1]).toMatchObject({
      trufflehogResult: "unverified",
      trufflehogDetector: "Slack",
      llmClassification: "false_positive",
    });
    expect(results[2]).toMatchObject({ trufflehogResult: "unknown" });
    expect(results[2]!.llmClassification).toBeUndefined();
    expect(results[3]).toMatchObject({
      trufflehogResult: "not_detected",
      llmClassification: "likely_secret",
    });
  });

  it("keeps ambiguous correlation terminal and out of the LLM", async () => {
    const target = finding(0, 10);
    const trufflehogExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ DetectorName: "AWS", Verified: true }),
      stderr: "",
    });
    const claudeAnalyzer = { analyzeWorkItem: vi.fn() } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(workItem([target]), "/tmp/file.js", {
      claudeAnalyzer,
      trufflehogExecFn,
    });

    expect(claudeAnalyzer.analyzeWorkItem).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      trufflehogResult: "ambiguous",
      error: "TruffleHog detection is missing source location metadata",
    });
  });

  it("fails verification closed and does not call the LLM", async () => {
    const findings = [finding(0, 10), finding(1, 20)];
    const trufflehogExecFn = vi.fn().mockRejectedValue(new Error("scanner unavailable"));
    const claudeAnalyzer = { analyzeWorkItem: vi.fn() } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(workItem(findings), "/tmp/file.js", {
      claudeAnalyzer,
      trufflehogExecFn,
    });

    expect(claudeAnalyzer.analyzeWorkItem).not.toHaveBeenCalled();
    expect(results.map((result) => result.status)).toEqual(["failed", "failed"]);
    expect(results.every((result) => result.error?.includes("scanner unavailable"))).toBe(true);
  });

  it("preserves scanner evidence when LLM analysis fails", async () => {
    const target = finding(0, 10);
    const trufflehogExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const claudeAnalyzer = {
      analyzeWorkItem: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
    } as unknown as ClaudeAnalyzer;

    const results = await executeHybridFlow(workItem([target]), "/tmp/file.js", {
      claudeAnalyzer,
      trufflehogExecFn,
    });

    expect(results[0]).toMatchObject({
      status: "completed",
      trufflehogResult: "not_detected",
      llmClassification: "uncertain",
      error: "ai_gateway_error",
    });
  });

  it("keeps unresolved scanner evidence reviewable when contextual classification is disabled", async () => {
    const target = finding(0, 10);
    const trufflehogExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const results = await executeHybridFlow(workItem([target]), "/tmp/file.js", {
      trufflehogExecFn,
    });

    expect(results[0]).toMatchObject({
      status: "completed",
      trufflehogResult: "not_detected",
      llmClassification: "uncertain",
      llmReason: "Context classifier is disabled; manual review required",
    });
  });
});
