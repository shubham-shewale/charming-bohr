import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPipeline } from "../pipeline.js";
import { loadConfig } from "../config.js";
import type { CanonicalSource } from "../types.js";

describe("Azure DevOps Pipeline Support", () => {
  const tmpDir = path.join(process.cwd(), "tmp_test_azure");
  const inputFile = path.join(tmpDir, "input_azure.csv");
  const outputFile = path.join(tmpDir, "output_azure.csv");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Write test input CSV with Azure DevOps link
    fs.writeFileSync(
      inputFile,
      `scmlink,trufflehog_result\nhttps://dev.azure.com/org1/proj1/_git/repo1?path=/azure.txt&version=GC0123456789abcdef0123456789abcdef01234567&_a=contents&line=2&lineEnd=3,`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should process Azure DevOps SCM links and route appropriately", async () => {
    // Setup minimal config
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

    let fetchedSource: CanonicalSource | null = null;

    const mockFetchProvider = async (source: CanonicalSource) => {
      fetchedSource = source;
      return "line 1\nline 2: secret\nline 3: also secret\nline 4";
    };

    const mockTruffleHog = async (localPath: string) => {
      return { stdout: "", stderr: "" }; // returning empty trufflehog json output to mark not_found
    };

    const summary = await runPipeline([inputFile], {
      config,
      output: outputFile,
      fetchProvider: mockFetchProvider,
      trufflehogExecFn: mockTruffleHog,
    });

    expect(summary.totalFindings).toBe(1);
    console.log(summary.results[0]);
    expect(summary.results[0]?.status).toBe("completed");
    expect(fetchedSource).not.toBeNull();
    if (fetchedSource) {
      expect(fetchedSource.provider).toBe("azure-devops");
      expect(fetchedSource.org).toBe("org1");
      expect(fetchedSource.project).toBe("proj1");
      expect(fetchedSource.repo).toBe("repo1");
      expect(fetchedSource.revision).toBe("0123456789abcdef0123456789abcdef01234567");
      expect(fetchedSource.filePath).toBe("azure.txt");
    }
  });
});
