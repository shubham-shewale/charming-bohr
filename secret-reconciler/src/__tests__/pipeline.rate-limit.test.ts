import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPipeline } from "../pipeline.js";
import type { AppConfig } from "../config.js";
import { GitHubRateLimitError } from "../providers/github-provider.js";
import type { CanonicalSource } from "../types.js";

// ── Shared test config ────────────────────────────────────────────────────────

const baseConfig: AppConfig = {
  flow: "trufflehog-only",
  anthropicApiKey: "dummy",
  anthropicModel: "claude-3-5-sonnet",
  maxTokensPerRequest: 1000,
  maxLlmCallsPerFile: 1,
  githubPats: ["ghp_token1"],
  concurrency: 1,
  maxFileSizeKb: 500,
  surroundingLines: 5,
  cleanupTempFiles: true,
  trufflehogVerificationMode: "all",
  trufflehogTimeoutSeconds: 60,
  githubRateLimitMaxRetries: 2,
};

const mockTruffleHog = async () => ({ stdout: "", stderr: "" });

// ── Test setup ────────────────────────────────────────────────────────────────

describe("Pipeline — GitHub Rate-Limit Deferral", () => {
  const tmpDir = path.join(process.cwd(), "tmp_test_ratelimit");
  const outputFile = path.join(tmpDir, "output.csv");

  // One GitHub SCM link
  const ghSha = "1111111111111111111111111111111111111111";
  const ghCsvRow = `https://github.com/org1/repo1/blob/${ghSha}/src/file.ts#L1-L2`;

  // One Azure SCM link
  const azSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const azCsvRow = `https://dev.azure.com/org2/proj2/_git/repo2?path=/azure.ts&version=GC${azSha}&_a=contents&line=1&lineEnd=2`;

  function writeInputCsv(rows: string[]): string {
    const p = path.join(tmpDir, `input_${Date.now()}.csv`);
    const lines = ["Rule ID,SCM Link", ...rows.map((link, i) => `rule-${i},${link}`)];
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");
    return p;
  }

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000 * 1000));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Slice 1: retried item succeeds ───────────────────────────────────────

  it("defers a GitHub item on GitHubRateLimitError and retries it successfully", async () => {
    const inputFile = writeInputCsv([ghCsvRow]);
    let callCount = 0;
    const futureReset = 1700000000 + 3600;

    const fetchProvider = async (source: CanonicalSource) => {
      callCount++;
      if (callCount === 1) {
        // First call: simulate rate limit
        throw new GitHubRateLimitError(futureReset, 0);
      }
      // Second call (after retry): succeed
      return "file content";
    };

    const summary = await runPipeline([inputFile], {
      config: { ...baseConfig, githubRateLimitMaxRetries: 1 },
      output: outputFile,
      fetchProvider,
      trufflehogExecFn: mockTruffleHog,
      sleepFn: async (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(callCount).toBe(2);
  });

  // ── Slice 2: max retries exhausted → item marked failed ──────────────────

  it("marks GitHub item failed after exhausting max retries", async () => {
    const inputFile = writeInputCsv([ghCsvRow]);
    const futureReset = 1700000000 + 3600;

    const fetchProvider = async (_source: CanonicalSource) => {
      // Always throw rate limit error
      throw new GitHubRateLimitError(futureReset, 0);
    };

    const progress: Array<{ filesProcessed: number; findingsFailed: number }> = [];
    const summary = await runPipeline([inputFile], {
      config: { ...baseConfig, githubRateLimitMaxRetries: 2 },
      output: outputFile,
      fetchProvider,
      trufflehogExecFn: mockTruffleHog,
      sleepFn: async (ms) => {
        vi.advanceTimersByTime(ms);
      },
      onProgress: (item) => progress.push(item),
    });

    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.results[0]?.error).toMatch(/rate limit/i);
    expect(progress.at(-1)).toMatchObject({ filesProcessed: 1, findingsFailed: 1 });
  });

  // ── Slice 3: Azure items complete normally when GitHub is rate-limited ───

  it("Azure items complete in the main pass even when GitHub items are deferred", async () => {
    // One GitHub + one Azure row
    const inputFile = writeInputCsv([ghCsvRow, azCsvRow]);
    const futureReset = 1700000000 + 3600;

    const fetchProvider = async (source: CanonicalSource) => {
      if (source.provider === "github") {
        throw new GitHubRateLimitError(futureReset, 0);
      }
      // Azure succeeds immediately
      return "azure file content";
    };

    const summary = await runPipeline([inputFile], {
      config: { ...baseConfig, githubRateLimitMaxRetries: 0 },
      output: outputFile,
      fetchProvider,
      trufflehogExecFn: mockTruffleHog,
      sleepFn: async (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });

    // Azure item should complete, GitHub item should fail (0 retries)
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);

    const azResult = summary.results.find((r) => r.findingRef.canonicalSource?.provider === "azure");
    const ghResult = summary.results.find((r) => r.findingRef.canonicalSource?.provider === "github");
    expect(azResult?.status).toBe("completed");
    expect(ghResult?.status).toBe("failed");
  });

  // ── Slice 4: isBlocked flag skips further GitHub calls without network ───

  it("skips subsequent GitHub items immediately when pool is blocked (no extra fetch calls)", async () => {
    // Two GitHub items pointing to DIFFERENT files (so deduplication doesn't apply)
    const sha2 = "2222222222222222222222222222222222222222";
    const ghCsvRow2 = `https://github.com/org1/repo1/blob/${sha2}/src/other.ts#L1-L2`;

    const inputFile = writeInputCsv([ghCsvRow, ghCsvRow2]);
    const futureReset = 1700000000 + 3600;

    let fetchCallCount = 0;
    const fetchProvider = async (_source: CanonicalSource) => {
      fetchCallCount++;
      // Always throw rate limit error
      throw new GitHubRateLimitError(futureReset, 0);
    };

    const summary = await runPipeline([inputFile], {
      config: {
        ...baseConfig,
        githubRateLimitMaxRetries: 0,
        concurrency: 1, // serial so first blocks second
      },
      output: outputFile,
      fetchProvider,
      trufflehogExecFn: mockTruffleHog,
      sleepFn: async (ms) => {
        vi.advanceTimersByTime(ms);
      },
    });

    expect(summary.failed).toBe(2);
    // With concurrency=1 and isBlocked flag, only 1 actual network call is made
    // (the second item is deferred immediately by the isBlocked pre-check)
    expect(fetchCallCount).toBe(1);
  });
});
