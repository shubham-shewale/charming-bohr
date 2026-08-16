import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parse } from "csv-parse/sync";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";
import type { AnthropicClientLike } from "../llm/analyzer.js";

describe("End-to-End Hybrid Pipeline Integration Test", () => {
  let tmpDir: string;

  const mockConfig: AppConfig = {
    flow: "hybrid",
    anthropicApiKey: "test-anthropic-key",
    anthropicModel: "claude-3-haiku-20240307",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 5,
    githubPat: "test-github-pat",
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 2,
    cleanupTempFiles: true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-hybrid-integration-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mock LLM returns false_positive -> assert TruffleHog NOT called and status=completed", async () => {
    const inputCsv = path.join(tmpDir, "input.csv");
    const outputCsv = path.join(tmpDir, "output.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link,Severity
rule-mock-data,https://github.com/my-org/my-repo/blob/${sha}/src/test.js#L5-L10,low
`;
    fs.writeFileSync(inputCsv, csvContent);

    const mockFetchProvider = vi.fn().mockResolvedValue(`// Line 1
// Line 2
// Line 3
// Line 4
const DUMMY_API_KEY = "test_key_mock_12345";
// Line 6
// Line 7
// Line 8
`);

    const mockAnthropicClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "false_positive",
                    confidence: 0.99,
                    reason: "Obvious dummy test key in test file",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 150, output_tokens: 50 },
        }),
      },
    };

    const mockTruffleHogExec = vi.fn();

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider: mockFetchProvider,
      anthropicClient: mockAnthropicClient,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.falsePositive).toBe(1);
    expect(summary.likelySecret).toBe(0);
    expect(summary.uncertain).toBe(0);
    expect(summary.verified).toBe(0);
    expect(summary.failed).toBe(0);

    // TruffleHog must NOT be called for false_positive
    expect(mockTruffleHogExec).not.toHaveBeenCalled();

    // Verify CSV output
    const writtenRaw = fs.readFileSync(outputCsv, "utf-8");
    const records = parse(writtenRaw, { columns: true });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "Rule ID": "rule-mock-data",
      status: "completed",
      llm_classification: "false_positive",
      llm_reason: "Obvious dummy test key in test file",
      llm_confidence: "0.99",
      trufflehog_result: "",
      trufflehog_detector: "",
      error: "",
    });
  });

  it("mock LLM returns uncertain -> assert TruffleHog IS called and both columns populated", async () => {
    const inputCsv = path.join(tmpDir, "input.csv");
    const outputCsv = path.join(tmpDir, "output.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link,Severity
rule-generic-token,https://github.com/my-org/my-repo/blob/${sha}/src/auth.js#L10-L15,high
`;
    fs.writeFileSync(inputCsv, csvContent);

    const mockFetchProvider = vi.fn().mockResolvedValue(`// Line 1-9
const TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"; // line 12
// Line 13-30
`);

    const mockAnthropicClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "uncertain",
                    confidence: 0.6,
                    reason: "Need verification by scanner",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 180, output_tokens: 60 },
        }),
      },
    };

    const mockTruffleHogExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        DetectorName: "GitHub",
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

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider: mockFetchProvider,
      anthropicClient: mockAnthropicClient,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.uncertain).toBe(1);
    expect(summary.verified).toBe(1);

    // TruffleHog MUST be called for uncertain
    expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);

    // Verify CSV output
    const writtenRaw = fs.readFileSync(outputCsv, "utf-8");
    const records = parse(writtenRaw, { columns: true });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "Rule ID": "rule-generic-token",
      status: "completed",
      llm_classification: "uncertain",
      llm_reason: "Need verification by scanner",
      llm_confidence: "0.6",
      trufflehog_result: "verified",
      trufflehog_detector: "GitHub",
      error: "",
    });
  });

  it("handles mixed findings in same file: some false_positive, some uncertain, some likely_secret, some failed", async () => {
    const inputCsv = path.join(tmpDir, "input.csv");
    const outputCsv = path.join(tmpDir, "output.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link
rule-fp,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L5-L10
rule-unc,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L20-L25
rule-likely,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L40-L45
rule-malformed,https://github.com/my-org/my-repo/blob/${sha}/src/app.js#L60-L65
`;
    fs.writeFileSync(inputCsv, csvContent);

    const mockFetchProvider = vi.fn().mockResolvedValue(`// 1-4
const FP = "test-placeholder"; // 5
// 6-19
const UNC = "custom-auth-token"; // 22
// 23-39
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // 42
// 43-59
const MAL = "some-key"; // 62
// 63-70
`);

    // Mock Anthropic client returning classifications for indices 0, 1, 2 only (3 is omitted -> partial failure)
    const mockAnthropicClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classifications: [
                  {
                    findingIndex: 0,
                    classification: "false_positive",
                    confidence: 0.98,
                    reason: "Known test placeholder string",
                  },
                  {
                    findingIndex: 1,
                    classification: "uncertain",
                    confidence: 0.55,
                    reason: "Custom auth header format unknown",
                  },
                  {
                    findingIndex: 2,
                    classification: "likely_secret",
                    confidence: 0.99,
                    reason: "AWS access key structure",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 120 },
        }),
      },
    };

    // TruffleHog detects AWS key on line 42 as unverified
    const mockTruffleHogExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        DetectorName: "AWS",
        Verified: false,
        SourceMetadata: {
          Data: {
            Filesystem: {
              line: 42,
            },
          },
        },
      }),
      stderr: "",
    });

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider: mockFetchProvider,
      anthropicClient: mockAnthropicClient,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(4);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.falsePositive).toBe(1);
    expect(summary.uncertain).toBe(1);
    expect(summary.likelySecret).toBe(1);
    expect(summary.unverified).toBe(1);
    expect(summary.notFound).toBe(1);
    expect(summary.llmInvalidOutput).toBe(1);

    // TruffleHog was invoked once for this file (because rule-unc and rule-likely needed it)
    expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);

    // Verify CSV records
    const writtenRaw = fs.readFileSync(outputCsv, "utf-8");
    const records = parse(writtenRaw, { columns: true });

    expect(records).toHaveLength(4);

    // Row 0: false_positive
    expect(records[0]).toMatchObject({
      "Rule ID": "rule-fp",
      status: "completed",
      llm_classification: "false_positive",
      llm_reason: "Known test placeholder string",
      llm_confidence: "0.98",
      trufflehog_result: "",
      trufflehog_detector: "",
      error: "",
    });

    // Row 1: uncertain -> TruffleHog found nothing -> not_found
    expect(records[1]).toMatchObject({
      "Rule ID": "rule-unc",
      status: "completed",
      llm_classification: "uncertain",
      llm_reason: "Custom auth header format unknown",
      llm_confidence: "0.55",
      trufflehog_result: "not_found",
      trufflehog_detector: "",
      error: "",
    });

    // Row 2: likely_secret -> TruffleHog found unverified AWS key
    expect(records[2]).toMatchObject({
      "Rule ID": "rule-likely",
      status: "completed",
      llm_classification: "likely_secret",
      llm_reason: "AWS access key structure",
      llm_confidence: "0.99",
      trufflehog_result: "unverified",
      trufflehog_detector: "AWS",
      error: "",
    });

    // Row 3: failed LLM parse -> failed, llm_invalid_output, no TruffleHog
    expect(records[3]).toMatchObject({
      "Rule ID": "rule-malformed",
      status: "failed",
      llm_classification: "llm_invalid_output",
      trufflehog_result: "",
      trufflehog_detector: "",
      error: "llm_invalid_output",
    });
  });

  it("selectively invokes TruffleHog across multiple files only for files with uncertain/likely_secret findings", async () => {
    const inputCsv = path.join(tmpDir, "multi_file.csv");
    const outputCsv = path.join(tmpDir, "multi_file_out.csv");
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

    const csvContent = `Rule ID,SCM Link
rule-fp-only,https://github.com/my-org/my-repo/blob/${sha}/src/fp-file.js#L5-L10
rule-secret,https://github.com/my-org/my-repo/blob/${sha}/src/secret-file.js#L15-L20
`;
    fs.writeFileSync(inputCsv, csvContent);

    const mockFetchProvider = vi.fn().mockImplementation(async (source) => {
      if (source.filePath.includes("fp-file")) {
        return "const x = 'safe_mock_data';\n";
      }
      return "const SECRET = 'ghp_secret12345';\n";
    });

    const mockAnthropicClient: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockImplementation(async (params) => {
          const contentStr = params.messages[0]?.content || "";
          if (contentStr.includes("fp-file.js")) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    classifications: [
                      {
                        findingIndex: 0,
                        classification: "false_positive",
                        confidence: 0.99,
                        reason: "Safe fixture",
                      },
                    ],
                  }),
                },
              ],
              usage: { input_tokens: 100, output_tokens: 30 },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  classifications: [
                    {
                      findingIndex: 0,
                      classification: "likely_secret",
                      confidence: 0.95,
                      reason: "GitHub personal token pattern",
                    },
                  ],
                }),
              },
            ],
            usage: { input_tokens: 100, output_tokens: 30 },
          };
        }),
      },
    };

    const scannedFiles: string[] = [];
    const mockTruffleHogExec = vi.fn().mockImplementation(async (cmd, args) => {
      const fileArg = args[args.indexOf("--file") + 1];
      scannedFiles.push(fileArg);
      return {
        stdout: JSON.stringify({
          DetectorName: "GitHub",
          Verified: true,
          SourceMetadata: {
            Data: {
              Filesystem: {
                line: 18,
              },
            },
          },
        }),
        stderr: "",
      };
    });

    const summary = await runPipeline([inputCsv], {
      config: mockConfig,
      output: outputCsv,
      fetchProvider: mockFetchProvider,
      anthropicClient: mockAnthropicClient,
      trufflehogExecFn: mockTruffleHogExec,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.falsePositive).toBe(1);
    expect(summary.likelySecret).toBe(1);
    expect(summary.verified).toBe(1);

    // TruffleHog should have been called ONLY once across all files (for secret-file.js, NOT for fp-file.js)
    expect(mockTruffleHogExec).toHaveBeenCalledTimes(1);
    expect(scannedFiles).toHaveLength(1);
    expect(scannedFiles[0]).toContain("secret-file.js");
  });
});
