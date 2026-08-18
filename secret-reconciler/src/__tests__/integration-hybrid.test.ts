import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { AnthropicClientLike } from "../llm/analyzer.js";
import { runPipeline } from "../pipeline.js";

describe("End-to-End verification-first Hybrid Pipeline", () => {
  let tmpDir: string;

  const config: AppConfig = {
    flow: "hybrid",
    anthropicApiKey: "test-anthropic-key",
    anthropicModel: "claude-3-haiku-20240307",
    maxTokensPerRequest: 1000,
    maxLlmCallsPerFile: 5,
    githubPats: ["test-github-pat"],
    concurrency: 2,
    maxFileSizeKb: 500,
    surroundingLines: 2,
    cleanupTempFiles: true,
    trufflehogVerificationMode: "all",
    trufflehogTimeoutSeconds: 60,
    githubRateLimitMaxRetries: 2,
  };

  const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-reconciler-hybrid-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const paths = (name: string) => ({
    input: path.join(tmpDir, `${name}-input.csv`),
    output: path.join(tmpDir, `${name}-output.csv`),
  });

  const readOutput = (output: string): Record<string, string>[] =>
    parse(fs.readFileSync(output, "utf8"), { columns: true });

  it("lets verified evidence win and never calls the LLM", async () => {
    const { input, output } = paths("verified");
    fs.writeFileSync(
      input,
      `Rule ID,SCM Link\nrule-aws,https://github.com/org/repo/blob/${sha}/src/app.js#L10\n`
    );

    const create = vi.fn().mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          classifications: [{
            findingIndex: 0,
            classification: "false_positive",
            confidence: 1,
            reason: "would be unsafe if it overrode verification",
          }],
        }),
      }],
    });
    const anthropicClient: AnthropicClientLike = { messages: { create } };
    const trufflehogExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        DetectorName: "AWS",
        Verified: true,
        SourceMetadata: { Data: { Filesystem: { line: 10 } } },
      }),
      stderr: "",
    });

    const summary = await runPipeline([input], {
      config,
      output,
      tempDir: path.join(tmpDir, "files"),
      fetchProvider: async () => "const key = 'candidate';\n",
      anthropicClient,
      trufflehogExecFn,
    });

    expect(trufflehogExecFn).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ completed: 1, verified: 1, falsePositive: 0 });
    expect(readOutput(output)[0]).toMatchObject({
      trufflehog_result: "verified",
      trufflehog_detector: "AWS",
      llm_classification: "",
      error: "",
    });
  });

  it("invokes the LLM after a clean not-detected verification result", async () => {
    const { input, output } = paths("not-detected");
    fs.writeFileSync(
      input,
      `Rule ID,SCM Link\nrule-fixture,https://github.com/org/repo/blob/${sha}/test/fixture.js#L5\n`
    );

    const callOrder: string[] = [];
    const trufflehogExecFn = vi.fn().mockImplementation(async () => {
      callOrder.push("trufflehog");
      return { stdout: "", stderr: "" };
    });
    const create = vi.fn().mockImplementation(async () => {
      callOrder.push("llm");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            classifications: [{
              findingIndex: 0,
              classification: "false_positive",
              confidence: 0.99,
              reason: "Test fixture placeholder",
            }],
          }),
        }],
        usage: { input_tokens: 100, output_tokens: 25 },
      };
    });

    const summary = await runPipeline([input], {
      config,
      output,
      tempDir: path.join(tmpDir, "files"),
      fetchProvider: async () => "const token = 'test-placeholder';\n",
      anthropicClient: { messages: { create } },
      trufflehogExecFn,
    });

    expect(callOrder).toEqual(["trufflehog", "llm"]);
    expect(summary).toMatchObject({ completed: 1, notDetected: 1, falsePositive: 1 });
    expect(readOutput(output)[0]).toMatchObject({
      trufflehog_result: "not_detected",
      llm_classification: "false_positive",
      llm_reason: "Test fixture placeholder",
      error: "",
    });
  });

  it("keeps verification network failures unknown and bypasses the LLM", async () => {
    const { input, output } = paths("unknown");
    fs.writeFileSync(
      input,
      `Rule ID,SCM Link\nrule-internal,https://github.com/org/repo/blob/${sha}/src/internal.js#L15\n`
    );

    const create = vi.fn();
    const summary = await runPipeline([input], {
      config,
      output,
      tempDir: path.join(tmpDir, "files"),
      fetchProvider: async () => "const token = 'internal';\n",
      anthropicClient: { messages: { create } },
      trufflehogExecFn: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          DetectorName: "InternalToken",
          Verified: false,
          VerificationError: "verifier endpoint timed out",
          SourceMetadata: { Data: { Filesystem: { line: 15 } } },
        }),
        stderr: "",
      }),
    });

    expect(create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ completed: 1, unknown: 1, falsePositive: 0 });
    expect(readOutput(output)[0]).toMatchObject({
      trufflehog_result: "unknown",
      trufflehog_detector: "InternalToken",
      llm_classification: "",
    });
  });

  it("routes only unverified and not-detected findings from a mixed file to the LLM", async () => {
    const { input, output } = paths("mixed");
    fs.writeFileSync(
      input,
      `Rule ID,SCM Link
rule-verified,https://github.com/org/repo/blob/${sha}/src/app.js#L10
rule-unverified,https://github.com/org/repo/blob/${sha}/src/app.js#L30
rule-unknown,https://github.com/org/repo/blob/${sha}/src/app.js#L50
rule-gap,https://github.com/org/repo/blob/${sha}/src/app.js#L70
`
    );

    const trufflehogExecFn = vi.fn().mockResolvedValue({
      stdout: [
        { DetectorName: "AWS", Verified: true, SourceMetadata: { Data: { Filesystem: { line: 10 } } } },
        { DetectorName: "Slack", Verified: false, SourceMetadata: { Data: { Filesystem: { line: 30 } } } },
        { DetectorName: "Internal", Verified: false, VerificationError: "timeout", SourceMetadata: { Data: { Filesystem: { line: 50 } } } },
      ].map((record) => JSON.stringify(record)).join("\n"),
      stderr: "",
    });

    const create = vi.fn().mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          classifications: [
            { findingIndex: 0, classification: "false_positive", confidence: 0.97, reason: "Fixture" },
            { findingIndex: 1, classification: "likely_secret", confidence: 0.85, reason: "Detector gap" },
          ],
        }),
      }],
      usage: { input_tokens: 200, output_tokens: 50 },
    });

    const summary = await runPipeline([input], {
      config,
      output,
      tempDir: path.join(tmpDir, "files"),
      fetchProvider: async () => "// source context\n",
      anthropicClient: { messages: { create } },
      trufflehogExecFn,
    });

    expect(trufflehogExecFn).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      completed: 4,
      verified: 1,
      unverified: 1,
      unknown: 1,
      notDetected: 1,
      falsePositive: 1,
      likelySecret: 1,
    });

    const records = readOutput(output);
    expect(records[0]).toMatchObject({ trufflehog_result: "verified", llm_classification: "" });
    expect(records[1]).toMatchObject({ trufflehog_result: "unverified", llm_classification: "false_positive" });
    expect(records[2]).toMatchObject({ trufflehog_result: "unknown", llm_classification: "" });
    expect(records[3]).toMatchObject({ trufflehog_result: "not_detected", llm_classification: "likely_secret" });
  });

  it("propagates TruffleHog runtime options before LLM fallback", async () => {
    const { input, output } = paths("options");
    fs.writeFileSync(
      input,
      `Rule ID,SCM Link\nrule-token,https://github.com/org/repo/blob/${sha}/src/auth.js#L10\n`
    );

    let capturedArgs: string[] = [];
    let capturedTimeout: number | undefined;
    const trufflehogExecFn = vi.fn().mockImplementation(async (_cmd, args, options) => {
      capturedArgs = args;
      capturedTimeout = options.timeout;
      return {
        stdout: JSON.stringify({
          DetectorName: "AuthToken",
          Verified: false,
          SourceMetadata: { Data: { Filesystem: { line: 10 } } },
        }),
        stderr: "",
      };
    });
    const create = vi.fn().mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          classifications: [{
            findingIndex: 0,
            classification: "uncertain",
            confidence: 0.5,
            reason: "Needs review",
          }],
        }),
      }],
    });

    const summary = await runPipeline([input], {
      config: {
        ...config,
        trufflehogVerificationMode: "no-verification",
        trufflehogUserAgentSuffix: "SecurityTeamAudit-2026",
        trufflehogTimeoutSeconds: 90,
      },
      output,
      tempDir: path.join(tmpDir, "files"),
      fetchProvider: async () => "const token = 'candidate';\n",
      anthropicClient: { messages: { create } },
      trufflehogExecFn,
    });

    expect(capturedArgs).toEqual([
      "filesystem",
      expect.stringContaining("auth.js"),
      "--json",
      "--results=verified,unverified,unknown",
      "--no-update",
      "--fail-on-scan-errors",
      "--no-verification",
      "--user-agent-suffix=SecurityTeamAudit-2026",
    ]);
    expect(capturedTimeout).toBe(90000);
    expect(summary).toMatchObject({ completed: 1, unverified: 1, uncertain: 1 });
  });
});
