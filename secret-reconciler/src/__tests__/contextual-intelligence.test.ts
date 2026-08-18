import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { ContextualSecretAnalyzer } from "../llm/analyzer.js";
import { redactSensitiveContent } from "../llm/redactor.js";
import { executeHybridFlow } from "../hybrid/state-machine.js";
import type { AiGatewayClientLike, AiGatewayRequest } from "../ai-gateway/types.js";
import type { FileWorkItem, FindingRef, FindingResult } from "../types.js";

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    flow: "hybrid",
    aiGatewayUrl: "https://gateway.internal",
    aiGatewayModel: "security-context-v1",
    aiGatewayAuthToken: "test-token",
    aiGatewayTimeoutSeconds: 30,
    llmContextClassifierEnabled: true,
    llmDetectorAdvisorEnabled: true,
    llmMaxContextExpansions: 2,
    llmMaxContextLines: 20,
    maxTokensPerRequest: 2000,
    maxLlmCallsPerFile: 5,
    githubPats: ["test-pat"],
    concurrency: 1,
    maxFileSizeKb: 500,
    surroundingLines: 3,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
    ...overrides,
  };
}

function finding(): FindingRef {
  return {
    rowIndex: 0,
    sourceFile: "input.csv",
    checkId: "CKV_SECRET_INTERNAL",
    rawRow: { "Check ID": "CKV_SECRET_INTERNAL" },
    initialStatus: "pending",
    canonicalSource: {
      provider: "github",
      org: "payments",
      repo: "platform",
      revision: SHA,
      filePath: "deploy/prod/kubernetes/payment-api/secret.yaml",
      lineStart: 8,
      lineEnd: 8,
    },
  };
}

function workItem(target: FindingRef): FileWorkItem {
  return {
    contentIdentity: `github::payments/platform::${SHA}::deploy/prod/kubernetes/payment-api/secret.yaml`,
    provider: "github",
    org: "payments",
    repo: "platform",
    revision: SHA,
    filePath: "deploy/prod/kubernetes/payment-api/secret.yaml",
    findings: [target],
  };
}

function contextualAssessment(overrides: Record<string, unknown> = {}) {
  return {
    findingIndex: 0,
    classification: "probable_secret",
    fileRole: "deployment_manifest",
    environment: "production",
    exposureScope: "internal",
    principalScope: "service_account",
    secretKind: "database_credential",
    evidenceStrength: "strong",
    confidence: 0.94,
    evidence: [
      { source: "path", description: "production deployment path" },
      { source: "content", description: "database password and internal host", line: 8 },
    ],
    benignSignals: [],
    riskSignals: ["credential-bearing field", "production deployment"],
    missingEvidence: ["live credential verification"],
    reason: "The redacted value is assigned to a production database password field.",
    ...overrides,
  };
}

describe("contextual secret intelligence", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contextual-intelligence-"));
    filePath = path.join(tmpDir, "secret.yaml");
    fs.writeFileSync(filePath, `apiVersion: v1
kind: Secret
metadata:
  name: payment-db
  namespace: payments-prod
database:
  host: payments-db.internal
  password: prod-secret-value-that-must-never-leave
serviceAccountName: payment-api
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redacts private keys without shifting source line numbers", () => {
    const source = `line one
-----BEGIN PRIVATE KEY-----
private-key-material
-----END PRIVATE KEY-----
line five`;
    const redacted = redactSensitiveContent(source);

    expect(redacted.split("\n")).toHaveLength(source.split("\n").length);
    expect(redacted).not.toContain("private-key-material");
    expect(redacted.split("\n")[4]).toBe("line five");
  });

  it("classifies not-detected secret-like context and produces a review-only detector proposal", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [{
          id: "context-final",
          name: "submit_context_assessments",
          arguments: { assessments: [contextualAssessment()] },
        }],
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      .mockResolvedValueOnce({
        toolCalls: [{
          id: "detector-final",
          name: "submit_detector_gap_assessments",
          arguments: {
            assessments: [{
              findingIndex: 0,
              status: "new_detector_candidate",
              proposedName: "InternalPaymentDatabasePassword",
              keywords: ["password", "payments-db"],
              secretShape: "non-placeholder scalar assigned to a database password key",
              regexTemplate: "(?i)password\\s*[:=]\\s*[A-Za-z0-9_-]{20,}",
              verificationApproach: "Review an internal verifier endpoint before implementation",
              exclusionSuggestions: ["exclude test and example paths"],
              evidence: ["TruffleHog returned not_detected", "production database context"],
              reason: "The contextual classifier found probable credential material that was not detected.",
            }],
          },
        }],
      });
    const client: AiGatewayClientLike = { complete };
    const target = finding();
    const verificationResult: FindingResult = {
      findingRef: target,
      status: "completed",
      trufflehogResult: "not_detected",
      trufflehogDetector: "",
      error: "",
    };
    const analyzer = new ContextualSecretAnalyzer({
      config: config(),
      aiGatewayClient: client,
    });

    const results = await analyzer.analyzeWorkItem(workItem(target), filePath, {
      verificationResults: new Map([[target, verificationResult]]),
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(complete.mock.calls[0]![0])).not.toContain(
      "prod-secret-value-that-must-never-leave"
    );
    expect(results[0]).toMatchObject({
      status: "completed",
      llmClassification: "probable_secret",
      detectorGapAssessment: {
        status: "new_detector_candidate",
        proposedName: "InternalPaymentDatabasePassword",
      },
    });
    expect(results[0]!.trufflehogResult).toBeUndefined();
  });

  it("merges contextual classification without replacing not-detected scanner evidence", async () => {
    const complete = vi.fn().mockResolvedValue({
      toolCalls: [{
        id: "context-final",
        name: "submit_context_assessments",
        arguments: { assessments: [contextualAssessment()] },
      }],
    });
    const target = finding();
    const analyzer = new ContextualSecretAnalyzer({
      config: config({ llmDetectorAdvisorEnabled: false }),
      aiGatewayClient: { complete },
    });

    const results = await executeHybridFlow(workItem(target), filePath, {
      contextualAnalyzer: analyzer,
      trufflehogExecFn: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    });

    expect(results[0]).toMatchObject({
      status: "completed",
      trufflehogResult: "not_detected",
      llmClassification: "probable_secret",
      contextAssessment: {
        fileRole: "deployment_manifest",
        environment: "production",
      },
    });
  });

  it("does not invoke the detector advisor for an existing unverified detection", async () => {
    const complete = vi.fn().mockResolvedValue({
      toolCalls: [{
        id: "context-final",
        name: "submit_context_assessments",
        arguments: { assessments: [contextualAssessment()] },
      }],
    });
    const target = finding();
    const analyzer = new ContextualSecretAnalyzer({
      config: config(),
      aiGatewayClient: { complete },
    });

    const results = await analyzer.analyzeWorkItem(workItem(target), filePath, {
      verificationResults: new Map([[target, {
        findingRef: target,
        status: "completed",
        trufflehogResult: "unverified",
        trufflehogDetector: "Generic",
      }]]),
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(results[0]!.detectorGapAssessment).toBeUndefined();
  });

  it("caps path-only confidence and refuses path-only exposure or principal claims", async () => {
    const complete = vi.fn().mockResolvedValue({
      toolCalls: [{
        id: "context-final",
        name: "submit_context_assessments",
        arguments: {
          assessments: [contextualAssessment({
            exposureScope: "internet_facing",
            principalScope: "human_user",
            evidenceStrength: "strong",
            confidence: 0.99,
            evidence: [{ source: "path", description: "path contains prod and public" }],
          })],
        },
      }],
    });
    const target = finding();
    const analyzer = new ContextualSecretAnalyzer({
      config: config({ llmDetectorAdvisorEnabled: false }),
      aiGatewayClient: { complete },
    });
    const results = await analyzer.analyzeWorkItem(workItem(target), filePath);

    expect(results[0]!.contextAssessment).toMatchObject({
      confidence: 0.6,
      evidenceStrength: "weak",
      exposureScope: "unknown",
      principalScope: "unknown",
    });
  });

  it("serves only bounded redacted context through the context expansion tool", async () => {
    let secondRequest: AiGatewayRequest | undefined;
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [{
          id: "context-read",
          name: "get_additional_file_context",
          arguments: { findingIndex: 0, startLine: 1, endLine: 500, reason: "inspect file structure" },
        }],
      })
      .mockImplementationOnce(async (request: AiGatewayRequest) => {
        secondRequest = request;
        return {
          toolCalls: [{
            id: "context-final",
            name: "submit_context_assessments",
            arguments: { assessments: [contextualAssessment()] },
          }],
        };
      });
    const target = finding();
    const analyzer = new ContextualSecretAnalyzer({
      config: config({ llmMaxContextLines: 3, llmDetectorAdvisorEnabled: false }),
      aiGatewayClient: { complete },
    });

    await analyzer.analyzeWorkItem(workItem(target), filePath);

    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain('"truncated":true');
    expect(toolMessage?.content).not.toContain("prod-secret-value-that-must-never-leave");
    expect((toolMessage?.content.match(/\\n/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("turns malformed gateway output into an uncertain review result", async () => {
    const analyzer = new ContextualSecretAnalyzer({
      config: config({ llmDetectorAdvisorEnabled: false }),
      aiGatewayClient: { complete: vi.fn().mockResolvedValue({ toolCalls: [] }) },
    });

    const results = await analyzer.analyzeWorkItem(workItem(finding()), filePath);
    expect(results[0]).toMatchObject({
      status: "completed",
      llmClassification: "uncertain",
      error: "llm_invalid_output",
    });
  });

  it("turns gateway failures into uncertain review without claiming validity", async () => {
    const analyzer = new ContextualSecretAnalyzer({
      config: config({ llmDetectorAdvisorEnabled: false }),
      aiGatewayClient: {
        complete: vi.fn().mockRejectedValue(new Error("gateway timeout")),
      },
    });

    const results = await analyzer.analyzeWorkItem(workItem(finding()), filePath);
    expect(results[0]).toMatchObject({
      status: "completed",
      llmClassification: "uncertain",
      llmConfidence: 0,
      error: "ai_gateway_error",
    });
    expect(results[0]!.llmReason).not.toMatch(/expired|rotated|verified/i);
  });

  it("drops detector regex proposals that use constructs unsupported by Go RE2", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [{
          id: "context-final",
          name: "submit_context_assessments",
          arguments: { assessments: [contextualAssessment()] },
        }],
      })
      .mockResolvedValueOnce({
        toolCalls: [{
          id: "detector-final",
          name: "submit_detector_gap_assessments",
          arguments: {
            assessments: [{
              findingIndex: 0,
              status: "new_detector_candidate",
              keywords: ["password"],
              regexTemplate: "(?<=password=)[A-Za-z0-9]+",
              exclusionSuggestions: [],
              evidence: ["not detected"],
              reason: "Candidate pattern",
            }],
          },
        }],
      });
    const target = finding();
    const analyzer = new ContextualSecretAnalyzer({
      config: config(),
      aiGatewayClient: { complete },
    });
    const results = await analyzer.analyzeWorkItem(workItem(target), filePath, {
      verificationResults: new Map([[target, {
        findingRef: target,
        status: "completed",
        trufflehogResult: "not_detected",
      }]]),
    });

    expect(results[0]!.detectorGapAssessment?.status).toBe("new_detector_candidate");
    expect(results[0]!.detectorGapAssessment?.regexTemplate).toBeUndefined();
  });
});
