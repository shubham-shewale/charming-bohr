import { describe, it, expect, vi } from "vitest";
import {
  transitionAfterLlm,
  executeHybridFlow,
} from "../hybrid/state-machine.js";
import type {
  FindingRef,
  FindingResult,
  FileWorkItem,
} from "../types.js";
import type { ClaudeAnalyzer } from "../llm/analyzer.js";

describe("Hybrid State Machine & Flow", () => {
  const createMockFindingRef = (rowIndex: number, lineStart = 10, lineEnd = 20): FindingRef => ({
    rowIndex,
    sourceFile: "findings.csv",
    rawRow: {
      "Rule ID": `rule-${rowIndex}`,
      "SCM Link": `https://github.com/my-org/my-repo/blob/1234567890abcdef1234567890abcdef12345678/src/index.js#L${lineStart}-L${lineEnd}`,
    },
    canonicalSource: {
      provider: "github",
      org: "my-org",
      repo: "my-repo",
      revision: "1234567890abcdef1234567890abcdef12345678",
      filePath: "src/index.js",
      lineStart,
      lineEnd,
    },
    initialStatus: "pending",
  });

  describe("transitionAfterLlm pure transitions", () => {
    it("returns COMPLETE_NO_TRUFFLEHOG for false_positive classification", () => {
      const finding = createMockFindingRef(0);
      const llmResult: FindingResult = {
        findingRef: finding,
        status: "completed",
        llmClassification: "false_positive",
        llmReason: "Dummy test string",
        llmConfidence: 0.99,
        error: "",
      };

      const transition = transitionAfterLlm(llmResult);

      expect(transition.type).toBe("COMPLETE_NO_TRUFFLEHOG");
      if (transition.type === "COMPLETE_NO_TRUFFLEHOG") {
        expect(transition.result.status).toBe("completed");
        expect(transition.result.llmClassification).toBe("false_positive");
        expect(transition.result.trufflehogResult).toBe("");
        expect(transition.result.trufflehogDetector).toBe("");
      }
    });

    it("returns INVOKE_TRUFFLEHOG for likely_secret classification", () => {
      const finding = createMockFindingRef(1);
      const llmResult: FindingResult = {
        findingRef: finding,
        status: "completed",
        llmClassification: "likely_secret",
        llmReason: "Appears to be a real AWS secret key",
        llmConfidence: 0.9,
        error: "",
      };

      const transition = transitionAfterLlm(llmResult);

      expect(transition.type).toBe("INVOKE_TRUFFLEHOG");
      if (transition.type === "INVOKE_TRUFFLEHOG") {
        expect(transition.finding).toBe(finding);
        expect(transition.llmResult).toBe(llmResult);
      }
    });

    it("returns INVOKE_TRUFFLEHOG for uncertain classification", () => {
      const finding = createMockFindingRef(2);
      const llmResult: FindingResult = {
        findingRef: finding,
        status: "completed",
        llmClassification: "uncertain",
        llmReason: "Context is ambiguous",
        llmConfidence: 0.5,
        error: "",
      };

      const transition = transitionAfterLlm(llmResult);

      expect(transition.type).toBe("INVOKE_TRUFFLEHOG");
      if (transition.type === "INVOKE_TRUFFLEHOG") {
        expect(transition.finding).toBe(finding);
        expect(transition.llmResult).toBe(llmResult);
      }
    });

    it("returns FAIL_NO_TRUFFLEHOG when LLM analysis failed", () => {
      const finding = createMockFindingRef(3);
      const llmResult: FindingResult = {
        findingRef: finding,
        status: "failed",
        error: "llm_invalid_output",
        llmReason: "Malformed LLM response",
      };

      const transition = transitionAfterLlm(llmResult);

      expect(transition.type).toBe("FAIL_NO_TRUFFLEHOG");
      if (transition.type === "FAIL_NO_TRUFFLEHOG") {
        expect(transition.result.status).toBe("failed");
        expect(transition.result.error).toBe("llm_invalid_output");
        expect(transition.result.trufflehogResult).toBe("");
      }
    });

    it("returns SKIP_NO_TRUFFLEHOG when finding was skipped", () => {
      const finding = createMockFindingRef(4);
      const llmResult: FindingResult = {
        findingRef: finding,
        status: "skipped",
        error: "Invalid SCM link",
      };

      const transition = transitionAfterLlm(llmResult);

      expect(transition.type).toBe("SKIP_NO_TRUFFLEHOG");
      if (transition.type === "SKIP_NO_TRUFFLEHOG") {
        expect(transition.result.status).toBe("skipped");
        expect(transition.result.error).toBe("Invalid SCM link");
      }
    });
  });

  describe("executeHybridFlow orchestration", () => {
    it("does NOT invoke TruffleHog when all findings are false_positive", async () => {
      const finding1 = createMockFindingRef(0, 10, 15);
      const finding2 = createMockFindingRef(1, 20, 25);

      const workItem: FileWorkItem = {
        contentIdentity: "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "1234567890abcdef1234567890abcdef12345678",
        filePath: "src/index.js",
        findings: [finding1, finding2],
      };

      const mockClaudeAnalyzer = {
        analyzeWorkItem: vi.fn().mockResolvedValue([
          {
            findingRef: finding1,
            status: "completed",
            llmClassification: "false_positive",
            llmReason: "Mock string",
            llmConfidence: 0.98,
            error: "",
          },
          {
            findingRef: finding2,
            status: "completed",
            llmClassification: "false_positive",
            llmReason: "Unit test value",
            llmConfidence: 0.95,
            error: "",
          },
        ]),
      } as unknown as ClaudeAnalyzer;

      const mockTruffleHogExec = vi.fn();

      const results = await executeHybridFlow(workItem, "/path/to/file.js", {
        claudeAnalyzer: mockClaudeAnalyzer,
        trufflehogExecFn: mockTruffleHogExec,
      });

      expect(mockClaudeAnalyzer.analyzeWorkItem).toHaveBeenCalledTimes(1);
      expect(mockTruffleHogExec).not.toHaveBeenCalled();

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        status: "completed",
        llmClassification: "false_positive",
        trufflehogResult: "",
        trufflehogDetector: "",
      });
      expect(results[1]).toMatchObject({
        status: "completed",
        llmClassification: "false_positive",
        trufflehogResult: "",
        trufflehogDetector: "",
      });
    });

    it("invokes TruffleHog when findings are uncertain or likely_secret and populates both result columns", async () => {
      const finding1 = createMockFindingRef(0, 10, 20);
      const finding2 = createMockFindingRef(1, 50, 60);

      const workItem: FileWorkItem = {
        contentIdentity: "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "1234567890abcdef1234567890abcdef12345678",
        filePath: "src/index.js",
        findings: [finding1, finding2],
      };

      const mockClaudeAnalyzer = {
        analyzeWorkItem: vi.fn().mockResolvedValue([
          {
            findingRef: finding1,
            status: "completed",
            llmClassification: "likely_secret",
            llmReason: "Looks like API key",
            llmConfidence: 0.9,
            error: "",
          },
          {
            findingRef: finding2,
            status: "completed",
            llmClassification: "uncertain",
            llmReason: "Hard to tell without runtime values",
            llmConfidence: 0.5,
            error: "",
          },
        ]),
      } as unknown as ClaudeAnalyzer;

      const mockTruffleHogExec = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          DetectorName: "Slack",
          Verified: true,
          SourceMetadata: {
            Data: {
              Filesystem: {
                line: 12,
              },
            },
          },
        }),
        stderr: "",
      });

      const results = await executeHybridFlow(workItem, "/path/to/file.js", {
        claudeAnalyzer: mockClaudeAnalyzer,
        trufflehogExecFn: mockTruffleHogExec,
      });

      expect(mockClaudeAnalyzer.analyzeWorkItem).toHaveBeenCalledTimes(1);
      expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);

      expect(results).toHaveLength(2);

      // finding1 was matched to detector
      expect(results[0]).toMatchObject({
        findingRef: finding1,
        status: "completed",
        llmClassification: "likely_secret",
        llmReason: "Looks like API key",
        llmConfidence: 0.9,
        trufflehogResult: "verified",
        trufflehogDetector: "Slack",
      });

      // finding2 was not matched to any detection in lines 50-60
      expect(results[1]).toMatchObject({
        findingRef: finding2,
        status: "completed",
        llmClassification: "uncertain",
        llmReason: "Hard to tell without runtime values",
        llmConfidence: 0.5,
        trufflehogResult: "not_detected",
        trufflehogDetector: "",
      });
    });

    it("handles mixed findings in same file: only routes likely_secret/uncertain to TruffleHog and skips failed LLM findings", async () => {
      const fFalsePos = createMockFindingRef(0, 5, 10);
      const fUncertain = createMockFindingRef(1, 20, 30);
      const fLikelySec = createMockFindingRef(2, 40, 50);
      const fFailed = createMockFindingRef(3, 60, 70);

      const workItem: FileWorkItem = {
        contentIdentity: "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "1234567890abcdef1234567890abcdef12345678",
        filePath: "src/index.js",
        findings: [fFalsePos, fUncertain, fLikelySec, fFailed],
      };

      const mockClaudeAnalyzer = {
        analyzeWorkItem: vi.fn().mockResolvedValue([
          {
            findingRef: fFalsePos,
            status: "completed",
            llmClassification: "false_positive",
            llmReason: "Test fixture",
            llmConfidence: 0.99,
            error: "",
          },
          {
            findingRef: fUncertain,
            status: "completed",
            llmClassification: "uncertain",
            llmReason: "Unsure",
            llmConfidence: 0.6,
            error: "",
          },
          {
            findingRef: fLikelySec,
            status: "completed",
            llmClassification: "likely_secret",
            llmReason: "AWS token",
            llmConfidence: 0.95,
            error: "",
          },
          {
            findingRef: fFailed,
            status: "failed",
            error: "llm_invalid_output",
            llmReason: "LLM parse error",
          },
        ]),
      } as unknown as ClaudeAnalyzer;

      const mockTruffleHogExec = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          DetectorName: "AWS",
          Verified: false,
          SourceMetadata: {
            Data: {
              Filesystem: {
                line: 45,
              },
            },
          },
        }),
        stderr: "",
      });

      const results = await executeHybridFlow(workItem, "/path/to/file.js", {
        claudeAnalyzer: mockClaudeAnalyzer,
        trufflehogExecFn: mockTruffleHogExec,
      });

      expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);

      expect(results).toHaveLength(4);

      // 1. False positive -> completed, no TruffleHog columns
      expect(results[0]).toMatchObject({
        findingRef: fFalsePos,
        status: "completed",
        llmClassification: "false_positive",
        trufflehogResult: "",
        trufflehogDetector: "",
        error: "",
      });

      // 2. Uncertain -> completed, TruffleHog not_detected
      expect(results[1]).toMatchObject({
        findingRef: fUncertain,
        status: "completed",
        llmClassification: "uncertain",
        trufflehogResult: "not_detected",
        trufflehogDetector: "",
        error: "",
      });

      // 3. Likely secret -> completed, TruffleHog unverified (AWS)
      expect(results[2]).toMatchObject({
        findingRef: fLikelySec,
        status: "completed",
        llmClassification: "likely_secret",
        trufflehogResult: "unverified",
        trufflehogDetector: "AWS",
        error: "",
      });

      // 4. Failed LLM -> failed, error=llm_invalid_output, no TruffleHog
      expect(results[3]).toMatchObject({
        findingRef: fFailed,
        status: "failed",
        error: "llm_invalid_output",
        trufflehogResult: "",
        trufflehogDetector: "",
      });
    });

    it("handles TruffleHog execution failure gracefully without corrupting false_positive findings", async () => {
      const fFalsePos = createMockFindingRef(0, 5, 10);
      const fLikelySec = createMockFindingRef(1, 20, 30);

      const workItem: FileWorkItem = {
        contentIdentity: "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "1234567890abcdef1234567890abcdef12345678",
        filePath: "src/index.js",
        findings: [fFalsePos, fLikelySec],
      };

      const mockClaudeAnalyzer = {
        analyzeWorkItem: vi.fn().mockResolvedValue([
          {
            findingRef: fFalsePos,
            status: "completed",
            llmClassification: "false_positive",
            llmReason: "Safe string",
            llmConfidence: 0.99,
            error: "",
          },
          {
            findingRef: fLikelySec,
            status: "completed",
            llmClassification: "likely_secret",
            llmReason: "Looks real",
            llmConfidence: 0.92,
            error: "",
          },
        ]),
      } as unknown as ClaudeAnalyzer;

      const mockTruffleHogExec = vi.fn().mockRejectedValue(new Error("TruffleHog process crashed"));

      const results = await executeHybridFlow(workItem, "/path/to/file.js", {
        claudeAnalyzer: mockClaudeAnalyzer,
        trufflehogExecFn: mockTruffleHogExec,
      });

      expect(results).toHaveLength(2);

      // fFalsePos is still completed
      expect(results[0]).toMatchObject({
        findingRef: fFalsePos,
        status: "completed",
        llmClassification: "false_positive",
        trufflehogResult: "",
      });

      // fLikelySec is marked failed with error message
      expect(results[1]).toMatchObject({
        findingRef: fLikelySec,
        status: "failed",
        llmClassification: "likely_secret",
        error: "TruffleHog execution failed: TruffleHog process crashed",
      });
    });

    it("propagates TruffleHog options (verificationMode, userAgentSuffix, timeoutMs) when TruffleHog is triggered", async () => {
      const fLikelySec = createMockFindingRef(0, 10, 20);

      const workItem: FileWorkItem = {
        contentIdentity: "github::my-org/my-repo::1234567890abcdef1234567890abcdef12345678::src/index.js",
        provider: "github",
        org: "my-org",
        repo: "my-repo",
        revision: "1234567890abcdef1234567890abcdef12345678",
        filePath: "src/index.js",
        findings: [fLikelySec],
      };

      const mockClaudeAnalyzer = {
        analyzeWorkItem: vi.fn().mockResolvedValue([
          {
            findingRef: fLikelySec,
            status: "completed",
            llmClassification: "likely_secret",
            llmReason: "Looks like an API key",
            llmConfidence: 0.95,
            error: "",
          },
        ]),
      } as unknown as ClaudeAnalyzer;

      let capturedArgs: string[] = [];
      let capturedOptions: { timeout?: number } = {};

      const mockTruffleHogExec = vi.fn().mockImplementation(async (_cmd: string, args: string[], opts: { timeout?: number }) => {
        capturedArgs = args;
        capturedOptions = opts;
        return {
          stdout: `{"DetectorName": "SlackWebhook", "Verified": false, "SourceMetadata": {"Data": {"Filesystem": {"line": 15}}}}`,
          stderr: "",
        };
      });

      const results = await executeHybridFlow(workItem, "/path/to/file.js", {
        claudeAnalyzer: mockClaudeAnalyzer,
        trufflehogOptions: {
          execFn: mockTruffleHogExec,
          verificationMode: "no-verification",
          userAgentSuffix: "SecurityTeamAudit-2026",
          timeoutMs: 120000,
        },
      });

      expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);
      expect(capturedArgs).toEqual([
        "filesystem",
        "/path/to/file.js",
        "--json",
        "--results=verified,unverified,unknown",
        "--no-update",
        "--fail-on-scan-errors",
        "--no-verification",
        "--user-agent-suffix=SecurityTeamAudit-2026",
      ]);
      expect(capturedOptions.timeout).toBe(120000);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        findingRef: fLikelySec,
        status: "completed",
        llmClassification: "likely_secret",
        trufflehogResult: "unverified",
        trufflehogDetector: "SlackWebhook",
      });
    });
  });
});
