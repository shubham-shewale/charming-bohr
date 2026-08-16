import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPipeline } from "../pipeline.js";
import { loadConfig } from "../config.js";

describe("Azure DevOps Pipeline Integration Test", () => {
  const tmpDir = path.join(process.cwd(), "tmp_test_azure");
  const inputFile = path.join(tmpDir, "input_azure.csv");
  const outputFile = path.join(tmpDir, "output_azure.csv");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Write test input CSV with Azure DevOps link
    fs.writeFileSync(
      inputFile,
      `Rule ID,SCM Link,Severity\nrule-azure,https://dev.azure.com/my-org/my-project/_git/my-repo?path=/src/secret.py&version=GC0123456789abcdef0123456789abcdef01234567&_a=contents&line=10&lineEnd=12,high\n`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("processes Azure DevOps findings through mocked Azure REST API and TruffleHog to output CSV", async () => {
    process.env.FLOW = "trufflehog-only";
    process.env.ANTHROPIC_API_KEY = "dummy-anthropic-key";
    process.env.ANTHROPIC_MODEL = "claude-3-5-sonnet";
    process.env.MAX_TOKENS_PER_REQUEST = "1000";
    process.env.MAX_LLM_CALLS_PER_FILE = "1";
    process.env.GITHUB_PAT = "test-github-pat";
    process.env.AZURE_DEVOPS_PAT = "test-azure-pat";
    process.env.CONCURRENCY = "1";
    process.env.MAX_FILE_SIZE_KB = "100";
    process.env.SURROUNDING_LINES = "5";
    process.env.CLEANUP_TEMP_FILES = "true";

    const config = loadConfig();

    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;

    // Mock global fetch to intercept Azure DevOps Items REST API
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      capturedUrl = input.toString();
      const headers = init?.headers as Record<string, string>;
      capturedAuth = headers?.["Authorization"];

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => `
# line 1 to 9
SECRET_API_KEY = "azure-mock-secret-key" # line 10
# line 11 to 20
`,
      } as unknown as Response;
    });

    const mockTruffleHog = async () => {
      return {
        stdout: JSON.stringify({
          DetectorName: "AzureKey",
          Verified: true,
          SourceMetadata: { Data: { Filesystem: { line: 10 } } },
        }) + "\n",
        stderr: "",
      };
    };

    const summary = await runPipeline([inputFile], {
      config,
      output: outputFile,
      trufflehogExecFn: mockTruffleHog,
    });

    expect(summary.totalFindings).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.verified).toBe(1);
    expect(summary.results[0]?.status).toBe("completed");
    expect(summary.results[0]?.trufflehogResult).toBe("verified");
    expect(summary.results[0]?.trufflehogDetector).toBe("AzureKey");

    // Verify correct Azure DevOps Items REST API URL and PAT auth header
    expect(capturedUrl).toBe(
      "https://dev.azure.com/my-org/my-project/_apis/git/repositories/my-repo/items?path=src%2Fsecret.py&versionDescriptor.version=0123456789abcdef0123456789abcdef01234567&versionDescriptor.versionType=commit&api-version=7.0"
    );
    const expectedBasicAuth = `Basic ${Buffer.from(":test-azure-pat").toString("base64")}`;
    expect(capturedAuth).toBe(expectedBasicAuth);

    // Verify written output CSV
    expect(fs.existsSync(outputFile)).toBe(true);
    const outputContent = fs.readFileSync(outputFile, "utf-8");
    expect(outputContent).toContain("rule-azure");
    expect(outputContent).toContain("verified");
    expect(outputContent).toContain("AzureKey");
  });
});
