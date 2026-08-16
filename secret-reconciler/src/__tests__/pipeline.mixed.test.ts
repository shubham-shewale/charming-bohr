import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runPipeline } from "../pipeline.js";
import { loadConfig } from "../config.js";

describe("Mixed Pipeline Support (GitHub + Azure DevOps)", () => {
  const tmpDir = path.join(process.cwd(), "tmp_test_mixed");
  const inputFile = path.join(tmpDir, "input_mixed.csv");
  const outputFile = path.join(tmpDir, "output_mixed.csv");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Write test input CSV with both GitHub and Azure DevOps links
    fs.writeFileSync(
      inputFile,
      `Rule ID,SCM Link,Severity\nrule-gh,https://github.com/org1/repo1/blob/0123456789abcdef0123456789abcdef01234567/github.txt#L1-L2,high\nrule-az,https://dev.azure.com/org2/proj2/_git/repo2?path=/azure.txt&version=GCabcdefabcdefabcdefabcdefabcdefabcdefabcd&_a=contents&line=2&lineEnd=3,low\n`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("processes both GitHub and Azure DevOps findings in a single run, calling both providers with correct PATs", async () => {
    process.env.FLOW = "trufflehog-only";
    process.env.ANTHROPIC_API_KEY = "dummy-anthropic-key";
    process.env.ANTHROPIC_MODEL = "claude-3-5-sonnet";
    process.env.MAX_TOKENS_PER_REQUEST = "1000";
    process.env.MAX_LLM_CALLS_PER_FILE = "1";
    process.env.GITHUB_PAT = "secret-github-pat";
    process.env.AZURE_DEVOPS_PAT = "secret-azure-pat";
    process.env.CONCURRENCY = "2";
    process.env.MAX_FILE_SIZE_KB = "100";
    process.env.SURROUNDING_LINES = "5";
    process.env.CLEANUP_TEMP_FILES = "true";

    const config = loadConfig();

    const interceptedCalls: { url: string; auth: string | undefined }[] = [];

    // Mock global fetch to handle both GitHub and Azure DevOps API endpoints
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = input.toString();
      const headers = init?.headers as Record<string, string>;
      const auth = headers?.["Authorization"];
      interceptedCalls.push({ url, auth });

      if (url.includes("api.github.com")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "github file content line 1\ngithub file content line 2\n",
        } as unknown as Response;
      } else if (url.includes("dev.azure.com")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "azure file content line 1\nazure file content line 2\nazure file content line 3\n",
        } as unknown as Response;
      }

      throw new Error(`Unexpected URL in fetch mock: ${url}`);
    });

    const mockTruffleHog = async () => ({ stdout: "", stderr: "" });

    const summary = await runPipeline([inputFile], {
      config,
      output: outputFile,
      trufflehogExecFn: mockTruffleHog,
    });

    expect(summary.totalFindings).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.results[0]?.status).toBe("completed");
    expect(summary.results[1]?.status).toBe("completed");

    // Verify GitHub provider was called with Bearer GITHUB_PAT
    const ghCall = interceptedCalls.find((c) => c.url.includes("api.github.com"));
    expect(ghCall).toBeDefined();
    expect(ghCall?.auth).toBe("Bearer secret-github-pat");
    expect(ghCall?.url).toContain("https://api.github.com/repos/org1/repo1/contents/github.txt?ref=0123456789abcdef0123456789abcdef01234567");

    // Verify Azure DevOps provider was called with Basic AZURE_DEVOPS_PAT
    const azCall = interceptedCalls.find((c) => c.url.includes("dev.azure.com"));
    expect(azCall).toBeDefined();
    const expectedAzBasic = `Basic ${Buffer.from(":secret-azure-pat").toString("base64")}`;
    expect(azCall?.auth).toBe(expectedBasicAuth(expectedAzBasic));
    expect(azCall?.url).toContain("https://dev.azure.com/org2/proj2/_apis/git/repositories/repo2/items");

    function expectedBasicAuth(expected: string) {
      return expected;
    }

    // Verify output CSV has both rows
    expect(fs.existsSync(outputFile)).toBe(true);
    const outputContent = fs.readFileSync(outputFile, "utf-8");
    expect(outputContent).toContain("rule-gh");
    expect(outputContent).toContain("rule-az");
  });
});
