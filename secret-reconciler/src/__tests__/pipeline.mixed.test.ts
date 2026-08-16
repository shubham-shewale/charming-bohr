import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPipeline } from "../pipeline.js";
import { loadConfig } from "../config.js";
import type { CanonicalSource } from "../types.js";

describe("Mixed Pipeline Support", () => {
  const tmpDir = path.join(process.cwd(), "tmp_test_mixed");
  const inputFile = path.join(tmpDir, "input_mixed.csv");
  const outputFile = path.join(tmpDir, "output_mixed.csv");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Write test input CSV with both GitHub and Azure DevOps links
    fs.writeFileSync(
      inputFile,
      `scmlink,trufflehog_result\nhttps://github.com/org1/repo1/blob/0123456789abcdef0123456789abcdef01234567/github.txt#L1-L2,\nhttps://dev.azure.com/org2/proj2/_git/repo2?path=/azure.txt&version=GCabcdefabcdefabcdefabcdefabcdefabcdefabcd&_a=contents&line=2&lineEnd=3,`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should process both GitHub and Azure DevOps findings correctly", async () => {
    process.env.FLOW = "trufflehog-only";
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.ANTHROPIC_MODEL = "claude-test";
    process.env.MAX_TOKENS_PER_REQUEST = "1000";
    process.env.MAX_LLM_CALLS_PER_FILE = "1";
    process.env.GITHUB_PAT = "test-github";
    process.env.AZURE_DEVOPS_PAT = "test-azure";
    process.env.CONCURRENCY = "1";
    process.env.MAX_FILE_SIZE_KB = "100";
    process.env.SURROUNDING_LINES = "5";
    process.env.CLEANUP_TEMP_FILES = "true";

    const config = loadConfig();

    const fetchSources: CanonicalSource[] = [];

    const mockFetchProvider = async (source: CanonicalSource) => {
      fetchSources.push(source);
      return "dummy content";
    };

    const mockTruffleHog = async () => ({ stdout: "", stderr: "" });

    const summary = await runPipeline([inputFile], {
      config,
      output: outputFile,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHog,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.results[0]?.status).toBe("completed");
    expect(summary.results[1]?.status).toBe("completed");
    
    // Sort so order is deterministic for assertion
    const providers = fetchSources.map(s => s.provider).sort();
    expect(providers).toEqual(["azure-devops", "github"]);
  });
});
